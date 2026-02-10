import EventEmitter from "node:events";
import type { Client } from "discord.js-selfbot-v13";
import { VoiceGateway } from "./VoiceGateway.js";
import { UdpTransport } from "./UdpTransport.js";
import {
    GatewayOpCodes, STREAMS_SIMULCAST, generateStreamKey, parseStreamKey,
    type SupportedVideoCodec, type VideoAttributes,
} from "./constants.js";
import logger from "../utils/logger.js";

/**
 * High-level streamer client that wraps a discord.js-selfbot-v13 Client.
 * Handles voice/stream lifecycle:
 *   joinVoice → createStream → signalVideo → stopStream → leaveVoice
 *
 * Uses `client.on('raw', ...)` to intercept gateway events and
 * `client.ws.broadcast()` to send gateway opcodes — matching the exact
 * mechanism used by discord.js-selfbot-v13.
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
    }

    get client(): Client { return this._client; }
    get voiceGateway(): VoiceGateway | null { return this._voiceGateway; }
    get streamGateway(): VoiceGateway | null { return this._streamGateway; }
    get voiceUdp(): UdpTransport | null { return this._voiceUdp; }
    get streamUdp(): UdpTransport | null { return this._streamUdp; }
    get guildId(): string | null { return this._guildId; }
    get channelId(): string | null { return this._channelId; }

    // ─── Send Gateway Opcode ─────────────────────────────────────────────

    private _sendGateway(op: number, d: unknown): void {
        (this._client.ws as any).broadcast({
            op, d,
        });
    }

    // ─── Join/Leave Voice ────────────────────────────────────────────────

    /**
     * Join a voice channel by sending VOICE_STATE_UPDATE.
     * Listens for VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE gateway events
     * to get session/tokens, then connects the voice WebSocket.
     */
    async joinVoice(guildId: string, channelId: string): Promise<VoiceGateway> {
        if (!this._client.user)
            throw new Error("Client not logged in");

        this._guildId = guildId;
        this._channelId = channelId;
        const userId = this._client.user.id;

        // Create voice gateway
        this._voiceGateway = new VoiceGateway(guildId, userId, channelId);

        const ready = new Promise<void>((resolve, reject) => {
            // When the voice WebSocket gets READY, do UDP discovery + protocol select
            this._voiceGateway!.once("ready", async (params) => {
                try {
                    this._voiceUdp = new UdpTransport(params.address, params.port);
                    const { ip, port } = await this._voiceUdp.discoverIP(params.audioSsrc);
                    await this._voiceGateway!.selectProtocol(ip, port);
                    this._voiceUdp.encryptor = this._voiceGateway!.encryptor;
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });

        // Listen for gateway events via client.on('raw')
        const onVoiceStateUpdate = (packet: any) => {
            if (packet.t !== "VOICE_STATE_UPDATE") return;
            const d = packet.d;
            if (d.user_id !== userId) return;
            this._voiceGateway?.setSession(d.session_id);
        };

        const onVoiceServerUpdate = (packet: any) => {
            if (packet.t !== "VOICE_SERVER_UPDATE") return;
            const d = packet.d;
            if (guildId !== d.guild_id) return;
            if (d.channel_id && channelId !== d.channel_id) return;
            this._voiceGateway?.setTokens(d.endpoint, d.token);
        };

        this._client.on("raw", onVoiceStateUpdate);
        this._client.on("raw", onVoiceServerUpdate);

        // Store listeners for cleanup
        (this as any)._voiceRawListeners = { onVoiceStateUpdate, onVoiceServerUpdate };

        // Send VOICE_STATE_UPDATE to join voice (with self_video: false initially)
        this._sendGateway(GatewayOpCodes.VOICE_STATE_UPDATE, {
            guild_id: guildId,
            channel_id: channelId,
            self_mute: false,
            self_deaf: true,
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

        this._voiceGateway?.stop();
        this._voiceGateway = null;
        this._voiceUdp?.stop();
        this._voiceUdp = null;

        // Send leave opcode
        this._sendGateway(GatewayOpCodes.VOICE_STATE_UPDATE, {
            guild_id: null,
            channel_id: null,
            self_mute: true,
            self_deaf: false,
            self_video: false,
        });

        // Remove raw listeners
        const listeners = (this as any)._voiceRawListeners;
        if (listeners) {
            this._client.off("raw", listeners.onVoiceStateUpdate);
            this._client.off("raw", listeners.onVoiceServerUpdate);
            (this as any)._voiceRawListeners = null;
        }

        this._guildId = null;
        this._channelId = null;
    }

    // ─── Stream (Go Live) ────────────────────────────────────────────────

    /**
     * Create a Go Live stream connection.
     * Returns the stream's UdpTransport ready for sending A/V frames.
     */
    async createStream(videoCodec: SupportedVideoCodec = "H264"): Promise<UdpTransport> {
        if (!this._voiceGateway || !this._guildId || !this._channelId)
            throw new Error("Must join a voice channel first");
        if (!this._client.user)
            throw new Error("Client not logged in");

        const userId = this._client.user.id;
        const guildId = this._guildId;
        const channelId = this._channelId;
        const sessionId = this._voiceGateway.sessionId;

        if (!sessionId)
            throw new Error("Session doesn't exist yet");

        const type = this._voiceGateway.type;
        const streamKey = generateStreamKey(type, guildId, channelId, userId);

        // Create stream gateway
        this._streamGateway = new VoiceGateway(guildId, userId, channelId);

        const ready = new Promise<UdpTransport>((resolve, reject) => {
            this._streamGateway!.once("ready", async (params) => {
                try {
                    this._streamUdp = new UdpTransport(params.address, params.port);
                    const { ip, port } = await this._streamUdp.discoverIP(params.audioSsrc);
                    await this._streamGateway!.selectProtocol(ip, port);
                    this._streamUdp.encryptor = this._streamGateway!.encryptor;
                    this._streamUdp.setupPacketizers(
                        params.audioSsrc, params.videoSsrc, videoCodec,
                    );
                    resolve(this._streamUdp);
                } catch (err) {
                    reject(err);
                }
            });
        });

        // Listen for STREAM_CREATE and STREAM_SERVER_UPDATE gateway events
        const onStreamCreate = (packet: any) => {
            if (packet.t !== "STREAM_CREATE") return;
            const d = packet.d;
            const parsed = parseStreamKey(d.stream_key);
            if (parsed.guildId !== guildId || parsed.channelId !== channelId || parsed.userId !== userId)
                return;
            // Set session from the voice connection's session
            this._streamGateway?.setSession(sessionId);
        };

        const onStreamServerUpdate = (packet: any) => {
            if (packet.t !== "STREAM_SERVER_UPDATE") return;
            const d = packet.d;
            const parsed = parseStreamKey(d.stream_key);
            if (parsed.guildId !== guildId || parsed.channelId !== channelId || parsed.userId !== userId)
                return;
            this._streamGateway?.setTokens(d.endpoint, d.token);
        };

        this._client.on("raw", onStreamCreate);
        this._client.on("raw", onStreamServerUpdate);

        // Store for cleanup
        (this as any)._streamRawListeners = { onStreamCreate, onStreamServerUpdate };

        // Send STREAM_CREATE + STREAM_SET_PAUSED=false
        this._sendGateway(GatewayOpCodes.STREAM_CREATE, {
            type,
            guild_id: guildId,
            channel_id: channelId,
            preferred_region: null,
        });

        this._sendGateway(GatewayOpCodes.STREAM_SET_PAUSED, {
            stream_key: streamKey,
            paused: false,
        });

        const udp = await ready;
        return udp;
    }

    /**
     * Stop the Go Live stream.
     */
    stopStream(): void {
        const stream = this._streamGateway;
        if (!stream) return;

        stream.stop();

        if (this._guildId && this._channelId && this._client.user) {
            const type = this._voiceGateway?.type ?? "guild";
            const streamKey = generateStreamKey(
                type, this._guildId, this._channelId, this._client.user.id,
            );
            this._sendGateway(GatewayOpCodes.STREAM_DELETE, {
                stream_key: streamKey,
            });
        }

        this._streamGateway = null;
        this._streamUdp?.stop();
        this._streamUdp = null;

        // Remove raw listeners
        const listeners = (this as any)._streamRawListeners;
        if (listeners) {
            this._client.off("raw", listeners.onStreamCreate);
            this._client.off("raw", listeners.onStreamServerUpdate);
            (this as any)._streamRawListeners = null;
        }
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
}
