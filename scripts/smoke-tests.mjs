// Smoke for debug_run_tests against a node:test fixture.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const testPath = resolve(here, "..", "fixtures", "tests", "sample.test.js");

let nextId = 1;
const pending = new Map();
const mcp = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
const out = createInterface({ input: mcp.stdout });
out.on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg); pending.delete(msg.id);
  }
});
const rpc = (method, params) => {
  const id = nextId++;
  return new Promise((r) => {
    pending.set(id, { resolve: r });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
  });
};
const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r);

async function main() {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "s", version: "0" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await wait(50);

  console.log("=== debug_run_tests (pauseOnFailure: default true) ===");
  console.log(text(await call("debug_run_tests", { pattern: [testPath] })));

  console.log("\n=== wait_for_any_pause (the AssertionError fires in a CHILD subprocess) ===");
  const pauseRes = await call("debug_wait_for_any_pause", { timeoutMs: 10000 });
  console.log(text(pauseRes));

  // Extract sessionId from the response for the follow-up eval.
  const pauseText = pauseRes.result?.content?.[0]?.text ?? "";
  const sidMatch = pauseText.match(/sessionId:\s*(\S+)/);
  if (sidMatch) {
    const sid = sidMatch[1];
    console.log(`\n=== eval 'x' on the paused session (${sid}) ===`);
    console.log(text(await call("debug_eval", { sessionId: sid, expression: "x" })));

    console.log(`\n=== continue ${sid} ===`);
    console.log(text(await call("debug_continue", { sessionId: sid, waitForPause: false })));
  }

  await wait(800);

  console.log("\n=== disconnect ===");
  console.log(text(await call("debug_disconnect", { kill: true })));
  mcp.kill();
}

main().catch((err) => { console.error(err); mcp.kill(); process.exit(1); });
