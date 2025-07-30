import PQueue from "p-queue";
import dotenv from "dotenv";
dotenv.config();

import { WebSocket, WebSocketServer } from "ws";
import { FieldDef, WSState } from "./util";
import { checkWebMIntegrity, runWhisperOnBuffer, appendWithOverlap, hasVoiceActivity } from "./transcription";
import { reviseTranscription, extractAttributesFromText, parseFinalAttributes } from "./parse-gpt";
import { createAudioKey, getCachedAudio, cacheAudio } from "./audio-cache"
import { createTranscriptKey, getCachedTranscript, cacheTranscript } from "./transcript-cache"
import { MIN_CHUNK_NUM, MIN_WORD_COUNT, MAX_AUDIO_BUFFER_SIZE } from "./util";
import { JSONSchemaArray } from "openai/lib/jsonschema";

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
                if (state.template.length === 0) {
                    for (const temp_block of Object.keys(msg.blocks)) {
                        const block: JSONSchemaArray = msg.blocks[temp_block];
                        console.log(block)

                        block.forEach(field => {
                            const def: FieldDef = { block_name: temp_block, field_name: field!.toString(), };
                            state.template.push(def);
                            state.currAttributes[field!.toString()] = "";
                        })
                    }
                    console.log("Initialized template:", state.template);
                    return;
                }
            }

            // Handle stop action
            // Process remaining audio and perform final optimization
            if (msg.action === "stop") {
                await queue.onIdle();

                // process remaining audio buffer and clear it
                let remainingData = state.audioBuffer;
                if (remainingData.length === 0) {
                    // No remaining data, just send final results
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

                try {
                    // Check if we have enough audio to process
                    if (!hasVoiceActivity(remainingData)) {
                        console.log("No voice activity in remaining data, skipping final transcription");
                    } else {
                        const audioCacheKey = createAudioKey(remainingData);
                        let rawFinalTranscription = getCachedAudio(audioCacheKey);

                        if (!rawFinalTranscription) {
                            rawFinalTranscription = await runWhisperOnBuffer(remainingData);
                        }

                        // Only revise if transcription is substantial
                        const wordCount = rawFinalTranscription.trim().split(/\s+/).length;
                        if (wordCount >= MIN_WORD_COUNT) {
                            const finalTranscription = await reviseTranscription(rawFinalTranscription);
                            cacheAudio(audioCacheKey, finalTranscription);
                            [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, finalTranscription);
                        }
                    }

                    // Update transcript and Final attribute extraction
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
                    // Send current state even if final processing fails
                    socket.send(
                        JSON.stringify({
                            corrected_audio: state.transcript,
                            attributes: state.currAttributes,
                            error: "final-processing-failed"
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
            // is it smart to zero the audio buffer and num chunks because were not processing this audio
            state.audioBuffer = Buffer.alloc(0);
            state.nchunks = 0;
            return;
        }

        // Prepare audioData with header
        if (!checkWebMIntegrity(state.audioBuffer) && state.webmHeader) {
            state.audioBuffer = Buffer.concat([state.webmHeader, state.audioBuffer]);
        }

        // Snapshot state for this job
        const template = state.template;
        const currAttributes = { ...state.currAttributes }; // Deep copy to prevent race conditions
        const captureBuffer = state.audioBuffer;
        const audioCacheKey = createAudioKey(captureBuffer);

        // reset audio buffers
        state.audioBuffer = Buffer.alloc(0);
        state.nchunks = 0;

        // Check audio cache first to avoid expensive Whisper API calls
        const cachedAudio = getCachedAudio(audioCacheKey);
        if (cachedAudio) {
            console.log("Using cached audio transcription");
            const wordCount = cachedAudio.trim().split(/\s+/).length;
            if (wordCount >= MIN_WORD_COUNT) {

                // Check for cached content before going to revision and attribute extraction
                // Process differently if we find a cached transcription and if we don't
                const currTranscript = await processCachedTranscription(state, cachedAudio);

                socket.send(
                    JSON.stringify({
                        corrected_audio: currTranscript,
                        attributes: state.currAttributes,
                    })
                );
            }
            return;
        }

        // Use non-blocking queue processing
        queue.add(async () => {
            try {
                const transcription = await runWhisperOnBuffer(captureBuffer);

                // Cache the audio transcription and revise immediately
                const revisedTranscript = await reviseTranscription(transcription)
                cacheAudio(audioCacheKey, revisedTranscript);

                // check if its even worth parsing to gpt for number of words
                const wordCount = revisedTranscript.trim().split(/\s+/).length;
                if (wordCount < MIN_WORD_COUNT) {
                    console.log(`Transcription too short (${wordCount} words), skipping processing`);
                    state.audioBuffer = captureBuffer;
                    state.nchunks = 0;
                    return;
                }

                // Check for cached content before going to revision and attribute extraction
                // Process differently if we find a cached transcription and if we don't
                const currTranscript = await processCachedTranscription(state, revisedTranscript);

                // Send update
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
        }); // Removed await to make it non-blocking
    });

    socket.on("close", () => {
        console.log("Client disconnected, cleaning up resources");
        // Clear any remaining queue tasks
        queue.clear();
        // Note: We don't clear caches as they might be useful for other connections
    });
});

export async function processCachedTranscription(state: WSState, transcription: string): Promise<string> {
    // Check transcript cache for revision
    const transcriptKey = createTranscriptKey(transcription);
    const cachedtranscript = getCachedTranscript(transcriptKey);
    const prevTranscriptSize = state.currTranscriptSize;

    let currTranscript: string;
    if (cachedtranscript) {
        console.log("Used cached transcript so not updating current attributes");
        [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, cachedtranscript);
        currTranscript = state.transcript.slice(-(prevTranscriptSize + state.currTranscriptSize));
    } else {
        // if there is cached audio but not cached transcript then go through the normal process 
        // without revision because the audio stores a revised raw transcript anyways
        [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, transcription);
        currTranscript = state.transcript.slice(-(prevTranscriptSize + state.currTranscriptSize));

        // extract attributes and cache this transcript
        const extractedAttributes = await extractAttributesFromText(currTranscript, state.template, state.currAttributes);
        cacheTranscript(transcriptKey, transcription);

        // Append the current attributes because we're processing new audio
        state.currAttributes = { ...state.currAttributes, ...extractedAttributes };
    }

    return currTranscript;
}