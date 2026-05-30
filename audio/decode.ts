import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

// Decode a WebM/Opus audio batch into 16kHz mono Float32 PCM samples.
//
// VAD models (Silero) require linear PCM, not compressed Opus. The browser
// sends WebM/Opus, so we decode with the bundled ffmpeg-static binary using a
// pure stdin/stdout pipe (no temp files). Output is raw 32-bit float
// little-endian, mono, 16kHz, which maps directly to a Float32Array.
//
// This function THROWS on failure. Callers (transcribeAudioBatch) must catch
// and fall back to Whisper so a decode/VAD problem never drops usable audio.
export async function decodeWebmOpusToPcm16kMonoFloat(
    webmBuffer: Buffer
): Promise<Float32Array> {
    if (!ffmpegPath) {
        throw new Error("ffmpeg-static binary path unavailable");
    }
    if (webmBuffer.length === 0) {
        return new Float32Array(0);
    }

    return await new Promise<Float32Array>((resolve, reject) => {
        const ffmpeg = spawn(
            ffmpegPath as unknown as string,
            [
                "-hide_banner",
                "-loglevel", "error",
                "-i", "pipe:0",
                "-ac", "1",
                "-ar", "16000",
                "-f", "f32le",
                "pipe:1",
            ],
            { stdio: ["pipe", "pipe", "pipe"] }
        );

        const stdoutChunks: Buffer[] = [];
        let stderr = "";
        let settled = false;

        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            reject(err);
        };

        ffmpeg.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        ffmpeg.stderr.on("data", (chunk: Buffer) => {
            // Cap stderr capture so a noisy decoder cannot grow memory unbounded.
            if (stderr.length < 2000) stderr += chunk.toString();
        });

        ffmpeg.on("error", (err) => fail(err));

        ffmpeg.on("close", (code) => {
            if (settled) return;
            if (code !== 0) {
                fail(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(0, 200)}`));
                return;
            }

            const combined = Buffer.concat(stdoutChunks);
            // Drop any trailing partial float so the view is always well-formed.
            const sampleCount = Math.floor(combined.length / 4);
            const samples = new Float32Array(sampleCount);
            for (let i = 0; i < sampleCount; i++) {
                samples[i] = combined.readFloatLE(i * 4);
            }
            settled = true;
            resolve(samples);
        });

        ffmpeg.stdin.on("error", (err) => fail(err));
        ffmpeg.stdin.write(webmBuffer);
        ffmpeg.stdin.end();
    });
}
