// load/run.ts
import { program } from "commander";
import { Worker } from "worker_threads";
import { build } from "hdr-histogram-js";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { performance } from "perf_hooks";
import dotenv from "dotenv";
import type { VuResult } from "./scenario.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const argv = process.argv[2] === "--" ? process.argv.slice(0, 2).concat(process.argv.slice(3)) : process.argv;

program
  .option("-c, --concurrency <n>", "max concurrent sessions", "50")
  .option("-d, --duration <s>", "test duration per wave in seconds", "60")
  .option("-r, --ramp <n>", "waves (1,2,4..×n)", "4")
  .option("--chaos", "enable random bad frames", false)
  .option("--url <ws>", "server ws url", process.env.WS_URL ?? "ws://localhost:5551")
  .parse(argv);

const opts = program.opts();
let audio: Buffer;

interface WaveMetrics {
  vus: number;
  ok: number;
  fail: number;
  p50: number;
  p95: number;
  p99: number;
  failures: string[];
}

async function runWave(vus: number, audio: Buffer): Promise<WaveMetrics> {
  const perWorker = 20;             // spin ≤20 VUs per worker to avoid 1k sockets per thread
  const workers: Promise<VuResult[]>[] = [];
  for (let i = 0; i < vus; i += perWorker) {
    const batch = Math.min(perWorker, vus - i);
    workers.push(
      new Promise<VuResult[]>((res) => {
        // Use the compiled worker.js file in the same directory
        const workerPath = path.join(__dirname, "worker.js");
        const w = new Worker(workerPath, {
          workerData: {
            vus: batch,
            idOffset: i,
            cfg: {
              audio,
              serverUrl: opts.url,
              maxDuration: Number(opts.duration) * 1000,
              chaos: opts.chaos,
            },
          },
        });
        w.on("message", res);
        w.on("error", (err) => {
          console.error("Worker error:", err);
          res(Array.from({ length: batch }, (_, n): VuResult => ({
            id: i + n,
            endReason: "client-error",
            failure: `Worker error: ${err instanceof Error ? err.message : String(err)}`,
            msgs: 0,
            latencyMs: [],
          })));
        });
      })
    );
  }
  const results = (await Promise.all(workers)).flat();

  const hist = build({ lowestDiscernibleValue: 1, highestTrackableValue: 60000, numberOfSignificantValueDigits: 3 });
  let ok = 0,
    fail = 0;
  const failures: string[] = [];

  results.forEach((r) => {
    (r.latencyMs as number[]).forEach((l) => hist.recordValue(Math.round(l)));
    if (r.endReason === "ok") {
      ok++;
    } else {
      fail++;
      failures.push(`VU ${r.id}: ${r.endReason}${r.failure ? ` — ${r.failure}` : ""}`);
    }
  });

  return {
    vus,
    ok,
    fail,
    p50: hist.getValueAtPercentile(50),
    p95: hist.getValueAtPercentile(95),
    p99: hist.getValueAtPercentile(99),
    failures,
  };
}

(async () => {
  // Load shared audio fixture from source directory since it is not copied to dist.
  audio = await fs.readFile(path.join(__dirname, "../../test/fixtures/sample.webm"));

  console.log(chalk.blue("🔥 Starting extensive WebSocket load test..."));
  console.log(chalk.gray(`Server: ${opts.url}`));
  console.log(chalk.gray("Note: start the transcription server separately before running load tests."));
  console.log(chalk.gray(`Max concurrency: ${opts.concurrency}`));
  console.log(chalk.gray(`Duration per wave: ${opts.duration}s`));
  console.log(chalk.gray(`Chaos mode: ${opts.chaos ? "enabled" : "disabled"}`));

  const waves = Number(opts.ramp);
  const results: WaveMetrics[] = [];

  for (let i = 0; i < waves; i++) {
    const vus = Math.pow(2, i + 1);                // 2,4,8,16,...
    if (vus > Number(opts.concurrency)) break;

    console.log(chalk.cyan(`\n🚀 Wave ${i + 1}: ${vus} concurrent users`));
    const t0 = performance.now();

    try {
      const m = await runWave(vus, audio);
      results.push(m);
      const t1 = ((performance.now() - t0) / 1000).toFixed(1);

      console.log(
        chalk.green(
          `✓ ${m.ok}/${m.vus} ok  •  p50 ${m.p50} ms  p95 ${m.p95} ms  p99 ${m.p99} ms  •  ${t1}s`
        )
      );
      if (m.fail) {
        console.log(chalk.red(`✗ ${m.fail} failures`));
        m.failures.forEach((failure) => console.log(chalk.red(`  - ${failure}`)));
      }
    } catch (error) {
      console.error(chalk.red(`❌ Wave ${i + 1} failed:`, error));
      break;
    }

    await new Promise((r) => setTimeout(r, 3000));   // cool-down
  }

  // Final summary
  console.log(chalk.blue("\n📊 Load Test Summary:"));
  console.log(chalk.blue("====================="));
  results.forEach((r, i) => {
    const successRate = ((r.ok / r.vus) * 100).toFixed(1);
    console.log(`Wave ${i + 1} (${r.vus} users): ${successRate}% success, p95: ${r.p95}ms`);
  });
})();
