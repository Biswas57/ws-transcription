import PQueue from "p-queue";
import dotenv from "dotenv";
dotenv.config();

import { WebSocket, WebSocketServer } from "ws";
import { FieldDef, WSState } from "./interfaces";
import { checkWebMIntegrity, runWhisperOnBuffer, appendWithOverlap } from "./transcription";
import { reviseTranscription, extractAttributesFromText, parseFinalAttributes } from "./parse_gpt";
import { JSONSchemaArray } from "openai/lib/jsonschema";

const MIN_CHUNK_NUM = 14;
const MIN_WORD_COUNT = 10;

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
            // basically collect last few audio bytes before ending 
            if (msg.action === "stop") {
                await queue.onIdle();

                // process remaining audio buffer and clear it, as same state can be used again
                let remainingData = state.audioBuffer;
                if (!checkWebMIntegrity(remainingData) && state.webmHeader) {
                    remainingData = Buffer.concat([state.webmHeader, remainingData]);
                }
                // Also have to start new audio buffer for next session (action === "start")
                state.audioBuffer = Buffer.alloc(0);

                const transcription = await runWhisperOnBuffer(remainingData);
                const fixedTranscription = await reviseTranscription(transcription);

                // assign final attributes to curr attributes in case user wants to start recording again
                [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, fixedTranscription);
                state.currAttributes = await parseFinalAttributes(state.transcript, state.template, state.currAttributes);

                console.log(`I THINK IM HERE: ${state.transcript}`)
                socket.send(
                    JSON.stringify({
                        corrected_audio: state.transcript,
                        attributes: state.currAttributes,
                    })
                );
                return;
            }

            return;
        }

        // Binary data (audio chunk)
        const chunk = Buffer.from(data as Buffer);
        // Capture header for the first packet to come in
        if (!state.webmHeader && checkWebMIntegrity(chunk)) {
            state.webmHeader = chunk;
        }
        state.audioBuffer = Buffer.concat([state.audioBuffer, chunk]);

        state.nchunks++;
        if (state.nchunks < MIN_CHUNK_NUM) {
            return;
        }

        // Prepare audioData with header
        if (!checkWebMIntegrity(state.audioBuffer) && state.webmHeader) {
            state.audioBuffer = Buffer.concat([state.webmHeader, state.audioBuffer]);
        }

        // Snapshot state for this job
        const template = state.template;
        const currAttributes = state.currAttributes;
        const captureBuffer = state.audioBuffer
        // reset audio buffers
        state.audioBuffer = Buffer.alloc(0);
        state.nchunks = 0;

        // enqueue every transcription and openai call
        await queue.add(async () => {
            try {
                const transcription = await runWhisperOnBuffer(captureBuffer);
                // check if its even worth parsing to gpt for number of words
                const wordCount = transcription.trim().split(/\s+/).length;
                if (wordCount < MIN_WORD_COUNT) {
                    // I made the number of chunks in the audio buffer here 0, but didn't reset the Audio buffer
                    // -> explain reason in person
                    state.audioBuffer = captureBuffer
                    state.nchunks = 0;
                    return;
                }

                const fixedTranscription = await reviseTranscription(transcription);
                const prevTranscriptSize = state.currTranscriptSize;
                [state.transcript, state.currTranscriptSize] = appendWithOverlap(state.transcript, fixedTranscription);

                // sliding window approach here because storing prev and curr transcript state is a bit heavier
                const currTranscript = state.transcript.slice(-(prevTranscriptSize + state.currTranscriptSize))
                const extractedAttributes = await extractAttributesFromText(currTranscript, template, currAttributes);
                state.currAttributes = { ...state.currAttributes, ...extractedAttributes };

                // Send update
                socket.send(
                    JSON.stringify({
                        corrected_audio: currTranscript,
                        attributes: state.currAttributes,
                    })
                );
            } catch (e) {
                console.error(e);
                socket.send(JSON.stringify({ error: "transcription-failed" }));
            }
        });
    });

    socket.on("close", () => {
    });
});
