import type { Readable } from "node:stream";
import { demux } from "./Demuxer.js";
import { VideoMediaStream, AudioMediaStream } from "./MediaStream.js";
import type { StreamerClient } from "./StreamerClient.js";
import type { SupportedVideoCodec, VideoAttributes } from "./constants.js";
import { isFiniteNonZero } from "./constants.js";
import logger from "../utils/logger.js";

export interface PlayStreamOptions {
    videoCodec?: SupportedVideoCodec;
    width?: number;
    height?: number;
    fps?: number;
}

/**
 * High-level orchestrator: takes a Matroska input stream, demuxes it,
 * sets up the Go Live stream connection, and pipes everything through.
 *
 * Returns a Promise that resolves when playback finishes or is cancelled.
 */
export async function playStream(
    input: Readable,
    streamerClient: StreamerClient,
    options: PlayStreamOptions = {},
    cancelSignal?: AbortSignal,
): Promise<void> {
    const videoCodec = options.videoCodec ?? "H264";

    // 1. Demux the Matroska input into audio + video packet streams
    const result = await demux(input, cancelSignal);

    if (!result.video && !result.audio) {
        throw new Error("No video or audio streams found in input");
    }

    // 2. Create the Go Live stream connection
    const udp = await streamerClient.createStream(videoCodec);

    // 3. Determine video attributes from the demuxer or options
    let fps = options.fps ?? 30;
    let width = options.width ?? 1280;
    let height = options.height ?? 720;

    if (result.video) {
        if (isFiniteNonZero(result.video.width)) width = result.video.width;
        if (isFiniteNonZero(result.video.height)) height = result.video.height;
        if (isFiniteNonZero(result.video.framerate_num) && isFiniteNonZero(result.video.framerate_den)) {
            const detectedFps = result.video.framerate_num / result.video.framerate_den;
            if (detectedFps > 0 && detectedFps <= 60) fps = detectedFps;
        }
    }

    // Override with explicit options if provided
    if (options.width) width = options.width;
    if (options.height) height = options.height;
    if (options.fps) fps = options.fps;

    // 4. Signal video attributes + speaking
    streamerClient.signalVideo({ width, height, fps }, true);
    streamerClient.setSpeaking(true);

    // 5. Create media streams and pipe
    const videoMediaStream = result.video
        ? new VideoMediaStream(udp, fps)
        : null;
    const audioMediaStream = result.audio
        ? new AudioMediaStream(udp)
        : null;

    // Set up A/V sync
    if (videoMediaStream && audioMediaStream) {
        videoMediaStream.setSyncTarget(audioMediaStream);
    }

    // 6. Pipe demuxed streams → media streams → packetizers → UDP
    return new Promise<void>((resolve, reject) => {
        let finished = false;
        let videoDone = !result.video;
        let audioDone = !result.audio;

        const checkDone = () => {
            if (videoDone && audioDone && !finished) {
                finished = true;
                cleanup();
                resolve();
            }
        };

        const cleanup = () => {
            streamerClient.setSpeaking(false);
            streamerClient.signalVideo({ width: 0, height: 0, fps: 0 }, false);
        };

        // Handle cancellation
        if (cancelSignal) {
            cancelSignal.addEventListener("abort", () => {
                if (!finished) {
                    finished = true;
                    videoMediaStream?.destroy();
                    audioMediaStream?.destroy();
                    result.video?.stream.destroy();
                    result.audio?.stream.destroy();
                    cleanup();
                    resolve();
                }
            }, { once: true });
        }

        if (result.video && videoMediaStream) {
            result.video.stream.pipe(videoMediaStream);
            videoMediaStream.on("finish", () => {
                videoDone = true;
                checkDone();
            });
            videoMediaStream.on("error", (err) => {
                logger.error("Video stream error:", err);
                videoDone = true;
                checkDone();
            });
        }

        if (result.audio && audioMediaStream) {
            result.audio.stream.pipe(audioMediaStream);
            audioMediaStream.on("finish", () => {
                audioDone = true;
                checkDone();
            });
            audioMediaStream.on("error", (err) => {
                logger.error("Audio stream error:", err);
                audioDone = true;
                checkDone();
            });
        }

        // Safety timeout: if both streams end but finish event doesn't fire
        const safetyCheck = setInterval(() => {
            if (finished) {
                clearInterval(safetyCheck);
                return;
            }
            if (result.video?.stream.readableEnded && result.audio?.stream.readableEnded) {
                clearInterval(safetyCheck);
                if (!finished) {
                    finished = true;
                    cleanup();
                    resolve();
                }
            }
        }, 2000);
    });
}
