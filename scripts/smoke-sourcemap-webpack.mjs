// Verify webpack-style sourcemap handling + disk fallback for null sourcesContent.
//
// Builds a fixture where:
//   - dist/compute.js: real tsc-compiled JS
//   - dist/compute.js.map: tsc mappings BUT sources=['webpack:///./src/compute.ts']
//                          and sourcesContent omitted
//   - src/compute.ts: the original (used via disk fallback for snippets)
//
// Set a BP at the original `src/compute.ts:N`. Expect forward-map to find the
// webpack-style source, set BP at the compiled URL, hit it, and the pause
// snapshot to carry both compiled + original positions plus a snippet from
// disk.

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");

// Build the fixture into a temp dir.
const buildRes = spawnSync(
  process.execPath,
  [resolve(here, "..", "fixtures", "sourcemaps", "build-webpack-style.mjs")],
  { encoding: "utf8" },
);
if (buildRes.status !== 0) {
  console.error("fixture build failed:", buildRes.stderr || buildRes.stdout);
  process.exit(1);
}
const fixture = JSON.parse(buildRes.stdout);
console.log("fixture built at:", fixture.outDir);

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

  console.log("=== launch the bundle (stopOnEntry so the sourcemap is loaded before we set BP) ===");
  console.log(text(await call("debug_launch", { script: fixture.bundle, stopOnEntry: true, followChildren: "off" })));

  // Set BP at the *original TS* file, line where `const sum = x + y;` lives.
  // In our fixture's compute.ts, that's V8 line 2 (0-indexed).
  console.log(`\n=== set BP at original TS source: ${fixture.source}:2 (V8 0-indexed) ===`);
  console.log(text(await call("debug_set_breakpoint", { file: fixture.source, line: 2 })));

  console.log("\n=== continue → expect pause with both compiled + original positions, snippet from disk ===");
  console.log(text(await call("debug_continue", { waitForPause: true, timeoutMs: 5000 })));

  console.log("\n=== eval 'x + y' on the user frame ===");
  console.log(text(await call("debug_eval", { expression: "x + y" })));

  console.log("\n=== continue + disconnect ===");
  console.log(text(await call("debug_continue", { waitForPause: false })));
  console.log(text(await call("debug_disconnect", { kill: true })));
  mcp.kill();
}

main().catch((err) => { console.error(err); mcp.kill(); process.exit(1); });
