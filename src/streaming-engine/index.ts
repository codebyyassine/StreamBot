// ─── StreamBot Custom Streaming Engine ───────────────────────────────────────
// Drop-in replacement for @dank074/discord-video-stream

export { StreamerClient } from "./StreamerClient.js";
export { playStream } from "./StreamPlayer.js";
export type { PlayStreamOptions } from "./StreamPlayer.js";
export { prepareStream } from "./FFmpegPipeline.js";
export type { StreamOptions, PreparedStream } from "./FFmpegPipeline.js";
export { demux } from "./Demuxer.js";
export type { DemuxResult, VideoStreamInfo, AudioStreamInfo } from "./Demuxer.js";
export { VoiceGateway } from "./VoiceGateway.js";
export { UdpTransport } from "./UdpTransport.js";
export { VideoMediaStream, AudioMediaStream } from "./MediaStream.js";
export {
    normalizeVideoCodec, parseStreamKey, generateStreamKey,
    SupportedEncryptionModes, GatewayOpCodes, VoiceOpCodes,
    CodecPayloadType, STREAMS_SIMULCAST,
} from "./constants.js";
export type {
    SupportedVideoCodec, VideoAttributes, WebRtcParams,
} from "./constants.js";
