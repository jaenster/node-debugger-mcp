// Worker thread body — loops continuously so the MCP smoke has time to attach
// and set a BP that will actually hit. Exits after 30 iterations or on
// parentPort 'stop' message.

import { parentPort } from "node:worker_threads";

let n = 0;
function step() {
  n++; // BP TARGET — V8 line 6 (0-indexed)
  if (n >= 30) {
    clearInterval(timer);
    parentPort?.postMessage({ done: true, n });
  }
}
const timer = setInterval(step, 200);
parentPort?.on("message", (m) => {
  if (m === "stop") {
    clearInterval(timer);
    parentPort?.postMessage({ done: true, n });
  }
});
