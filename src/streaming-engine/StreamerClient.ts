import EventEmitter from "node:events";
import type { Client, VoiceBasedChannel } from "discord.js-selfbot-v13";
import { VoiceGateway } from "./VoiceGateway.js";
import { UdpTransport } from "./UdpTransport.js";
import {
    GatewayOpCodes, STREAMS_SIMULCAST, generateStreamKey, parseStreamKey,
    type SupportedVideoCodec, type VideoAttributes,
} from "./constants.js";
import logger from "../utils/logger.js";

type GatewayPayload = { op: number; d: unknown; t?: string };

/**
 * High-level streamer client that wraps a discord.js-selfbot-v13 Client.
 * Handles voice/stream lifecycle:
 *   joinVoice → createStream → signalVideo → stopStream → leaveVoice
 */
export class StreamerClient extends EventEmitter {
    private _client: Client;
    private _voiceGateway: VoiceGateway | null = null;
    private _streamGateway: VoiceGateway | null = null;
    private _voiceUdp: UdpTransport | null = null;
    private _streamUdp: UdpTransport | null = null;
    private _guildId: string | null = null;
    private _channelId: string | null = null;

    constructor(client: Client) {
        super();
        this._client = client;
        this._setupGatewayInterception();
    }

    get client(): Client { return this._client; }
    get voiceGateway(): VoiceGateway | null { return this._voiceGateway; }
    get streamGateway(): VoiceGateway | null { return this._streamGateway; }
    get voiceUdp(): UdpTransport | null { return this._voiceUdp; }
    get streamUdp(): UdpTransport | null { return this._streamUdp; }
    get guildId(): string | null { return this._guildId; }
    get channelId(): string | null { return this._channelId; }

    // ─── Gateway Interception ────────────────────────────────────────────────

    /**
     * Intercept VOICE_STATE_UPDATE, VOICE_SERVER_UPDATE, STREAM_CREATE,
     * STREAM_SERVER_UPDATE from the main Discord gateway.
     */
    private _setupGatewayInterception(): void {
        const ws = this._client.ws as any;
        const originalHandler = ws.onPacket?.bind(ws);

        ws.onPacket = (packet: GatewayPayload) => {
            if (packet.t === "VOICE_STATE_UPDATE") {
                const d = packet.d as any;
                if (d.user_id === this._client.user?.id) {
                    this._voiceGateway?.setSession(d.session_id);
                }
            } else if (packet.t === "VOICE_SERVER_UPDATE") {
                const d = packet.d as any;
                if (this._voiceGateway) {
                    this._voiceGateway.setTokens(d.endpoint, d.token);
                }
            } else if (packet.t === "STREAM_CREATE") {
                const d = packet.d as any;
                if (this._streamGateway) {
                    const parsed = parseStreamKey(d.stream_key);
                    this._streamGateway.setSession(
                        this._voiceGateway?.sessionId || "",
                    );
                }
            } else if (packet.t === "STREAM_SERVER_UPDATE") {
                const d = packet.d as any;
                if (this._streamGateway) {
                    this._streamGateway.setTokens(d.endpoint, d.token);
                }
            }

            // Call original handler
            originalHandler?.(packet);
        };
    }

    // ─── Join/Leave Voice ────────────────────────────────────────────────────

    /**
     * Join a voice channel by sending VOICE_STATE_UPDATE.
     * Returns a promise that resolves when the voice connection is ready.
     */
    async joinVoice(guildId: string, channelId: string): Promise<VoiceGateway> {
        this._guildId = guildId;
        this._channelId = channelId;

        // Create voice gateway
        this._voiceGateway = new VoiceGateway(
            guildId, this._client.user!.id, channelId,
        );

        const ready = new Promise<void>((resolve) => {
            this._voiceGateway!.once("ready", async (params) => {
                // Create UDP transport and perform IP discovery
                this._voiceUdp = new UdpTransport(params.address, params.port);
                const { ip, port } = await this._voiceUdp.discoverIP(params.audioSsrc);
                await this._voiceGateway!.selectProtocol(ip, port);
                this._voiceUdp.encryptor = this._voiceGateway!.encryptor;
                resolve();
            });
        });

        // Send gateway opcode
        this._sendGateway(GatewayOpCodes.VOICE_STATE_UPDATE, {
            guild_id: guildId,
            channel_id: channelId,
            self_mute: false,
            self_deaf: false,
            self_video: false,
        });

        await ready;
        return this._voiceGateway;
    }

