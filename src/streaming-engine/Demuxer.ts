import LibAV, { type CodecParameters } from "@lng2004/libav.js-variant-webcodecs-avf-with-decoders";
import { PassThrough, type Readable } from "node:stream";
import logger from "../utils/logger.js";

// ─── NAL Unit Helpers for Parameter Set Injection ────────────────────────────

const H264_IDR = 5, H264_SPS = 7, H264_PPS = 8;
const H265_IDR_W_RADL = 19, H265_IDR_N_LP = 20;
const H265_VPS = 32, H265_SPS = 33, H265_PPS = 34;

function splitNalu(frame: Buffer): Buffer[] {
    const nalus: Buffer[] = [];
    let offset = 0;
    while (offset < frame.length) {
        const size = frame.readUInt32BE(offset);
        offset += 4;
        nalus.push(frame.subarray(offset, offset + size));
        offset += size;
    }
    return nalus;
}

function mergeNalu(nalus: Buffer[]): Buffer {
    const chunks: Buffer[] = [];
    for (const nalu of nalus) {
        const size = Buffer.allocUnsafe(4);
        size.writeUInt32BE(nalu.length);
        chunks.push(size, nalu);
    }
    return Buffer.concat(chunks);
}

// ─── avcC / hvcC parsers ─────────────────────────────────────────────────────

type H264ParamSets = { sps: Buffer[]; pps: Buffer[] };
type H265ParamSets = { vps: Buffer[]; sps: Buffer[]; pps: Buffer[] };

function parseavcC(input: Buffer): H264ParamSets {
    let buf = input;
    if (buf[0] !== 1) throw new Error("Only configurationVersion 1 is supported");
    buf = buf.subarray(5);

    const sps: Buffer[] = [];
    const pps: Buffer[] = [];

    const spsCount = buf[0] & 0b11111;
    buf = buf.subarray(1);
    for (let i = 0; i < spsCount; i++) {
        const len = buf.readUInt16BE();
        buf = buf.subarray(2);
        sps.push(buf.subarray(0, len));
        buf = buf.subarray(len);
    }

    const ppsCount = buf[0];
    buf = buf.subarray(1);
    for (let i = 0; i < ppsCount; i++) {
        const len = buf.readUInt16BE();
        buf = buf.subarray(2);
        pps.push(buf.subarray(0, len));
        buf = buf.subarray(len);
    }
    return { sps, pps };
}

function parsehvcC(input: Buffer): H265ParamSets {
    let buf = input;
    if (buf[0] !== 1) throw new Error("Only configurationVersion 1 is supported");
    buf = buf.subarray(22);

    const vps: Buffer[] = [];
    const sps: Buffer[] = [];
    const pps: Buffer[] = [];

    const numOfArrays = buf[0];
    buf = buf.subarray(1);
    for (let i = 0; i < numOfArrays; i++) {
        const naluType = buf[0] & 0b111111;
        buf = buf.subarray(1);
        const count = buf.readUInt16BE();
        buf = buf.subarray(2);
        for (let j = 0; j < count; j++) {
            const len = buf.readUInt16BE();
            buf = buf.subarray(2);
            const nalu = buf.subarray(0, len);
            buf = buf.subarray(len);
            if (naluType === H265_VPS) vps.push(nalu);
            else if (naluType === H265_SPS) sps.push(nalu);
            else if (naluType === H265_PPS) pps.push(nalu);
        }
    }
    return { vps, sps, pps };
}

function h264AddParamSets(frame: Buffer, ps: H264ParamSets): Buffer {
    const nalus = splitNalu(frame);
    let isIDR = false, hasSPS = false, hasPPS = false;
    for (const nalu of nalus) {
        const type = nalu[0] & 0x1F;
        if (type === H264_IDR) isIDR = true;
        else if (type === H264_SPS) hasSPS = true;
        else if (type === H264_PPS) hasPPS = true;
    }
    if (!isIDR) return frame;
    const extra: Buffer[] = [];
    if (!hasSPS) extra.push(...ps.sps);
    if (!hasPPS) extra.push(...ps.pps);
    return mergeNalu([...extra, ...nalus]);
}

