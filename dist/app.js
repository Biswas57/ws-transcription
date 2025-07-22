"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const p_queue_1 = __importDefault(require("p-queue"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const ws_1 = require("ws");
const transcription_1 = require("./transcription");
const parse_gpt_1 = require("./parse_gpt");
const MIN_CHUNK_NUM = 14;
const MIN_WORD_COUNT = 3;
const wss = new ws_1.WebSocketServer({ port: 5551 });
console.log(`WebSocket server listening on ws://0.0.0.0:5551`);
wss.on("connection", (socket) => {
    console.log("new client connected");
    const queue = new p_queue_1.default({ concurrency: 4 });
    // Initialize per-connection state
    const state = {
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
                        const block = msg.blocks[temp_block];
                        console.log(block);
                        block.forEach(field => {
                            const def = { block_name: temp_block, field_name: field.toString(), };
                            state.template.push(def);
                            state.currAttributes[field.toString()] = "";
                        });
                    }
                    console.log("Initialized template:", state.template);
                    return;
                }
            }
            // Handle stop action
            // basically collect last few audio bytes before ending 
            if (msg.action === "stop") {
                await queue.onIdle();
                // save remaining audio buffer and clear it, as same state can be used again
                let remainingData = state.audioBuffer;
                if (!(0, transcription_1.checkWebMIntegrity)(remainingData) && state.webmHeader) {
                    remainingData = Buffer.concat([state.webmHeader, remainingData]);
                }
                // Also have to start new audio buffer for next session (action === "start")
                state.audioBuffer = Buffer.alloc(0);
                const transcription = await (0, transcription_1.runWhisperOnBuffer)(remainingData);
                const fixedTranscription = await (0, parse_gpt_1.reviseTranscription)(transcription);
                // sliding window approach here because storing prev and curr transcript state is a bit heavier
                // assign final attributes to curr attributes in case user wants to start recording again
                [state.transcript, state.currTranscriptSize] = (0, transcription_1.appendWithOverlap)(state.transcript, fixedTranscription);
                state.currAttributes = await (0, parse_gpt_1.parseFinalAttributes)(state.transcript, state.template, state.currAttributes);
                console.log(`I THINK IM HERE: ${state.transcript}`);
                socket.send(JSON.stringify({
                    corrected_audio: state.transcript,
                    attributes: state.currAttributes,
                }));
                return;
            }
            return;
        }
        // Binary data (audio chunk)
        const chunk = Buffer.from(data);
        // Capture header for the first packet to come in
        if (!state.webmHeader && (0, transcription_1.checkWebMIntegrity)(chunk)) {
            state.webmHeader = chunk;
        }
        state.audioBuffer = Buffer.concat([state.audioBuffer, chunk]);
        state.nchunks++;
        if (state.nchunks < MIN_CHUNK_NUM) {
            return;
        }
        // Prepare audioData with header
        if (!(0, transcription_1.checkWebMIntegrity)(state.audioBuffer) && state.webmHeader) {
            state.audioBuffer = Buffer.concat([state.webmHeader, state.audioBuffer]);
        }
        // Snapshot state for this job
        const template = state.template;
        const currAttributes = state.currAttributes;
        const captureBuffer = state.audioBuffer;
        // reset audio buffers
        state.audioBuffer = Buffer.alloc(0);
        state.nchunks = 0;
        // enqueue every transcription and openai call
        await queue.add(async () => {
            try {
                const transcription = await (0, transcription_1.runWhisperOnBuffer)(captureBuffer);
                // check if its even worth parsing to gpt for number of words
                const wordCount = transcription.trim().split(/\s+/).length;
                if (wordCount < MIN_WORD_COUNT) {
                    // I made the number of chunks in the audio buffer here 0 -> explain reason in person
                    // but didn't reset the Audio buffer
                    state.nchunks = 0;
                    return;
                }
                const fixedTranscription = await (0, parse_gpt_1.reviseTranscription)(transcription);
                const prevTranscriptSize = state.currTranscriptSize;
                [state.transcript, state.currTranscriptSize] = (0, transcription_1.appendWithOverlap)(state.transcript, fixedTranscription);
                const currTranscript = state.transcript.slice(-(prevTranscriptSize + state.currTranscriptSize));
                const extractedAttributes = await (0, parse_gpt_1.extractAttributesFromText)(currTranscript, template, currAttributes);
                state.currAttributes = { ...state.currAttributes, ...extractedAttributes };
                // Send update
                socket.send(JSON.stringify({
                    corrected_audio: currTranscript,
                    attributes: state.currAttributes,
                }));
            }
            catch (e) {
                console.error(e);
                socket.send(JSON.stringify({ error: "transcription-failed" }));
            }
        });
    });
    socket.on("close", () => {
    });
});
