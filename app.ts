import PQueue from "p-queue";
import dotenv from "dotenv";
dotenv.config();

import { WebSocket, WebSocketServer } from "ws";
import { FieldDef, WSState } from "./interfaces";
import { checkWebMIntegrity, runWhisperOnBuffer, appendWithOverlap, isAudioWorthTranscribing } from "./transcription";
import { reviseTranscription, extractAttributesFromText, parseFinalAttributes } from "./parse_gpt";
import { JSONSchemaArray } from "openai/lib/jsonschema";

// Optimized constants for better performance and cost control
const MIN_CHUNK_NUM = 14;
const MIN_WORD_COUNT = 10;
const MAX_AUDIO_BUFFER_SIZE = 1024 * 1024 * 5; // 5MB limit
const TRANSCRIPTION_CACHE_TTL = 60000; // 1 minute cache

// Simple in-memory cache for transcriptions
const transcriptionCache = new Map<string, { transcription: string, timestamp: number }>();

// Helper function to create cache key from buffer
function createCacheKey(buffer: Buffer): string {
    return buffer.toString('base64').slice(0, 64); // Use first 64 chars as key
}

// Helper function to get cached transcription
function getCachedTranscription(cacheKey: string): string | null {
    const cached = transcriptionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TRANSCRIPTION_CACHE_TTL) {
        return cached.transcription;
    }
    if (cached) {
        transcriptionCache.delete(cacheKey); // Remove expired
    }
    return null;
}

// Helper function to cache transcription
function cacheTranscription(cacheKey: string, transcription: string): void {
    // Limit cache size to prevent memory issues
    if (transcriptionCache.size > 100) {
        const oldestKey = transcriptionCache.keys().next().value;
        if (oldestKey) {
            transcriptionCache.delete(oldestKey);
        }
    }
    transcriptionCache.set(cacheKey, { transcription, timestamp: Date.now() });
}

// Voice activity detection - improved version using the transcription module
function hasVoiceActivity(buffer: Buffer): boolean {
    return isAudioWorthTranscribing(buffer);
}

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
            const msg = JSON.parse(data.toString());
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
                        socket.send(
                            JSON.stringify({
                                corrected_audio: state.transcript,
                                attributes: state.currAttributes,
                            })
                        );
                        return;
                    }

                    // Process final chunk with caching
                    const finalCacheKey = createCacheKey(remainingData);
                    let finalTranscription = getCachedTranscription(finalCacheKey);

                    if (!finalTranscription) {
                        finalTranscription = await runWhisperOnBuffer(remainingData);
                        cacheTranscription(finalCacheKey, finalTranscription);
                    }

                    // Only revise if transcription is substantial
                    const wordCount = finalTranscription.trim().split(/\s+/).length;
                    const fixedTranscription = wordCount >= MIN_WORD_COUNT ?
                        await reviseTranscription(finalTranscription) :
                        finalTranscription;

                    // Update transcript
                    [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, fixedTranscription);

                    // Final attribute extraction with full context
                    state.currAttributes = await parseFinalAttributes(state.transcript, state.template, state.currAttributes);

                    console.log(`Final processing complete: ${state.transcript.length} chars transcribed`);
                    socket.send(
                        JSON.stringify({
                            corrected_audio: state.transcript,
                            attributes: state.currAttributes,
                        })
                    );
                } catch (error) {
                    console.error("Error in final processing:", error);
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
        const cacheKey = createCacheKey(captureBuffer);

        // reset audio buffers
        state.audioBuffer = Buffer.alloc(0);
        state.nchunks = 0;

        // Check cache first to avoid expensive API calls
        const cachedTranscription = getCachedTranscription(cacheKey);
        if (cachedTranscription) {
            console.log("Using cached transcription");
            const wordCount = cachedTranscription.trim().split(/\s+/).length;
            if (wordCount >= MIN_WORD_COUNT) {
                // Skip revision for cached content and go straight to attribute extraction
                const prevTranscriptSize = state.currTranscriptSize;
                [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, cachedTranscription);

                const currTranscript = state.transcript.slice(-(prevTranscriptSize + state.currTranscriptSize));
                const extractedAttributes = await extractAttributesFromText(currTranscript, template, currAttributes);
                state.currAttributes = { ...state.currAttributes, ...extractedAttributes };

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

                // Cache the transcription immediately
                cacheTranscription(cacheKey, transcription);

                // check if its even worth parsing to gpt for number of words
                const wordCount = transcription.trim().split(/\s+/).length;
                if (wordCount < MIN_WORD_COUNT) {
                    console.log(`Transcription too short (${wordCount} words), skipping processing`);
                    state.audioBuffer = captureBuffer;
                    state.nchunks = 0;
                    return;
                }

                // Run revision and attribute extraction in parallel for better efficiency
                const [fixedTranscription, extractedAttributesFromRaw] = await Promise.all([
                    reviseTranscription(transcription),
                    // Try extracting from raw transcription first (cheaper)
                    extractAttributesFromText(transcription, template, currAttributes)
                ]);

                const prevTranscriptSize = state.currTranscriptSize;
                [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, fixedTranscription);

                // Use sliding window approach for context-aware extraction
                const currTranscript = state.transcript.slice(-(prevTranscriptSize + state.currTranscriptSize));

                // Only do expensive GPT extraction if raw extraction didn't yield results
                const hasNewAttributes = Object.keys(extractedAttributesFromRaw).length > 0;
                const finalAttributes = hasNewAttributes ?
                    extractedAttributesFromRaw :
                    await extractAttributesFromText(currTranscript, template, currAttributes);

                state.currAttributes = { ...state.currAttributes, ...finalAttributes };

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
        // Note: We don't clear the transcription cache as it might be useful for other connections
    });
});
