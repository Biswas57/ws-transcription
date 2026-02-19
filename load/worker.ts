// load/worker.ts
import { parentPort, workerData } from "worker_threads";
import { virtualUser, VuResult, VuConfig } from "./scenario.js";

(async () => {
    const cfg: VuConfig = workerData.cfg;
    const runs: VuResult[] = [];
    for (let i = 0; i < workerData.vus; i++) {
        runs.push(await virtualUser({ ...cfg, id: i }));
    }
    parentPort!.postMessage(runs);
})();