    /**
     * Leave the voice channel.
     */
    leaveVoice(): void {
        this.stopStream();

        this._sendGateway(GatewayOpCodes.VOICE_STATE_UPDATE, {
            guild_id: null,
            channel_id: null,
            self_mute: false,
            self_deaf: false,
            self_video: false,
        });

        this._voiceGateway?.stop();
        this._voiceGateway = null;
        this._voiceUdp?.stop();
        this._voiceUdp = null;
        this._guildId = null;
        this._channelId = null;
    }

    // ─── Stream (Go Live) ────────────────────────────────────────────────────

    /**
     * Create a Go Live stream connection.
     * Returns the stream's UdpTransport ready for sending A/V frames.
     */
    async createStream(videoCodec: SupportedVideoCodec = "H264"): Promise<UdpTransport> {
        if (!this._voiceGateway || !this._guildId || !this._channelId)
            throw new Error("Must join a voice channel first");

        const streamKey = generateStreamKey(
            "guild", this._guildId, this._channelId, this._client.user!.id,
        );

        // Create new gateway for the stream connection
        this._streamGateway = new VoiceGateway(
            this._guildId,
            this._client.user!.id,
            this._channelId,
        );

        const ready = new Promise<UdpTransport>((resolve) => {
            this._streamGateway!.once("ready", async (params) => {
                this._streamUdp = new UdpTransport(params.address, params.port);
                const { ip, port } = await this._streamUdp.discoverIP(params.audioSsrc);
                await this._streamGateway!.selectProtocol(ip, port);
                this._streamUdp.encryptor = this._streamGateway!.encryptor;
                this._streamUdp.setupPacketizers(
                    params.audioSsrc, params.videoSsrc, videoCodec,
                );
                resolve(this._streamUdp);
            });
        });

        // Send STREAM_CREATE + STREAM_SET_PAUSED=false
        this._sendGateway(GatewayOpCodes.STREAM_CREATE, {
            type: "guild",
            guild_id: this._guildId,
            channel_id: this._channelId,
            preferred_region: null,
        });

        const udp = await ready;

        // Unpause
        this._sendGateway(GatewayOpCodes.STREAM_SET_PAUSED, {
            stream_key: streamKey,
            paused: false,
        });

        return udp;
    }

    /**
     * Stop the Go Live stream.
     */
    stopStream(): void {
        if (!this._streamGateway) return;

        if (this._guildId && this._channelId) {
            const streamKey = generateStreamKey(
                "guild", this._guildId, this._channelId, this._client.user!.id,
            );
            this._sendGateway(GatewayOpCodes.STREAM_DELETE, {
                stream_key: streamKey,
            });
        }

        this._streamGateway.stop();
        this._streamGateway = null;
        this._streamUdp?.stop();
        this._streamUdp = null;
    }

    /**
     * Set video attributes on the stream connection.
     */
    signalVideo(attr: VideoAttributes, enabled = true): void {
        this._streamGateway?.setVideoAttributes(enabled, attr);
    }

    /**
     * Set speaking state on the stream connection.
     */
    setSpeaking(speaking: boolean): void {
        this._streamGateway?.setSpeaking(speaking, true);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private _sendGateway(op: number, d: unknown): void {
        const ws = this._client.ws as any;
        ws.send?.({ op, d }) ?? ws.socket?.send?.(JSON.stringify({ op, d }));
    }
}
