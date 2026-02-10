// ─── Voice WebSocket Op Codes ────────────────────────────────────────────────
export enum VoiceOpCodes {
    IDENTIFY = 0,
    SELECT_PROTOCOL = 1,
    READY = 2,
    HEARTBEAT = 3,
    SELECT_PROTOCOL_ACK = 4,
    SPEAKING = 5,
    HEARTBEAT_ACK = 6,
    RESUME = 7,
    HELLO = 8,
    RESUMED = 9,
    VIDEO = 12,
    CLIENT_DISCONNECT = 13,
    SESSION_UPDATE = 14,
    MEDIA_SINK_WANTS = 15,
    VOICE_BACKEND_VERSION = 16,
    CHANNEL_OPTIONS_UPDATE = 17,
    FLAGS = 18,
    SPEED_TEST = 19,
    PLATFORM = 20,
}

// ─── Main Gateway Op Codes ───────────────────────────────────────────────────
export enum GatewayOpCodes {
    DISPATCH = 0,
    HEARTBEAT = 1,
    IDENTIFY = 2,
    PRESENCE_UPDATE = 3,
    VOICE_STATE_UPDATE = 4,
    VOICE_SERVER_PING = 5,
    RESUME = 6,
    RECONNECT = 7,
    REQUEST_GUILD_MEMBERS = 8,
    INVALID_SESSION = 9,
    HELLO = 10,
    HEARTBEAT_ACK = 11,
    CALL_CONNECT = 13,
    GUILD_SUBSCRIPTIONS = 14,
    LOBBY_CONNECT = 15,
    LOBBY_DISCONNECT = 16,
    LOBBY_VOICE_STATES_UPDATE = 17,
    STREAM_CREATE = 18,
    STREAM_DELETE = 19,
    STREAM_WATCH = 20,
    STREAM_PING = 21,
    STREAM_SET_PAUSED = 22,
}

// ─── Encryption ──────────────────────────────────────────────────────────────
export enum SupportedEncryptionModes {
    AES256 = "aead_aes256_gcm_rtpsize",
    XCHACHA20 = "aead_xchacha20_poly1305_rtpsize",
}

// ─── Codec Payload Types ─────────────────────────────────────────────────────
export const CodecPayloadType = {
    opus: {
        name: "opus", type: "audio" as const, priority: 1000, payload_type: 120,
    },
    H264: {
        name: "H264", type: "video" as const, priority: 1000,
        payload_type: 101, rtx_payload_type: 102, encode: true, decode: true,
    },
    H265: {
        name: "H265", type: "video" as const, priority: 1000,
        payload_type: 103, rtx_payload_type: 104, encode: true, decode: true,
    },
    VP8: {
        name: "VP8", type: "video" as const, priority: 1000,
        payload_type: 105, rtx_payload_type: 106, encode: true, decode: true,
    },
    VP9: {
        name: "VP9", type: "video" as const, priority: 1000,
        payload_type: 107, rtx_payload_type: 108, encode: true, decode: true,
    },
    AV1: {
        name: "AV1", type: "video" as const, priority: 1000,
        payload_type: 109, rtx_payload_type: 110, encode: true, decode: true,
    },
} as const;

// ─── Simulcast ───────────────────────────────────────────────────────────────
export const STREAMS_SIMULCAST = [{ type: "screen", rid: "100", quality: 100 }];

// ─── RTP Constants ───────────────────────────────────────────────────────────
export const MAX_INT16 = 2 ** 16;
export const MAX_INT32 = 2 ** 32;
export const RTP_EXTENSIONS = [{ id: 5, len: 2, val: 0 }];

// ─── Types ───────────────────────────────────────────────────────────────────
export type SupportedVideoCodec = "H264" | "H265" | "VP8" | "VP9" | "AV1";

export type VideoAttributes = {
    width: number;
    height: number;
    fps: number;
};

export type WebRtcParams = {
    address: string;
    port: number;
    audioSsrc: number;
    videoSsrc: number;
    rtxSsrc: number;
    supportedEncryptionModes: SupportedEncryptionModes[];
};

// ─── Utility Functions ───────────────────────────────────────────────────────

export function normalizeVideoCodec(codec: string): SupportedVideoCodec {
    if (/H\.?264|AVC/i.test(codec)) return "H264";
    if (/H\.?265|HEVC/i.test(codec)) return "H265";
    if (/VP8/i.test(codec)) return "VP8";
    if (/VP9/i.test(codec)) return "VP9";
    if (/AV1/i.test(codec)) return "AV1";
    throw new Error(`Unknown codec: ${codec}`);
}

export function parseStreamKey(streamKey: string): {
    type: "guild" | "call";
    channelId: string;
    guildId: string | null;
    userId: string;
} {
    const parts = streamKey.split(":");
    const type = parts.shift();
    if (type !== "guild" && type !== "call")
        throw new Error(`Invalid stream key type: ${type}`);
    if ((type === "guild" && parts.length < 3) || (type === "call" && parts.length < 2))
        throw new Error(`Invalid stream key: ${streamKey}`);

    let guildId: string | null = null;
    if (type === "guild") guildId = parts.shift() ?? null;
    const channelId = parts.shift()!;
    const userId = parts.shift()!;
    return { type, channelId, guildId, userId };
}

export function generateStreamKey(
    type: "guild" | "call",
    guildId: string | null,
    channelId: string,
    userId: string,
): string {
    return `${type}${type === "guild" ? `:${guildId}` : ""}:${channelId}:${userId}`;
}

export function isFiniteNonZero(n: number | undefined): n is number {
    return !!n && Number.isFinite(n);
}
