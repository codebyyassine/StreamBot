import {
    CodecPayloadType, MAX_INT16, MAX_INT32, RTP_EXTENSIONS,
    type SupportedVideoCodec,
} from "./constants.js";
import type { TransportEncryptor } from "./Encryptor.js";
import {
    makeRtpHeader, createExtensionHeader, createExtensionPayload,
    makeRtcpSenderReport, nextSequence, advanceTimestamp, partitionByMTU,
} from "./RtpPacket.js";
import type { UdpTransport } from "./UdpTransport.js";

// ─── NAL Unit Helpers ────────────────────────────────────────────────────────

export enum H264NalUnitTypes {
    CodedSliceIdr = 5,
    SPS = 7,
    PPS = 8,
    AccessUnitDelimiter = 9,
}

export enum H265NalUnitTypes {
    IDR_W_RADL = 19,
    IDR_N_LP = 20,
    VPS_NUT = 32,
    SPS_NUT = 33,
    PPS_NUT = 34,
    AUD_NUT = 35,
}

/** Split an AVPacket frame (length-prefixed NALUs) into individual NAL units */
export function splitNalu(frame: Buffer): Buffer[] {
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

/** Merge NAL units back into length-prefixed AVPacket format */
export function mergeNalu(nalus: Buffer[]): Buffer {
    const chunks: Buffer[] = [];
    for (const nalu of nalus) {
        const size = Buffer.allocUnsafe(4);
        size.writeUInt32BE(nalu.length);
        chunks.push(size, nalu);
    }
    return Buffer.concat(chunks);
}

// H264 helpers
function h264GetUnitType(frame: Buffer): number { return frame[0] & 0x1F; }
function h264SplitHeader(frame: Buffer): [Buffer, Buffer] {
    return [frame.subarray(0, 1), frame.subarray(1)];
}

// H265 helpers
function h265GetUnitType(frame: Buffer): number { return (frame[0] >> 1) & 0x3F; }
function h265SplitHeader(frame: Buffer): [Buffer, Buffer] {
    return [frame.subarray(0, 2), frame.subarray(2)];
}

// ─── FU Headers ──────────────────────────────────────────────────────────────

function makeH264FUHeader(isFirst: boolean, isLast: boolean, naluHeader: Buffer): Buffer {
    const nal0 = naluHeader[0];
    const nalType = h264GetUnitType(naluHeader);
    const fnri = nal0 & 0xE0;
    const fu = Buffer.alloc(2);
    fu[0] = 0x1C | fnri; // type 28 (FU-A) with FNRI
    if (isFirst) fu[1] = 0x80 | nalType;
    else if (isLast) fu[1] = 0x40 | nalType;
    else fu[1] = nalType;
    return fu;
}

function makeH265FUHeader(isFirst: boolean, isLast: boolean, naluHeader: Buffer): Buffer {
    const fu = Buffer.allocUnsafe(3);
    naluHeader.copy(fu);
    const nalType = h265GetUnitType(naluHeader);
    // Set NAL type to 49 (FU)
    fu[0] = (fu[0] & 0b10000001) | (49 << 1);
    if (isFirst) fu[2] = 0x80 | nalType;
    else if (isLast) fu[2] = 0x40 | nalType;
    else fu[2] = nalType;
    return fu;
}

// ─── Video Packetizer ────────────────────────────────────────────────────────

const MTU = 1200;

export class VideoPacketizer {
    private _ssrc: number;
    private _sequence = 0;
    private _timestamp = 0;
    private _totalPackets = 0;
    private _totalBytes = 0;
    private _lastPacketTime = 0;
    private _lastRtcpTime = 0;
    private _mediaTimestamp = 0;
    private _srInterval = 1000;
    private _rtcpEnabled: boolean;
    private _udp: UdpTransport;
    private _codec: SupportedVideoCodec;
    private _payloadType: number;
    private _pictureId = 0; // VP8 only

    constructor(udp: UdpTransport, ssrc: number, codec: SupportedVideoCodec, rtcpEnabled = true) {
        this._udp = udp;
        this._ssrc = ssrc;
        this._codec = codec;
        this._rtcpEnabled = rtcpEnabled;

        const codecInfo = CodecPayloadType[codec];
        if (!codecInfo) throw new Error(`Unsupported video codec: ${codec}`);
        this._payloadType = codecInfo.payload_type;
    }

    async sendFrame(frame: Buffer, frametime: number): Promise<void> {
        this._lastPacketTime = Date.now();

        if (this._codec === "VP8") {
            await this._sendVP8Frame(frame, frametime);
        } else {
            await this._sendAnnexBFrame(frame, frametime);
        }
    }

    // ─── VP8 ─────────────────────────────────────────────────────────────────

    private async _sendVP8Frame(frame: Buffer, frametime: number): Promise<void> {
        const chunks = partitionByMTU(frame, MTU);
        let bytesSent = 0;

        const encryptedPackets = chunks.map((chunk, i) =>
            this._createVP8Packet(chunk, i === chunks.length - 1, i === 0),
        );
        for (const packet of await Promise.all(encryptedPackets)) {
            this._udp.sendPacket(packet);
            bytesSent += packet.length;
        }

        await this._onFrameSent(chunks.length, bytesSent, frametime);
        this._pictureId = (this._pictureId + 1) % MAX_INT16;
    }

    private async _createVP8Packet(chunk: Buffer, isLast: boolean, isFirst: boolean): Promise<Buffer> {
        const packetHeader = Buffer.concat([
            this._makeRtpHeader(isLast),
            createExtensionHeader(RTP_EXTENSIONS),
        ]);

        // VP8 payload descriptor (2 bytes) + picture ID extension (2 bytes)
        const descriptor = Buffer.alloc(2);
        descriptor[0] = 0x80;
        descriptor[1] = 0x80;
        if (isFirst) descriptor[0] |= 0x10; // S bit

        const pictureId = Buffer.alloc(2);
        pictureId.writeUIntBE(this._pictureId, 0, 2);
        pictureId[0] |= 0x80;

        const packetData = Buffer.concat([
            createExtensionPayload(RTP_EXTENSIONS),
            descriptor, pictureId, chunk,
        ]);

        const encryptor = this._udp.encryptor;
        if (!encryptor) throw new Error("Encryptor not set");
        const [ciphertext, nonce] = await encryptor.encrypt(packetData, packetHeader);
        return Buffer.concat([packetHeader, ciphertext, nonce.subarray(0, 4)]);
    }

    // ─── Annex B (H264 / H265) ──────────────────────────────────────────────

    private async _sendAnnexBFrame(frame: Buffer, frametime: number): Promise<void> {
        const nalus = splitNalu(frame);
        let packetsSent = 0;
        let bytesSent = 0;

        const splitHeader = this._codec === "H265" ? h265SplitHeader : h264SplitHeader;
        const makeFU = this._codec === "H265" ? makeH265FUHeader : makeH264FUHeader;

        for (let idx = 0; idx < nalus.length; idx++) {
            const nalu = nalus[idx];
            const isLastNal = idx === nalus.length - 1;

            if (nalu.length <= MTU) {
                // Single NAL Unit Packet
                const packetHeader = Buffer.concat([
                    this._makeRtpHeader(isLastNal),
                    createExtensionHeader(RTP_EXTENSIONS),
                ]);
                const encryptor = this._udp.encryptor;
                if (!encryptor) throw new Error("Encryptor not set");
                const [ciphertext, nonce] = await encryptor.encrypt(
                    Buffer.concat([createExtensionPayload(RTP_EXTENSIONS), nalu]),
                    packetHeader,
                );
                const packet = Buffer.concat([packetHeader, ciphertext, nonce.subarray(0, 4)]);
                this._udp.sendPacket(packet);
                packetsSent++;
                bytesSent += packet.length;
            } else {
                // Fragmentation Unit (FU-A)
                const [naluHeader, naluData] = splitHeader(nalu);
                const fragments = partitionByMTU(naluData, MTU);
                const encryptedPackets: Promise<Buffer>[] = [];

                for (let i = 0; i < fragments.length; i++) {
                    const isFirstFrag = i === 0;
                    const isLastFrag = i === fragments.length - 1;
                    const marker = isLastNal && isLastFrag;

                    const packetHeader = Buffer.concat([
                        this._makeRtpHeader(marker),
                        createExtensionHeader(RTP_EXTENSIONS),
                    ]);
                    const packetData = Buffer.concat([
                        createExtensionPayload(RTP_EXTENSIONS),
                        makeFU(isFirstFrag, isLastFrag, naluHeader),
                        fragments[i],
                    ]);

                    const encryptor = this._udp.encryptor;
                    if (!encryptor) throw new Error("Encryptor not set");
                    encryptedPackets.push(
                        encryptor.encrypt(packetData, packetHeader)
                            .then(([ct, n]) => Buffer.concat([packetHeader, ct, n.subarray(0, 4)])),
                    );
                }

                for (const packet of await Promise.all(encryptedPackets)) {
                    this._udp.sendPacket(packet);
                    packetsSent++;
                    bytesSent += packet.length;
                }
            }
        }

        await this._onFrameSent(packetsSent, bytesSent, frametime);
    }

    // ─── Shared ──────────────────────────────────────────────────────────────

    private _makeRtpHeader(marker: boolean): Buffer {
        const header = makeRtpHeader(
            this._sequence, this._timestamp, this._ssrc,
            this._payloadType, marker, true,
        );
        this._sequence = nextSequence(this._sequence);
        return header;
    }

    private async _onFrameSent(packetsSent: number, bytesSent: number, frametime: number): Promise<void> {
        this._totalPackets += packetsSent;
        this._totalBytes = (this._totalBytes + bytesSent) % MAX_INT32;

        if (this._rtcpEnabled) {
            const prev = Math.floor(this._lastRtcpTime / this._srInterval);
            const curr = Math.floor(this._mediaTimestamp / this._srInterval);
            if (curr - prev > 0) {
                const encryptor = this._udp.encryptor;
                if (!encryptor) throw new Error("Encryptor not set");
                const sr = await makeRtcpSenderReport(
                    this._ssrc, this._timestamp,
                    this._totalPackets, this._totalBytes,
                    this._lastPacketTime, encryptor,
                );
                this._udp.sendPacket(sr);
                this._lastRtcpTime = this._mediaTimestamp;
            }
        }

        this._mediaTimestamp += frametime;
        // 90kHz clock for video
        this._timestamp = advanceTimestamp(this._timestamp, (90000 / 1000) * frametime);
    }
}
