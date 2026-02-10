import {
    CodecPayloadType, MAX_INT32, RTP_EXTENSIONS,
} from "./constants.js";
import type { TransportEncryptor } from "./Encryptor.js";
import {
    makeRtpHeader, createExtensionHeader, createExtensionPayload,
    makeRtcpSenderReport, nextSequence, advanceTimestamp,
} from "./RtpPacket.js";
import type { UdpTransport } from "./UdpTransport.js";

/**
 * Packetizes Opus audio frames into encrypted RTP packets.
 */
export class AudioPacketizer {
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

    constructor(udp: UdpTransport, ssrc: number, rtcpEnabled = true) {
        this._udp = udp;
        this._ssrc = ssrc;
        this._rtcpEnabled = rtcpEnabled;
    }

    async sendFrame(frame: Buffer, frametime: number): Promise<void> {
        this._lastPacketTime = Date.now();

        const header = makeRtpHeader(
            this._sequence, this._timestamp, this._ssrc,
            CodecPayloadType.opus.payload_type, true, false,
        );
        this._sequence = nextSequence(this._sequence);

        const encryptor = this._udp.encryptor;
        if (!encryptor) throw new Error("Encryptor not set");

        const [ciphertext, nonce] = await encryptor.encrypt(frame, header);
        const packet = Buffer.concat([header, ciphertext, nonce.subarray(0, 4)]);

        this._udp.sendPacket(packet);

        // Stats + RTCP SR
        this._totalPackets++;
        this._totalBytes = (this._totalBytes + packet.length) % MAX_INT32;

        if (this._rtcpEnabled) {
            const prevBucket = Math.floor(this._lastRtcpTime / this._srInterval);
            const currBucket = Math.floor(this._mediaTimestamp / this._srInterval);
            if (currBucket - prevBucket > 0) {
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
        // 48kHz clock for audio
        this._timestamp = advanceTimestamp(this._timestamp, frametime * 48);
    }
}