function h265AddParamSets(frame: Buffer, ps: H265ParamSets): Buffer {
    const nalus = splitNalu(frame);
    let isIDR = false, hasVPS = false, hasSPS = false, hasPPS = false;
    for (const nalu of nalus) {
        const type = (nalu[0] >> 1) & 0x3F;
        if (type === H265_IDR_W_RADL || type === H265_IDR_N_LP) isIDR = true;
        else if (type === H265_VPS) hasVPS = true;
        else if (type === H265_SPS) hasSPS = true;
        else if (type === H265_PPS) hasPPS = true;
    }
    if (!isIDR) return frame;
    const extra: Buffer[] = [];
    if (!hasVPS) extra.push(...ps.vps);
    if (!hasSPS) extra.push(...ps.sps);
    if (!hasPPS) extra.push(...ps.pps);
    return mergeNalu([...extra, ...nalus]);
}

// ─── AVCodecIDs we care about ────────────────────────────────────────────────

const AV_CODEC_ID_H264 = 27;
const AV_CODEC_ID_H265 = 173;
const AV_CODEC_ID_VP8 = 139;
const AV_CODEC_ID_VP9 = 167;
const AV_CODEC_ID_AV1 = 226;
const AV_CODEC_ID_OPUS = 86076;

const allowedVideoCodec = new Set([
    AV_CODEC_ID_H264, AV_CODEC_ID_H265, AV_CODEC_ID_VP8, AV_CODEC_ID_VP9, AV_CODEC_ID_AV1,
]);
const allowedAudioCodec = new Set([AV_CODEC_ID_OPUS]);

// ─── Demuxer Result Types ────────────────────────────────────────────────────

export type VideoStreamInfo = {
    width: number;
    height: number;
    framerate_num: number;
    framerate_den: number;
    codec: number;
    stream: Readable;
};

export type AudioStreamInfo = {
    sample_rate: number;
    codec: number;
    stream: Readable;
};

export type DemuxResult = {
    video?: VideoStreamInfo;
    audio?: AudioStreamInfo;
};

// ─── LibAV singleton ─────────────────────────────────────────────────────────

const idToStream = new Map<string, Readable>();
let uidCounter = 0;
function uid(): string { return `d${++uidCounter}_${Date.now()}`; }

const libavInstance = LibAV.LibAV();
libavInstance.then((libav) => {
    libav.onread = (id: string) => {
        idToStream.get(id)?.resume();
    };
});

// ─── Main Demux Function ────────────────────────────────────────────────────

/**
 * Demux a Matroska stream into separate video and audio packet streams.
 * Each packet is an object with { data: Buffer, pts: number, stream_index: number }.
 */
