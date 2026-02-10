import { MAX_INT16, MAX_INT32, RTP_EXTENSIONS } from "./constants.js";
import type { TransportEncryptor } from "./Encryptor.js";

const NTP_EPOCH = new Date("Jan 01 1900 GMT").getTime();

// ─── RTP Header ──────────────────────────────────────────────────────────────

/**
 * Build a 12-byte RTP header.
 */
export function makeRtpHeader(
    sequence: number,
    timestamp: number,
    ssrc: number,
    payloadType: number,
    marker: boolean,
    extensionEnabled: boolean,
): Buffer {
    const header = Buffer.alloc(12);
    // Version 2, extension flag
    header[0] = (2 << 6) | ((extensionEnabled ? 1 : 0) << 4);
    header[1] = payloadType;
    if (marker) header[1] |= 0x80; // M bit

    header.writeUIntBE(sequence, 2, 2);
    header.writeUIntBE(timestamp, 4, 4);
    header.writeUIntBE(ssrc, 8, 4);
    return header;
}

// ─── RTP Extension (one-byte header format, RFC 5285) ────────────────────────

/**
 * Create the 4-byte extension header (profile + length).
 */
export function createExtensionHeader(
    extensions: { id: number; len: number; val: number }[],
): Buffer {
    const buf = Buffer.alloc(4);
    buf[0] = 0xBE;
    buf[1] = 0xDE;
    buf.writeInt16BE(extensions.length, 2);
    return buf;
}

/**
 * Create extension payload for one-byte extensions.
 * Currently supports the playout-delay extension (id=5).
 */
export function createExtensionPayload(
    extensions: { id: number; len: number; val: number }[],
): Buffer {
    const chunks: Buffer[] = [];
    for (const ext of extensions) {
        const data = Buffer.alloc(4);
        if (ext.id === 5) {
            data[0] = (ext.id & 0x0F) << 4;
            data[0] |= (ext.len - 1) & 0x0F;
            data.writeUIntBE(ext.val, 1, 2);
        }
        chunks.push(data);
    }
    return Buffer.concat(chunks);
}

// ─── RTCP Sender Report ──────────────────────────────────────────────────────

/**
 * Build and encrypt an RTCP Sender Report.
 */
export async function makeRtcpSenderReport(
    ssrc: number,
    timestamp: number,
    totalPackets: number,
    totalBytes: number,
    lastPacketTime: number,
    encryptor: TransportEncryptor,
): Promise<Buffer> {
    const packetHeader = Buffer.allocUnsafe(8);
    packetHeader[0] = 0x80; // v2, no padding, no RC
    packetHeader[1] = 0xC8; // Type: Sender Report (200)
    packetHeader[2] = 0x00;
    packetHeader[3] = 0x06;
    packetHeader.writeUInt32BE(ssrc, 4);

    const sr = Buffer.allocUnsafe(20);
    const ntpTimestamp = (lastPacketTime - NTP_EPOCH) / 1000;
    const ntpMsw = Math.floor(ntpTimestamp);
    const ntpLsw = Math.round((ntpTimestamp - ntpMsw) * MAX_INT32);

    sr.writeUInt32BE(ntpMsw, 0);
    sr.writeUInt32BE(ntpLsw, 4);
    sr.writeUInt32BE(timestamp, 8);
    sr.writeUInt32BE(totalPackets % MAX_INT32, 12);
    sr.writeUInt32BE(totalBytes, 16);

    const [ciphertext, nonceBuffer] = await encryptor.encrypt(sr, packetHeader);
    return Buffer.concat([packetHeader, ciphertext, nonceBuffer.subarray(0, 4)]);
}

// ─── Sequence / Timestamp helpers ────────────────────────────────────────────

export function nextSequence(current: number): number {
    return (current + 1) % MAX_INT16;
}

export function advanceTimestamp(current: number, increment: number): number {
    return (current + increment) % MAX_INT32;
}

// ─── MTU Chunking ────────────────────────────────────────────────────────────

const DEFAULT_MTU = 1200;

export function partitionByMTU(data: Buffer, mtu = DEFAULT_MTU): Buffer[] {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < data.length) {
        const size = Math.min(data.length - offset, mtu);
        chunks.push(data.subarray(offset, offset + size));
        offset += size;
    }
    return chunks;
}
