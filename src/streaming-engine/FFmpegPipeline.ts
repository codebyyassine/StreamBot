import ffmpeg, { type FfmpegCommand } from "fluent-ffmpeg";
import { PassThrough, type Readable } from "node:stream";
import logger from "../utils/logger.js";

export interface StreamOptions {
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
    maxBitrateKbps: number;
    hardwareAcceleratedDecoding: boolean;
    videoCodec: "H264" | "H265" | "VP8";
    h26xPreset: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
    minimizeLatency: boolean;
    audioBitrateKbps: number;
    // HTTP options
    customHeaders?: Record<string, string>;
    isLive?: boolean;
}

export interface PreparedStream {
    command: FfmpegCommand;
    output: Readable;
    /** Resolves when the ffmpeg process finishes/errors */
    promise: Promise<void>;
}

/**
 * Create an FFmpeg pipeline that transcodes input to Matroska.
 * The output stream contains interleaved audio+video packets that
 * later get split by the Demuxer.
 */
export function prepareStream(
    input: string | Readable,
    options: StreamOptions,
    cancelSignal?: AbortSignal,
): PreparedStream {
    const output = new PassThrough();

    const inputIsUrl = typeof input === "string" && (input.startsWith("http://") || input.startsWith("https://"));
    const looksLikeHLS = typeof input === "string" && (
        input.includes(".m3u8") || input.includes("hls")
    );

    let command = ffmpeg(input as string);

    // ─── Input Flags ──────────────────────────────────────────────────────
    if (options.minimizeLatency) {
        command = command
            .inputOptions(["-fflags", "nobuffer"])
            .inputOptions(["-analyzeduration", "0"])
            .inputOptions(["-probesize", "500000"]);
    }

    if (inputIsUrl) {
        command = command
            .inputOptions(["-reconnect", "1"])
            .inputOptions(["-reconnect_streamed", "1"])
            .inputOptions(["-reconnect_delay_max", "5"]);

        if (options.customHeaders) {
            for (const [key, value] of Object.entries(options.customHeaders)) {
                command = command.inputOptions(["-headers", `${key}: ${value}`]);
            }
        }
    }

    if (looksLikeHLS || options.isLive) {
        command = command.inputOptions(["-live_start_index", "-1"]);
    }

    if (options.hardwareAcceleratedDecoding) {
        command = command
            .inputOptions(["-hwaccel", "auto"]);
    }

    // ─── Video Encoding ───────────────────────────────────────────────────
    const videoFilters: string[] = [];
    videoFilters.push(`scale=${options.width}:${options.height}`);
    videoFilters.push(`fps=${options.fps}`);

    let videoCodecName: string;
    const videoOutputOptions: string[] = [
        "-bf", "0",                   // no B-frames (reduces latency)
        "-pix_fmt", "yuv420p",
    ];

    switch (options.videoCodec) {
        case "H264":
            videoCodecName = "libx264";
            videoOutputOptions.push(
                "-tune", "zerolatency",
                "-preset", options.h26xPreset,
                "-profile:v", "baseline",
            );
            break;
        case "H265":
            videoCodecName = "libx265";
            videoOutputOptions.push(
                "-tune", "zerolatency",
                "-preset", options.h26xPreset,
            );
            break;
        case "VP8":
            videoCodecName = "libvpx";
            videoOutputOptions.push(
                "-deadline", "realtime",
                "-cpu-used", "5",
            );
            break;
        default:
            videoCodecName = "libx264";
    }

    videoOutputOptions.push(
        "-b:v", `${options.bitrateKbps}k`,
        "-maxrate", `${options.maxBitrateKbps}k`,
        "-bufsize", `${options.maxBitrateKbps * 2}k`,
        "-g", `${options.fps}`,       // keyframe interval = 1 second
    );

    // ─── Audio Encoding ───────────────────────────────────────────────────
    const audioOptions = [
        "-c:a", "libopus",
        "-b:a", `${options.audioBitrateKbps}k`,
        "-ac", "2",
        "-ar", "48000",
        "-application", "audio",
    ];

    // ─── Build Command ────────────────────────────────────────────────────
    command = command
        .videoFilter(videoFilters.join(","))
        .videoCodec(videoCodecName)
        .outputOptions(videoOutputOptions)
        .outputOptions(audioOptions)
        .outputFormat("matroska")
        .outputOptions([
            "-cluster_size_limit", "2M",
            "-cluster_time_limit", "5000",
        ])
        .pipe(output, { end: true }) as FfmpegCommand;

    const promise = new Promise<void>((resolve, reject) => {
        command
            .on("error", (err: Error) => {
                if (err.message.includes("SIGKILL") || cancelSignal?.aborted) {
                    resolve();
                } else {
                    logger.error("FFmpeg error:", err.message);
                    reject(err);
                }
            })
            .on("end", () => {
                logger.info("FFmpeg finished");
                resolve();
            });
    });

    // Handle cancellation
    if (cancelSignal) {
        const onAbort = () => {
            try { command.kill("SIGKILL"); } catch { }
        };
        cancelSignal.addEventListener("abort", onAbort, { once: true });
        promise.finally(() => {
            cancelSignal.removeEventListener("abort", onAbort);
        });
    }

    return { command, output, promise };
}
