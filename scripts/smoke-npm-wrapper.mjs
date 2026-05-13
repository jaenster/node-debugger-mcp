// Smoke: prove `command:["npm","run",...]` results in BOTH an npm session
// (overhead, ignorable) AND a child node session (the actual work).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "server.js");

// Materialise a tiny npm package in /tmp.
const demoDir = "/tmp/ndb-npm-demo";
mkdirSync(demoDir, { recursive: true });
writeFileSync(`${demoDir}/package.json`, JSON.stringify({
  name: "ndb-npm-demo", type: "module",
  scripts: { "run-it": "node ./worker.js" }
}, null, 2));
writeFileSync(`${demoDir}/worker.js`, `
let n = 0;
const t = setInterval(() => {
  n++;
  if (n > 30) { clearInterval(t); process.exit(0); }
}, 100);
console.log("worker started, pid:", process.pid);
`);

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

  console.log("=== launch ['npm','run','run-it'] from", demoDir, "===");
  console.log(text(await call("debug_launch", {
    command: ["npm", "run", "run-it"],
    cwd: demoDir,
    stopOnEntry: false,
    followChildren: "noBreak",
  })));

  await wait(1500);

  console.log("\n=== list_sessions (should show npm + worker child) ===");
  console.log(text(await call("debug_list_sessions", {})));

  console.log("\n=== root session captured stderr (both announces should be here) ===");
  console.log(text(await call("debug_get_output", { sessionId: "s1", stream: "stderr", tail: 30 })));

  console.log("\n=== disconnect ===");
  console.log(text(await call("debug_disconnect", { sessionId: "s1", kill: true, cascade: true })));
  mcp.kill();
}

main().catch((err) => { console.error(err); mcp.kill(); process.exit(1); });
