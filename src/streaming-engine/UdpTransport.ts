import dgram from "node:dgram";
import EventEmitter from "node:events";
import type { TransportEncryptor } from "./Encryptor.js";
import type { SupportedVideoCodec } from "./constants.js";
import { AudioPacketizer } from "./AudioPacketizer.js";
import { VideoPacketizer } from "./VideoPacketizer.js";
import logger from "../utils/logger.js";

/**
 * Manages the UDP socket for sending audio/video RTP packets.
 * Handles IP discovery and delegates to Audio/VideoPacketizer.
 */
export class UdpTransport extends EventEmitter {
    private _socket: dgram.Socket;
    private _ready = false;
    private _remoteAddress: string;
    private _remotePort: number;

    public encryptor: TransportEncryptor | null = null;
    public audioPacketizer: AudioPacketizer | null = null;
    public videoPacketizer: VideoPacketizer | null = null;

    constructor(remoteAddress: string, remotePort: number) {
        super();
        this._remoteAddress = remoteAddress;
        this._remotePort = remotePort;
        this._socket = dgram.createSocket("udp4");

        this._socket.on("error", (err) => {
            logger.error("UDP socket error:", err);
        });
    }

    // ─── IP Discovery ────────────────────────────────────────────────────────

    /**
     * Perform IP discovery handshake.
     * Sends a 74-byte discovery packet and resolves with our NAT-mapped IP and port.
     */
    async discoverIP(ssrc: number): Promise<{ ip: string; port: number }> {
        return new Promise<{ ip: string; port: number }>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("IP discovery timed out"));
            }, 10000);

            this._socket.once("message", (msg: Buffer) => {
                clearTimeout(timeout);

                // Parse response: Type(2) + Length(2) + SSRC(4) + IP(64 bytes null-terminated) + Port(2)
                const ipBuf = msg.subarray(8, 72);
                const ip = ipBuf.toString("utf-8").replace(/\0/g, "").trim();
                const port = msg.readUInt16BE(msg.length - 2);

                this._ready = true;
                resolve({ ip, port });
            });

            // Request: Type=0x1, Length=70, SSRC, rest zeros
            const packet = Buffer.alloc(74);
            packet.writeUInt16BE(0x1, 0); // Type
            packet.writeUInt16BE(70, 2);  // Length
            packet.writeUInt32BE(ssrc, 4);

            this._socket.send(packet, this._remotePort, this._remoteAddress, (err) => {
                if (err) {
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        });
    }

    // ─── Packetizer Setup ────────────────────────────────────────────────────

    /**
     * Create the audio and video packetizers for this UDP transport.
     */
    setupPacketizers(audioSsrc: number, videoSsrc: number, videoCodec: SupportedVideoCodec): void {
        this.audioPacketizer = new AudioPacketizer(this, audioSsrc);
        this.videoPacketizer = new VideoPacketizer(this, videoSsrc, videoCodec);
    }

    // ─── Packet Send ─────────────────────────────────────────────────────────

    sendPacket(packet: Buffer): void {
        if (!this._ready) return;
        this._socket.send(packet, this._remotePort, this._remoteAddress);
    }

    // ─── Convenience Methods ─────────────────────────────────────────────────

    async sendAudioFrame(frame: Buffer, frametime: number): Promise<void> {
        if (!this.audioPacketizer)
            throw new Error("Audio packetizer not set up");
        await this.audioPacketizer.sendFrame(frame, frametime);
    }

    async sendVideoFrame(frame: Buffer, frametime: number): Promise<void> {
        if (!this.videoPacketizer)
            throw new Error("Video packetizer not set up");
        await this.videoPacketizer.sendFrame(frame, frametime);
    }

    // ─── Cleanup ─────────────────────────────────────────────────────────────

    stop(): void {
        this._ready = false;
        try {
            this._socket.close();
        } catch {
            // socket may already be closed
        }
    }
}
