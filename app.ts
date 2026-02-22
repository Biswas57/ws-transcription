import PQueue from "p-queue";
import dotenv from "dotenv";
dotenv.config();

import { WebSocket, WebSocketServer } from "ws";
import { FieldDef, WSState, MIN_CHUNK_NUM, MIN_WORD_COUNT, MAX_AUDIO_BUFFER_SIZE } from "./util.js";
import { checkWebMIntegrity, runWhisperOnBuffer, appendWithOverlap, hasVoiceActivity } from "./transcription.js";
import { reviseTranscription, extractAttributesFromText, parseFinalAttributes } from "./parse-gpt.js";

const wss = new WebSocketServer({ port: 5551 });
console.log(`WebSocket server listening on ws://0.0.0.0:5551`);

wss.on("connection", (socket: WebSocket) => {
    console.log("new client connected");
    const queue = new PQueue({ concurrency: 4 });

    // Initialize per-connection state
    const state: WSState = {
        nchunks: 0,
        audioBuffer: Buffer.alloc(0),
        transcript: "",
        currAttributes: {},
        template: [],
        webmHeader: null,
        currTranscriptSize: 0,
    };

    socket.on("message", async (data, isBinary) => {
        // Distinguish text vs binary
        if (!isBinary) {
            let msg: any;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                socket.send(JSON.stringify({ error: "bad-json" }));
                return;
            }
            console.log(msg, typeof msg);

            // Handle start action (init template)
            if (msg.action === "start") {
                try {
                    if (state.template.length === 0) {
                        for (const temp_block of Object.keys(msg.blocks ?? {})) {
                            const block = msg.blocks[temp_block];
                            if (!Array.isArray(block)) continue;

                            for (const field of block) {
                                const name = String(field);
                                state.template.push({ block_name: temp_block, field_name: name });
                                state.currAttributes[name] = "";
                            }
                        }
                    }

                    // Optional: acknowledge start so clients can confirm it worked
                    socket.send(JSON.stringify({ action: "started", template_size: state.template.length }));
                    return;
                } catch {
                    socket.send(JSON.stringify({ error: "bad-start-payload" }));
                    return;
                }
            }

            // Handle stop action
            if (msg.action === "stop") {
                await queue.onIdle();

                // process remaining audio buffer and clear it
                let remainingData = state.audioBuffer;
                if (remainingData.length === 0) {
                    socket.send(
                        JSON.stringify({
                            corrected_audio: state.transcript,
                            attributes: state.currAttributes,
                        })
                    );
                    return;
                }

                if (!checkWebMIntegrity(remainingData) && state.webmHeader) {
                    remainingData = Buffer.concat([state.webmHeader, remainingData]);
                }

                // Clear buffer immediately to prevent reuse
                state.audioBuffer = Buffer.alloc(0);
                state.nchunks = 0;
                state.webmHeader = null;

                try {
                    if (!hasVoiceActivity(remainingData)) {
                        console.log("No voice activity in remaining data, skipping final transcription");
                    } else {
                        const rawFinalTranscription = await runWhisperOnBuffer(remainingData);

                        const wordCount = rawFinalTranscription.trim().split(/\s+/).length;
                        if (wordCount >= MIN_WORD_COUNT) {
                            const finalTranscription = await reviseTranscription(rawFinalTranscription);
                            [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, finalTranscription);
                        }
                    }

                    // Final attribute extraction pass
                    state.currAttributes = await parseFinalAttributes(state.transcript, state.template, state.currAttributes);

                    console.log(`Final processing complete: ${state.transcript.length} chars transcribed`);
                    socket.send(
                        JSON.stringify({
                            corrected_audio: state.transcript,
                            attributes: state.currAttributes,
                        })
                    );
                } catch (error) {
                    console.error("Error in final processing:", error, ". Sending current state without final sweep");
                    socket.send(
                        JSON.stringify({
                            corrected_audio: state.transcript,
                            attributes: state.currAttributes,
                            error: "final-processing-failed",
                        })
                    );
                }
                return;
            }

            return;
        }

        // Binary data (audio chunk)
        const chunk = Buffer.from(data as Buffer);

        // Prevent excessive memory usage
        if (state.audioBuffer.length + chunk.length > MAX_AUDIO_BUFFER_SIZE) {
            console.warn("Audio buffer size limit exceeded, dropping chunk");
            socket.send(JSON.stringify({ error: "audio-buffer-overflow" }));
            return;
        }

        // Capture header for the first packet to come in
        if (!state.webmHeader && checkWebMIntegrity(chunk)) {
            state.webmHeader = chunk;
        }

        state.audioBuffer = Buffer.concat([state.audioBuffer, chunk]);

        state.nchunks++;
        if (state.nchunks < MIN_CHUNK_NUM) {
            return;
        }

        // Skip processing if no voice activity detected
        if (!hasVoiceActivity(state.audioBuffer)) {
            console.log("No voice activity detected, skipping processing");
            state.audioBuffer = Buffer.alloc(0);
            state.nchunks = 0;
            return;
        }

        // Prepare audioData with header
        if (!checkWebMIntegrity(state.audioBuffer) && state.webmHeader) {
            state.audioBuffer = Buffer.concat([state.webmHeader, state.audioBuffer]);
        }

        // Snapshot buffer (and reset capture state immediately)
        const captureBuffer = state.audioBuffer;
        state.audioBuffer = Buffer.alloc(0);
        state.nchunks = 0;

        // Non-blocking queue processing
        queue.add(async () => {
            try {
                const transcription = await runWhisperOnBuffer(captureBuffer);
                const revisedTranscript = await reviseTranscription(transcription);

                const wordCount = revisedTranscript.trim().split(/\s+/).length;
                if (wordCount < MIN_WORD_COUNT) {
                    console.log(`Transcription too short (${wordCount} words), skipping processing`);
                    return;
                }

                const prevTranscriptSize = state.currTranscriptSize;

                // Append to session transcript
                [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, revisedTranscript);

                // Only send the newly-added window (similar to your original)
                const currTranscript = state.transcript.slice(-(prevTranscriptSize + state.currTranscriptSize));

                // Extract attributes incrementally
                const extractedAttributes = await extractAttributesFromText(currTranscript, state.template, state.currAttributes);
                state.currAttributes = { ...state.currAttributes, ...extractedAttributes };

                socket.send(
                    JSON.stringify({
                        corrected_audio: currTranscript,
                        attributes: state.currAttributes,
                    })
                );
            } catch (e) {
                console.error("Transcription processing error:", e);
                socket.send(JSON.stringify({ error: "transcription-failed" }));
            }
        });
    });

    socket.on("close", () => {
        console.log("Client disconnected, cleaning up resources");
        queue.clear();
    });
});
