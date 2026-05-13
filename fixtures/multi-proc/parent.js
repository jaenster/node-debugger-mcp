// Parent process that spawns a child Node script. With followChildren auto-attach
// in the MCP, the child should appear as its own auto-session.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const childPath = resolve(here, "child.js");

console.log("parent starting, pid:", process.pid);

const child = spawn(process.execPath, [childPath], {
  stdio: ["ignore", "inherit", "inherit"],
});
child.on("exit", (code) => {
  console.log("parent: child exited with", code);
  // Keep parent alive a bit longer so the smoke can observe both sessions
  setTimeout(() => process.exit(code ?? 0), 500);
});
