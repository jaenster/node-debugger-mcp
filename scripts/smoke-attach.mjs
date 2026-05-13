// Smoke for step 9: attach to an externally-launched node --inspect process.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const fixturePath = resolve(here, "..", "fixtures", "long-runner.js");

// 1) Spawn the target externally (NOT via debug_launch) with --inspect=0
const target = spawn(process.execPath, ["--inspect=0", fixturePath], {
  stdio: ["ignore", "pipe", "pipe"],
});

const wsUrl = await new Promise((resolveWs, rejectWs) => {
  let buf = "";
  target.stderr.on("data", (b) => {
    buf += b.toString("utf8");
    const m = buf.match(/Debugger listening on (ws:\/\/\S+)/);
    if (m) resolveWs(m[1]);
  });
  setTimeout(() => rejectWs(new Error("timeout waiting for inspector announce")), 5000);
});

console.log(`target pid=${target.pid}, wsUrl=${wsUrl}`);

// 2) Boot the MCP server
let nextId = 1;
const pending = new Map();
const mcp = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});
const out = createInterface({ input: mcp.stdout });
out.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
  });
}
const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r);

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-attach", version: "0.0.0" },
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await wait(50);

  console.log("\n=== debug_attach by url ===");
  console.log(text(await call("debug_attach", { url: wsUrl })));

  console.log("\n=== set BP at long-runner.js V8 line 5 (tick++) ===");
  console.log(text(await call("debug_set_breakpoint", { file: fixturePath, line: 5 })));

  console.log("\n=== wait_for_pause (BP should hit within ~200ms) ===");
  console.log(text(await call("debug_wait_for_pause", { timeoutMs: 3000 })));

  console.log("\n=== eval 'tick' on top frame ===");
  console.log(text(await call("debug_eval", { expression: "tick" })));

  console.log("\n=== continue (waitForPause:false), then disconnect WITHOUT killing the target ===");
  console.log(text(await call("debug_continue", { waitForPause: false })));
  await wait(200);
  console.log(text(await call("debug_disconnect", { kill: false })));

  // 3) Verify target is still alive
  console.log(`\ntarget process still alive: ${target.exitCode === null}`);

  // 4) Now kill the target ourselves
  target.kill("SIGTERM");
  mcp.kill();
}

main().catch((err) => {
  console.error(err);
  try { target.kill("SIGTERM"); } catch {}
  try { mcp.kill(); } catch {}
  process.exit(1);
});
