// Smoke exercising the four additions in v0.3.0:
//   #1 pauseState.exception populated
//   #2 debug_eval defaults to first user frame
//   #5 debug_patch_source replaces a function body live
//   #6 debug_coverage returns per-line executed/missed data

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const fixturePath = resolve(here, "..", "fixtures", "showcase", "server.cjs");

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

  console.log("=== launch with exception BP filtered to TypeError ===");
  console.log(text(await call("debug_launch", {
    script: fixturePath, stopOnEntry: false, followChildren: "off",
    // Direct LaunchOption (also exposed as debug_run_tests's exceptionPause):
    // not on debug_launch's surface — set after launch instead.
  })));

  console.log("\n=== set_exception_breakpoint state:'all' filter:['TypeError'] ===");
  console.log(text(await call("debug_set_exception_breakpoint", { state: "all", filter: ["TypeError"] })));

  console.log("\n=== wait_for_pause (should pause on TypeError throw inside `thrower`) ===");
  console.log(text(await call("debug_wait_for_pause", { timeoutMs: 5000 })));

  console.log("\n=== #2: debug_eval 'x' WITHOUT frameOrdinal — should pick the user frame, returning 20 ===");
  console.log(text(await call("debug_eval", { expression: "x" })));

  console.log("\n=== continue to resume past the throw ===");
  console.log(text(await call("debug_continue", { waitForPause: false })));
  await wait(300);

  console.log("\n=== #5: debug_patch_source — fix the off-by-one in `add` ===");
  const newSource = readFileSync(fixturePath, "utf8").replace("a + b + 1", "a + b");
  console.log(text(await call("debug_patch_source", { file: fixturePath, newSource })));

  console.log("\n=== #6: debug_coverage durationMs:600 urlFilter:'showcase' ===");
  console.log(text(await call("debug_coverage", { durationMs: 600, urlFilter: "showcase" })));

  console.log("\n=== disconnect ===");
  console.log(text(await call("debug_disconnect", { kill: true })));
  mcp.kill();
}

main().catch((err) => { console.error(err); mcp.kill(); process.exit(1); });
