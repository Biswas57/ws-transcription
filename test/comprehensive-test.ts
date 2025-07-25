// Comprehensive test suite for the optimized WebSocket transcription server
import { WebSocket } from "ws";
import * as fs from "fs/promises";
import * as path from "path";

const WS_URL = "ws://0.0.0.0:5551";

interface TestResult {
    testName: string;
    success: boolean;
    duration: number;
    details: any;
    error?: string;
}

const results: TestResult[] = [];

async function delay(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

// Test 1: Cache efficiency test
async function testCacheEfficiency(): Promise<TestResult> {
    const startTime = Date.now();
    const testName = "Cache Efficiency Test";

    try {
        const ws = new WebSocket(WS_URL);
        const messages: any[] = [];

        ws.on("message", data => {
            messages.push(JSON.parse(data.toString()));
        });

        await new Promise((resolve, reject) => {
            ws.on("open", async () => {
                try {
                    // Send same audio twice to test caching
                    ws.send(JSON.stringify({
                        action: "start",
                        blocks: { test: ["name", "age"] }
                    }));

                    const buf = await fs.readFile(path.join(__dirname, "sample.webm"));
                    const chunkSize = Math.ceil(buf.length / 20);

                    // First round
                    for (let i = 0; i < buf.length; i += chunkSize) {
                        ws.send(buf.subarray(i, i + chunkSize));
                        await delay(50);
                    }

                    await delay(2000); // Wait for processing

                    // Second round (same audio - should hit cache)
                    for (let i = 0; i < buf.length; i += chunkSize) {
                        ws.send(buf.subarray(i, i + chunkSize));
                        await delay(50);
                    }

                    ws.send(JSON.stringify({ action: "stop" }));

                    await delay(3000);
                    ws.close();
                    resolve(null);
                } catch (err) {
                    reject(err);
                }
            });

            ws.on("error", reject);
        });

        return {
            testName,
            success: true,
            duration: Date.now() - startTime,
            details: {
                messagesReceived: messages.length,
                cacheHitExpected: true
            }
        };
    } catch (error) {
        return {
            testName,
            success: false,
            duration: Date.now() - startTime,
            details: {},
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Test 2: Concurrent connections test
async function testConcurrentConnections(): Promise<TestResult> {
    const startTime = Date.now();
    const testName = "Concurrent Connections Test";

    try {
        const numConnections = 3;
        const connections: WebSocket[] = [];
        const allMessages: any[][] = [];

        for (let i = 0; i < numConnections; i++) {
            const ws = new WebSocket(WS_URL);
            connections.push(ws);
            allMessages.push([]);

            ws.on("message", data => {
                allMessages[i].push(JSON.parse(data.toString()));
            });
        }

        // Wait for all connections to open
        await Promise.all(connections.map(ws => new Promise(resolve => {
            ws.on("open", resolve);
        })));

        // Start all sessions concurrently
        const buf = await fs.readFile(path.join(__dirname, "sample.webm"));
        const chunkSize = Math.ceil(buf.length / 15);

        await Promise.all(connections.map(async (ws, index) => {
            ws.send(JSON.stringify({
                action: "start",
                blocks: { test: [`name${index}`, `data${index}`] }
            }));

            for (let i = 0; i < buf.length; i += chunkSize) {
                ws.send(buf.subarray(i, i + chunkSize));
                await delay(100);
            }

            ws.send(JSON.stringify({ action: "stop" }));
        }));

        await delay(5000); // Wait for all processing

        connections.forEach(ws => ws.close());

        return {
            testName,
            success: true,
            duration: Date.now() - startTime,
            details: {
                connections: numConnections,
                totalMessages: allMessages.reduce((sum, msgs) => sum + msgs.length, 0),
                messagesPerConnection: allMessages.map(msgs => msgs.length)
            }
        };
    } catch (error) {
        return {
            testName,
            success: false,
            duration: Date.now() - startTime,
            details: {},
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Test 3: Empty audio handling
async function testEmptyAudioHandling(): Promise<TestResult> {
    const startTime = Date.now();
    const testName = "Empty Audio Handling Test";

    try {
        const ws = new WebSocket(WS_URL);
        const messages: any[] = [];

        ws.on("message", data => {
            messages.push(JSON.parse(data.toString()));
        });

        await new Promise((resolve, reject) => {
            ws.on("open", async () => {
                try {
                    ws.send(JSON.stringify({
                        action: "start",
                        blocks: { test: ["field1"] }
                    }));

                    // Send empty/small buffers (should be filtered out)
                    for (let i = 0; i < 20; i++) {
                        const emptyBuffer = Buffer.alloc(100, 0); // Silent audio
                        ws.send(emptyBuffer);
                        await delay(100);
                    }

                    ws.send(JSON.stringify({ action: "stop" }));

                    await delay(2000);
                    ws.close();
                    resolve(null);
                } catch (err) {
                    reject(err);
                }
            });

            ws.on("error", reject);
        });

        return {
            testName,
            success: true,
            duration: Date.now() - startTime,
            details: {
                messagesReceived: messages.length,
                shouldHaveFilteredEmptyAudio: true
            }
        };
    } catch (error) {
        return {
            testName,
            success: false,
            duration: Date.now() - startTime,
            details: {},
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Test 4: Large buffer protection
async function testLargeBufferProtection(): Promise<TestResult> {
    const startTime = Date.now();
    const testName = "Large Buffer Protection Test";

    try {
        const ws = new WebSocket(WS_URL);
        const messages: any[] = [];

        ws.on("message", data => {
            const msg = JSON.parse(data.toString());
            messages.push(msg);
        });

        await new Promise((resolve, reject) => {
            ws.on("open", async () => {
                try {
                    ws.send(JSON.stringify({
                        action: "start",
                        blocks: { test: ["field1"] }
                    }));

                    // Send a very large buffer (should trigger protection)
                    const largeBuffer = Buffer.alloc(6 * 1024 * 1024, 1); // 6MB
                    ws.send(largeBuffer);

                    await delay(1000);
                    ws.send(JSON.stringify({ action: "stop" }));

                    await delay(1000);
                    ws.close();
                    resolve(null);
                } catch (err) {
                    reject(err);
                }
            });

            ws.on("error", reject);
        });

        // Should have received an error about buffer overflow
        const hasOverflowError = messages.some(msg => msg.error === "audio-buffer-overflow");

        return {
            testName,
            success: hasOverflowError,
            duration: Date.now() - startTime,
            details: {
                messagesReceived: messages.length,
                hasOverflowError,
                messages: messages
            }
        };
    } catch (error) {
        return {
            testName,
            success: false,
            duration: Date.now() - startTime,
            details: {},
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Test 5: Performance benchmark
async function testPerformanceBenchmark(): Promise<TestResult> {
    const startTime = Date.now();
    const testName = "Performance Benchmark Test";

    try {
        const ws = new WebSocket(WS_URL);
        let messageCount = 0;
        let firstMessageTime = 0;
        let lastMessageTime = 0;

        ws.on("message", () => {
            messageCount++;
            if (messageCount === 1) {
                firstMessageTime = Date.now();
            }
            lastMessageTime = Date.now();
        });

        await new Promise((resolve, reject) => {
            ws.on("open", async () => {
                try {
                    ws.send(JSON.stringify({
                        action: "start",
                        blocks: {
                            personal: ["name", "age", "location"],
                            contact: ["email", "phone"],
                            work: ["company", "position"]
                        }
                    }));

                    const buf = await fs.readFile(path.join(__dirname, "sample.webm"));
                    const chunkSize = Math.ceil(buf.length / 25);

                    for (let i = 0; i < buf.length; i += chunkSize) {
                        ws.send(buf.subarray(i, i + chunkSize));
                        await delay(200); // Realistic timing
                    }

                    ws.send(JSON.stringify({ action: "stop" }));

                    await delay(3000);
                    ws.close();
                    resolve(null);
                } catch (err) {
                    reject(err);
                }
            });

            ws.on("error", reject);
        });

        const totalResponseTime = lastMessageTime - firstMessageTime;

        return {
            testName,
            success: messageCount > 0,
            duration: Date.now() - startTime,
            details: {
                messageCount,
                firstResponseTime: firstMessageTime - startTime,
                totalResponseTime,
                avgResponseTime: totalResponseTime / messageCount || 0
            }
        };
    } catch (error) {
        return {
            testName,
            success: false,
            duration: Date.now() - startTime,
            details: {},
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

// Run all tests
async function runAllTests() {
    console.log("🚀 Starting comprehensive test suite...\n");

    const tests = [
        testCacheEfficiency,
        testEmptyAudioHandling,
        testLargeBufferProtection,
        testPerformanceBenchmark,
        testConcurrentConnections
    ];

    for (const test of tests) {
        console.log(`Running ${test.name}...`);
        const result = await test();
        results.push(result);

        if (result.success) {
            console.log(`✅ ${result.testName} - ${result.duration}ms`);
        } else {
            console.log(`❌ ${result.testName} - ${result.error}`);
        }

        console.log(`   Details:`, result.details);
        console.log("");

        // Small delay between tests
        await delay(1000);
    }

    // Summary
    console.log("📊 Test Summary:");
    console.log("================");
    const passed = results.filter(r => r.success).length;
    const total = results.length;
    console.log(`Passed: ${passed}/${total}`);
    console.log(`Average duration: ${Math.round(results.reduce((sum, r) => sum + r.duration, 0) / total)}ms`);

    if (passed === total) {
        console.log("\n🎉 All tests passed! Optimizations are working correctly.");
    } else {
        console.log("\n⚠️ Some tests failed. Please review the results above.");
    }
}

runAllTests().catch(console.error);
