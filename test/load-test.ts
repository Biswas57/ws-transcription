// Load test to verify performance improvements and cost optimizations
import { WebSocket } from "ws";
import * as fs from "fs/promises";
import * as path from "path";

const WS_URL = "ws://0.0.0.0:5551";

interface LoadTestMetrics {
    totalConnections: number;
    totalMessages: number;
    totalDuration: number;
    avgResponseTime: number;
    successfulSessions: number;
    failedSessions: number;
    cacheHitsObserved: number;
}

async function delay(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function createLoadTestSession(sessionId: number, audioBuffer: Buffer): Promise<{
    success: boolean;
    messageCount: number;
    duration: number;
    error?: string;
}> {
    const startTime = Date.now();

    return new Promise((resolve) => {
        const ws = new WebSocket(WS_URL);
        let messageCount = 0;
        let hasError = false;

        const timeout = setTimeout(() => {
            ws.close();
            resolve({
                success: false,
                messageCount,
                duration: Date.now() - startTime,
                error: "timeout"
            });
        }, 30000); // 30 second timeout

        ws.on("message", () => {
            messageCount++;
        });

        ws.on("error", (error) => {
            hasError = true;
            clearTimeout(timeout);
            resolve({
                success: false,
                messageCount,
                duration: Date.now() - startTime,
                error: error.message
            });
        });

        ws.on("close", () => {
            clearTimeout(timeout);
            if (!hasError) {
                resolve({
                    success: true,
                    messageCount,
                    duration: Date.now() - startTime
                });
            }
        });

        ws.on("open", async () => {
            try {
                // Start session
                ws.send(JSON.stringify({
                    action: "start",
                    blocks: {
                        personal: ["name", "age", "dob"],
                        contact: ["location", "phone"]
                    }
                }));

                // Send audio in chunks
                const chunkSize = Math.ceil(audioBuffer.length / 20);
                for (let i = 0; i < audioBuffer.length; i += chunkSize) {
                    ws.send(audioBuffer.subarray(i, i + chunkSize));
                    await delay(150); // Simulate realistic upload speed
                }

                // Stop session
                ws.send(JSON.stringify({ action: "stop" }));

                // Wait a bit before closing
                await delay(2000);
                ws.close();
            } catch (error) {
                hasError = true;
                clearTimeout(timeout);
                resolve({
                    success: false,
                    messageCount,
                    duration: Date.now() - startTime,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        });
    });
}

async function runLoadTest(numConcurrentSessions: number = 5): Promise<LoadTestMetrics> {
    console.log(`🔥 Starting load test with ${numConcurrentSessions} concurrent sessions...`);

    const startTime = Date.now();
    const audioBuffer = await fs.readFile(path.join(__dirname, "sample.webm"));

    // Create concurrent sessions
    const sessionPromises: Promise<any>[] = [];
    for (let i = 0; i < numConcurrentSessions; i++) {
        sessionPromises.push(createLoadTestSession(i, audioBuffer));
    }

    const results = await Promise.all(sessionPromises);
    const totalDuration = Date.now() - startTime;

    // Calculate metrics
    const successfulSessions = results.filter(r => r.success).length;
    const failedSessions = results.filter(r => !r.success).length;
    const totalMessages = results.reduce((sum, r) => sum + r.messageCount, 0);
    const avgResponseTime = results.reduce((sum, r) => sum + r.duration, 0) / results.length;

    const metrics: LoadTestMetrics = {
        totalConnections: numConcurrentSessions,
        totalMessages,
        totalDuration,
        avgResponseTime,
        successfulSessions,
        failedSessions,
        cacheHitsObserved: 0 // This would need server-side tracking
    };

    return metrics;
}

async function runProgressiveLoadTest() {
    console.log("📈 Running progressive load test...\n");

    const testSizes = [1, 3, 5, 8];
    const results: { size: number; metrics: LoadTestMetrics }[] = [];

    for (const size of testSizes) {
        console.log(`Testing with ${size} concurrent connections...`);

        try {
            const metrics = await runLoadTest(size);
            results.push({ size, metrics });

            console.log(`✅ Completed ${size} sessions:`);
            console.log(`   Success rate: ${((metrics.successfulSessions / metrics.totalConnections) * 100).toFixed(1)}%`);
            console.log(`   Avg response time: ${metrics.avgResponseTime.toFixed(0)}ms`);
            console.log(`   Total messages: ${metrics.totalMessages}`);
            console.log("");

            // Cool down between tests
            await delay(3000);
        } catch (error) {
            console.log(`❌ Failed at ${size} sessions:`, error);
            break;
        }
    }

    // Summary
    console.log("📊 Load Test Summary:");
    console.log("====================");
    results.forEach(({ size, metrics }) => {
        const successRate = ((metrics.successfulSessions / metrics.totalConnections) * 100).toFixed(1);
        console.log(`${size} sessions: ${successRate}% success, ${metrics.avgResponseTime.toFixed(0)}ms avg`);
    });

    // Performance analysis
    if (results.length >= 2) {
        const first = results[0].metrics;
        const last = results[results.length - 1].metrics;
        const scalingEfficiency = (first.avgResponseTime / last.avgResponseTime) * 100;

        console.log(`\n📈 Scaling Analysis:`);
        console.log(`Efficiency: ${scalingEfficiency.toFixed(1)}% (higher is better)`);
        if (scalingEfficiency > 80) {
            console.log(`🎉 Excellent scaling! The optimizations are working well.`);
        } else if (scalingEfficiency > 60) {
            console.log(`👍 Good scaling performance.`);
        } else {
            console.log(`⚠️ Scaling could be improved.`);
        }
    }
}

// Memory usage test
async function runMemoryTest() {
    console.log("🧠 Running memory stress test...");

    const initialMemory = process.memoryUsage();
    console.log(`Initial memory: ${Math.round(initialMemory.heapUsed / 1024 / 1024)}MB`);

    // Run a load test and monitor memory
    await runLoadTest(3);

    const finalMemory = process.memoryUsage();
    console.log(`Final memory: ${Math.round(finalMemory.heapUsed / 1024 / 1024)}MB`);

    const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
    console.log(`Memory increase: ${Math.round(memoryIncrease / 1024 / 1024)}MB`);

    if (memoryIncrease < 50 * 1024 * 1024) { // Less than 50MB increase
        console.log("✅ Memory usage looks good!");
    } else {
        console.log("⚠️ High memory usage detected. Check for leaks.");
    }
}

async function main() {
    try {
        // Wait for server to be ready
        await delay(2000);

        // Run comprehensive tests
        await runProgressiveLoadTest();
        await delay(2000);
        await runMemoryTest();

        console.log("\n🏁 All load tests completed!");
    } catch (error) {
        console.error("❌ Load test failed:", error);
    }
}

main().catch(console.error);
