import { Writable } from "node:stream";
import { isFiniteNonZero } from "./constants.js";
import type { UdpTransport } from "./UdpTransport.js";
import logger from "../utils/logger.js";

/**
 * Base media stream — a Writable in object mode that receives demuxed packets
 * and sends them through the UDP transport with PTS-based timing.
 */
abstract class BaseMediaStream extends Writable {
    protected _startTime = 0;
    protected _firstFrame = true;
    protected _syncStream: BaseMediaStream | null = null;
    protected _lastPts = 0;

    constructor() {
        super({
            objectMode: true,
            highWaterMark: 128,
        });
    }

    /**
     * Link another media stream for A/V sync.
     * The faster stream will wait for the slower one.
     */
    setSyncTarget(other: BaseMediaStream): void {
        this._syncStream = other;
        other._syncStream = this;
    }

    get lastPts(): number { return this._lastPts; }

    /**
     * Calculate how long to sleep before sending this frame,
     * based on PTS relative to wall-clock elapsed time.
     */
    protected _calcSleepMs(pts: number, frametimeMs: number): number {
        if (this._firstFrame) {
            this._startTime = performance.now();
            this._firstFrame = false;
            return 0;
        }

        const elapsed = performance.now() - this._startTime;
        const diff = pts - elapsed;

        // If we're more than 200ms behind, don't sleep (catch up)
        if (diff < -200) return 0;
        // If we're ahead, sleep to match PTS
        if (diff > 0) return diff;
        return 0;
    }
}

// ─── Video Media Stream ──────────────────────────────────────────────────────

export class VideoMediaStream extends BaseMediaStream {
    private _udp: UdpTransport;
    private _defaultFrametime: number; // ms per frame

    constructor(udp: UdpTransport, fps: number) {
        super();
        this._udp = udp;
        this._defaultFrametime = 1000 / fps;
    }

    override async _write(
        packet: { data: Buffer | Uint8Array; pts: number; ptshi: number },
        _encoding: string,
        callback: (error?: Error | null) => void,
    ): Promise<void> {
        try {
            const pts = packet.pts / 1000; // Convert µs to ms
            this._lastPts = pts;

            const sleep = this._calcSleepMs(pts, this._defaultFrametime);
            if (sleep > 1) {
                await new Promise<void>(r => setTimeout(r, sleep));
            }

            const frame = Buffer.isBuffer(packet.data) ? packet.data : Buffer.from(packet.data);
            await this._udp.sendVideoFrame(frame, this._defaultFrametime);
            callback();
        } catch (err) {
            callback(err as Error);
        }
    }
}

// ─── Audio Media Stream ──────────────────────────────────────────────────────

export class AudioMediaStream extends BaseMediaStream {
    private _udp: UdpTransport;
    private _defaultFrametime = 20; // Opus typically uses 20ms frames

    constructor(udp: UdpTransport) {
        super();
        this._udp = udp;
    }

    override async _write(
        packet: { data: Buffer | Uint8Array; pts: number; ptshi: number },
        _encoding: string,
        callback: (error?: Error | null) => void,
    ): Promise<void> {
        try {
            const pts = packet.pts / 1000; // Convert µs to ms
            this._lastPts = pts;

            const sleep = this._calcSleepMs(pts, this._defaultFrametime);
            if (sleep > 1) {
                await new Promise<void>(r => setTimeout(r, sleep));
            }

            const frame = Buffer.isBuffer(packet.data) ? packet.data : Buffer.from(packet.data);
            await this._udp.sendAudioFrame(frame, this._defaultFrametime);
            callback();
        } catch (err) {
            callback(err as Error);
        }
    }
}