export async function demux(input: Readable, cancelSignal?: AbortSignal): Promise<DemuxResult> {
    const libav = await libavInstance;
    const filename = uid();
    await libav.mkreaderdev(filename);
    idToStream.set(filename, input);

    const ondata = (chunk: Buffer) => {
        libav.ff_reader_dev_send(filename, chunk);
    };
    const onend = () => {
        libav.ff_reader_dev_send(filename, null as any);
    };
    input.on("data", ondata);
    input.on("end", onend);

    const [fmt_ctx, streams] = await libav.ff_init_demuxer_file(filename, "matroska");
    const pkt = await libav.av_packet_alloc();

    const vPipe = new PassThrough({ objectMode: true, highWaterMark: 128 });
    const aPipe = new PassThrough({ objectMode: true, highWaterMark: 128 });

    const cleanup = () => {
        vPipe.off("drain", readFrame);
        aPipe.off("drain", readFrame);
        input.off("data", ondata);
        input.off("end", onend);
        idToStream.delete(filename);
        libav.avformat_close_input_js(fmt_ctx);
        libav.av_packet_free(pkt);
        libav.unlink(filename);
    };

    const vStream = streams.find((s: any) => s.codec_type === (libav as any).AVMEDIA_TYPE_VIDEO);
    const aStream = streams.find((s: any) => s.codec_type === (libav as any).AVMEDIA_TYPE_AUDIO);

    let vInfo: VideoStreamInfo | undefined;
    let aInfo: AudioStreamInfo | undefined;

    if (vStream) {
        if (!allowedVideoCodec.has(vStream.codec_id)) {
            cleanup();
            throw new Error(`Unsupported video codec ID: ${vStream.codec_id}`);
        }
        const codecpar = await libav.ff_copyout_codecpar(vStream.codecpar);
        let extradata: H264ParamSets | H265ParamSets | undefined;
        if (vStream.codec_id === AV_CODEC_ID_H264 && codecpar.extradata) {
            extradata = parseavcC(Buffer.from(codecpar.extradata));
        } else if (vStream.codec_id === AV_CODEC_ID_H265 && codecpar.extradata) {
            extradata = parsehvcC(Buffer.from(codecpar.extradata));
        }

        vInfo = {
            width: codecpar.width ?? 0,
            height: codecpar.height ?? 0,
            framerate_num: await libav.AVCodecParameters_framerate_num(vStream.codecpar),
            framerate_den: await libav.AVCodecParameters_framerate_den(vStream.codecpar),
            codec: vStream.codec_id,
            stream: vPipe,
        };

        // Store extradata on the info object for parameter set injection
        (vInfo as any)._extradata = extradata;
        (vInfo as any)._codec_id = vStream.codec_id;
        (vInfo as any)._index = vStream.index;
    }

    if (aStream) {
        if (!allowedAudioCodec.has(aStream.codec_id)) {
            cleanup();
            throw new Error(`Unsupported audio codec ID: ${aStream.codec_id}`);
        }
        const codecpar = await libav.ff_copyout_codecpar(aStream.codecpar);
        aInfo = {
            sample_rate: codecpar.sample_rate ?? 0,
            codec: aStream.codec_id,
            stream: aPipe,
        };
        (aInfo as any)._index = aStream.index;
    }

    // ─── Frame reading loop ──────────────────────────────────────────────

    let reading = false;
    const readFrame = async () => {
        if (reading) return;
        reading = true;
        try {
            let resume = true;
            while (resume) {
                const [status, packetStreams] = await libav.ff_read_frame_multi(fmt_ctx, pkt, {
                    limit: 1,
                    unify: true,
                });

                for (const packet of (packetStreams as any)[0] ?? []) {
                    if (vInfo && (vInfo as any)._index === packet.stream_index) {
                        // Inject parameter sets on IDR frames
                        const codecId = (vInfo as any)._codec_id;
                        const extra = (vInfo as any)._extradata;
                        if (codecId === AV_CODEC_ID_H264 && extra) {
                            packet.data = h264AddParamSets(Buffer.from(packet.data), extra);
                        } else if (codecId === AV_CODEC_ID_H265 && extra) {
                            packet.data = h265AddParamSets(Buffer.from(packet.data), extra);
                        }
                        resume &&= vPipe.write(packet);
                    } else if (aInfo && (aInfo as any)._index === packet.stream_index) {
                        resume &&= aPipe.write(packet);
                    }
                }

                if (status < 0 && status !== -(libav as any).EAGAIN) {
                    cleanup();
                    vPipe.end();
                    aPipe.end();
                    return;
                }

                if (!resume) {
                    input.pause();
                }
            }
        } finally {
            reading = false;
        }
    };

    vPipe.on("drain", readFrame);
    aPipe.on("drain", readFrame);
    readFrame();

    return {
        video: vInfo,
        audio: aInfo,
    };
}
