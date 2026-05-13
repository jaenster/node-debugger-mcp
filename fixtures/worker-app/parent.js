// Worker-thread fixture: spawns a worker_threads.Worker and waits for it to finish.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
console.log("parent starting, pid:", process.pid);

const w = new Worker(resolve(here, "worker.js"));
w.on("message", (m) => console.log("from worker:", m));
w.on("exit", (code) => {
  console.log("worker exited with", code);
  process.exit(code ?? 0);
});
