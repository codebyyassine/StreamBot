import WebSocket from "ws";
import EventEmitter from "node:events";
import {
    VoiceOpCodes, SupportedEncryptionModes, CodecPayloadType,
    STREAMS_SIMULCAST, type WebRtcParams, type VideoAttributes,
} from "./constants.js";
import { AES256Encryptor, ChaCha20Encryptor, type TransportEncryptor } from "./Encryptor.js";
import logger from "../utils/logger.js";

type CodecPayloadValue = typeof CodecPayloadType[keyof typeof CodecPayloadType];

/**
 * Manages a single voice WebSocket connection (v8 protocol).
 * Used for both voice channel connections and stream (Go Live) connections.
 */
export class VoiceGateway extends EventEmitter {
    private _ws: WebSocket | null = null;
    private _heartbeatInterval: NodeJS.Timeout | null = null;
    private _sequenceNumber = -1;
    private _started = false;
    private _resuming = false;
    private _hasSession = false;
    private _hasToken = false;

    // Connection info
    public server: string | null = null;
    public token: string | null = null;
    public sessionId: string | null = null;
    public webRtcParams: WebRtcParams | null = null;
    public encryptor: TransportEncryptor | null = null;
    public forceChacha20 = false;

    // Identity
    public readonly guildId: string | null;
    public readonly channelId: string;
    public readonly botId: string;

    constructor(
        guildId: string | null,
        botId: string,
        channelId: string,
        forceChacha20 = false,
    ) {
        super();
        this.guildId = guildId;
        this.channelId = channelId;
        this.botId = botId;
        this.forceChacha20 = forceChacha20;
    }

    get type(): "guild" | "call" {
        return this.guildId ? "guild" : "call";
    }

    get serverId(): string {
        return this.guildId ?? this.channelId;
    }

    get started(): boolean {
        return this._started;
    }

    // ─── Session / Token ─────────────────────────────────────────────────────

    setSession(sessionId: string): void {
        this.sessionId = sessionId;
        this._hasSession = true;
        this._tryStart();
    }

