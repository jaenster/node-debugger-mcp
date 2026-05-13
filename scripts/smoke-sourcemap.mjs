// Smoke for step 5: source-map-aware breakpoints against a tsc-compiled TS fixture.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");
const compiledFixture = resolve(here, "..", "fixtures", "ts-app", "dist", "server.js");
const tsSource = resolve(here, "..", "fixtures", "ts-app", "server.ts");

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
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-sm", version: "0.0.0" },
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await wait(50);

  console.log("=== launch compiled JS ===");
  console.log(text(await call("debug_launch", { script: compiledFixture })));

  // TS line 10 (1-indexed) = V8 0-indexed line 9 → expect to forward-map to JS line 4 (V8 0-indexed).
  console.log(`\n=== set BP at TS source: ${tsSource}:9 (V8 0-indexed, the const-out line) ===`);
  console.log(
    text(
      await call("debug_set_breakpoint", {
        file: tsSource,
        line: 9,
      }),
    ),
  );

  console.log("\n=== continue: should pause at the BP, snapshot should have original+compiled ===");
  const r = await call("debug_continue", { waitForPause: true, timeoutMs: 5000 });
  console.log(text(r));

  console.log("\n=== eval 'item' in the paused frame ===");
  console.log(text(await call("debug_eval", { expression: "item" })));

  console.log("\n=== continue to next iteration (BP should hit again) ===");
  console.log(text(await call("debug_continue", { waitForPause: true, timeoutMs: 5000 })));

  console.log("\n=== eval 'item.name' ===");
  console.log(text(await call("debug_eval", { expression: "item.name" })));

  console.log("\n=== continue (final) ===");
  console.log(text(await call("debug_continue", { waitForPause: false })));

  console.log("\n=== disconnect ===");
  console.log(text(await call("debug_disconnect", { kill: true })));

  mcp.kill();
}

main().catch((err) => {
  console.error(err);
  mcp.kill();
  process.exit(1);
});