    setTokens(server: string, token: string): void {
        this.server = server;
        this.token = token;
        this._hasToken = true;
        this._tryStart();
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    private _tryStart(): void {
        if (!this._hasSession || !this._hasToken) return;
        if (this._started) return;
        this._started = true;

        this._ws = new WebSocket(`wss://${this.server}/?v=8`, { followRedirects: true });

        this._ws.on("open", () => {
            if (this._resuming) {
                this._resuming = false;
                this._sendResume();
            } else {
                this._sendIdentify();
            }
        });

        this._ws.on("error", (err) => {
            logger.error("Voice gateway error:", err);
        });

        this._ws.on("close", (code) => {
            const wasStarted = this._started;
            this._started = false;
            const canResume = code === 4015 || code < 4000;
            if (canResume && wasStarted) {
                this._resuming = true;
                this._tryStart();
            }
        });

        this._ws.on("message", (data, isBinary) => {
            if (isBinary) return;
            const msg = JSON.parse(data.toString());
            const { op, d, seq } = msg;
            if (seq) this._sequenceNumber = seq;

            switch (op) {
                case VoiceOpCodes.READY:
                    this._handleReady(d);
                    break;
                case VoiceOpCodes.HELLO:
                    this._setupHeartbeat(d.heartbeat_interval);
                    break;
                case VoiceOpCodes.SELECT_PROTOCOL_ACK:
                    this._handleProtocolAck(d);
                    break;
                case VoiceOpCodes.RESUMED:
                    this._started = true;
                    this.emit("resumed");
                    break;
                case VoiceOpCodes.SPEAKING:
                case VoiceOpCodes.HEARTBEAT_ACK:
                    break;
                default:
                    if (op >= 4000) {
                        logger.error(`Voice gateway error op=${op}:`, d);
                    }
                    break;
            }
        });
    }

    // ─── Ready ───────────────────────────────────────────────────────────────

    private _handleReady(d: any): void {
        const stream = d.streams[0];
        this.webRtcParams = {
            address: d.ip,
            port: d.port,
            audioSsrc: d.ssrc,
            videoSsrc: stream.ssrc,
            rtxSsrc: stream.rtx_ssrc,
            supportedEncryptionModes: d.modes,
        };
        this.emit("ready", this.webRtcParams);
    }

    // ─── Protocol ────────────────────────────────────────────────────────────

    private _handleProtocolAck(d: any): void {
        const secretKey = Buffer.from(d.secret_key);
        if (d.mode === SupportedEncryptionModes.AES256 && !this.forceChacha20) {
            this.encryptor = new AES256Encryptor(secretKey);
        } else {
            this.encryptor = new ChaCha20Encryptor(secretKey);
        }
        this.emit("protocol_ack");
    }

    // ─── Heartbeat ───────────────────────────────────────────────────────────

    private _setupHeartbeat(interval: number): void {
        if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = setInterval(() => {
            this._sendOpcode(VoiceOpCodes.HEARTBEAT, {
                t: Date.now(),
                seq_ack: this._sequenceNumber,
            });
        }, interval);
    }

    // ─── Identify / Resume ───────────────────────────────────────────────────

    private _sendIdentify(): void {
        this._sendOpcode(VoiceOpCodes.IDENTIFY, {
            server_id: this.serverId,
            user_id: this.botId,
            session_id: this.sessionId,
            token: this.token,
            video: true,
            streams: STREAMS_SIMULCAST,
        });
    }

    private _sendResume(): void {
        this._sendOpcode(VoiceOpCodes.RESUME, {
            server_id: this.serverId,
            session_id: this.sessionId,
            token: this.token,
            seq_ack: this._sequenceNumber,
        });
    }

    // ─── Public Protocol APIs ────────────────────────────────────────────────

    /**
     * Select protocol after UDP IP discovery.
     * Returns a promise that resolves when the ack is received.
     */
    selectProtocol(ip: string, port: number): Promise<void> {
        if (!this.webRtcParams)
            throw new Error("WebRTC connection not ready");

        let mode: SupportedEncryptionModes;
        if (
            this.webRtcParams.supportedEncryptionModes.includes(SupportedEncryptionModes.AES256) &&
            !this.forceChacha20
        ) {
            mode = SupportedEncryptionModes.AES256;
        } else {
            mode = SupportedEncryptionModes.XCHACHA20;
        }

        return new Promise((resolve) => {
            this._sendOpcode(VoiceOpCodes.SELECT_PROTOCOL, {
                protocol: "udp",
                codecs: Object.values(CodecPayloadType) as CodecPayloadValue[],
                data: { address: ip, port, mode },
            });
            this.once("protocol_ack", () => resolve());
        });
    }

    /**
     * Set speaking state on the voice connection.
     * speaking: 1 = microphone, 2 = soundshare (for stream connections)
     */
    setSpeaking(speaking: boolean, soundshare = false): void {
        if (!this.webRtcParams)
            throw new Error("WebRTC connection not ready");
        this._sendOpcode(VoiceOpCodes.SPEAKING, {
            delay: 0,
            speaking: speaking ? (soundshare ? 2 : 1) : 0,
            ssrc: this.webRtcParams.audioSsrc,
        });
    }

    /**
     * Update video attributes (resolution + fps).
     */
    setVideoAttributes(enabled: boolean, attr?: VideoAttributes): void {
        if (!this.webRtcParams)
            throw new Error("WebRTC connection not ready");
        const { audioSsrc, videoSsrc, rtxSsrc } = this.webRtcParams;

        if (!enabled) {
            this._sendOpcode(VoiceOpCodes.VIDEO, {
                audio_ssrc: audioSsrc,
                video_ssrc: 0,
                rtx_ssrc: 0,
                streams: [],
            });
        } else {
            if (!attr) throw new Error("Need to specify video attributes");
            this._sendOpcode(VoiceOpCodes.VIDEO, {
                audio_ssrc: audioSsrc,
                video_ssrc: videoSsrc,
                rtx_ssrc: rtxSsrc,
                streams: [{
                    type: "video",
                    rid: "100",
                    ssrc: videoSsrc,
                    active: true,
                    quality: 100,
                    rtx_ssrc: rtxSsrc,
                    max_bitrate: 10000 * 1000,
                    max_framerate: attr.fps,
                    max_resolution: {
                        type: "fixed",
                        width: attr.width,
                        height: attr.height,
                    },
                }],
            });
        }
    }

    // ─── Send / Stop ─────────────────────────────────────────────────────────

    private _sendOpcode(op: number, d: unknown): void {
        this._ws?.send(JSON.stringify({ op, d }));
    }

    stop(): void {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
        this._started = false;
        this._ws?.close();
        this._ws = null;
    }
}
