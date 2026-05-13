// CLI dispatch for one-liner install / uninstall / doctor.
// Invoked when `node-debugger-mcp <subcommand>` is run (typically via npx).
// When the bin is run with NO subcommand, the MCP server starts instead —
// see src/server.ts.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const NAME = "node-debugger";
const PKG_NAME = "@jaenster/node-debugger-mcp";

interface InstallOpts {
  scope: "user" | "local" | "project";
  allowRaw: boolean;
  pinVersion?: string;
}

function parseFlags(argv: string[]): InstallOpts {
  const opts: InstallOpts = { scope: "user", allowRaw: false };
  for (const a of argv) {
    if (a === "--allow-raw") opts.allowRaw = true;
    else if (a === "--scope=user") opts.scope = "user";
    else if (a === "--scope=local") opts.scope = "local";
    else if (a === "--scope=project") opts.scope = "project";
    else if (a.startsWith("--pin=")) opts.pinVersion = a.slice("--pin=".length);
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`unknown flag: ${a} (try --help)\n`);
      process.exit(1);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  npx -y ${PKG_NAME} install [flags]
  npx -y ${PKG_NAME} uninstall [--scope=user|local|project]
  npx -y ${PKG_NAME} doctor

Install flags:
  --allow-raw           Expose the gated debug_cdp_raw escape hatch
                        (sets MCP_DEBUGGER_ALLOW_RAW=1).
  --scope=<scope>       claude mcp add scope: user | local | project (default: user).
  --pin=<version>       Pin to a specific package version (default: latest).

The install command registers this MCP with Claude Code so future sessions
spawn it via \`npx -y ${PKG_NAME}\` automatically — no global install needed.

After install, run \`/mcp\` in an open Claude Code session to reconnect, or
restart the session to pick up the new tools.
`);
}

function which(cmd: string): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim().split("\n")[0] || null;
}

function run(cmd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function packageVersion(): string {
  // Resolve our own package.json relative to this file. When bundled as a
  // single dist/server.js, this file lives next to it; package.json is one
  // level up.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    pathResolve(here, "..", "package.json"),
    pathResolve(here, "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return "unknown";
}

function commandInstall(opts: InstallOpts): never {
  if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") {
    process.stderr.write(`error: unsupported platform '${process.platform}'\n`);
    process.exit(1);
  }

  const claudeBin = which("claude");
  if (!claudeBin) {
    process.stderr.write(
      `error: \`claude\` CLI not found on PATH.\nInstall Claude Code first, then re-run this command.\n`,
    );
    process.exit(1);
  }

  const nodeMajor = parseInt(process.versions.node.split(".")[0]!, 10);
  if (nodeMajor < 20) {
    process.stderr.write(`error: node ${process.versions.node} is too old; need >= 20\n`);
    process.exit(1);
  }

  process.stdout.write(`==> registering ${NAME} with claude mcp (scope=${opts.scope})\n`);

  // Idempotent: remove first, ignore failure (it may not exist yet).
  run("claude", ["mcp", "remove", "-s", opts.scope, NAME]);

  const pkgSpec = opts.pinVersion ? `${PKG_NAME}@${opts.pinVersion}` : PKG_NAME;
  const args = ["mcp", "add", "-s", opts.scope];
  if (opts.allowRaw) {
    args.push("-e", "MCP_DEBUGGER_ALLOW_RAW=1");
  }
  // `--` so `claude mcp add` stops parsing its own flags and treats the rest
  // as the subprocess command + args.
  args.push(NAME, "--", "npx", "-y", pkgSpec);

  const result = run("claude", args);
  if (result.code !== 0) {
    process.stderr.write(`error: claude mcp add failed:\n${result.err || result.out}\n`);
    process.exit(result.code || 1);
  }
  process.stdout.write(result.out);

  process.stdout.write(`
==> installed. Verify with:  claude mcp list

   In an open Claude Code session, run /mcp to reconnect.
   Otherwise the tools appear on next session start.
`);
  process.exit(0);
}

function commandUninstall(opts: { scope: InstallOpts["scope"] }): never {
  const claudeBin = which("claude");
  if (!claudeBin) {
    process.stderr.write(`error: \`claude\` CLI not found on PATH\n`);
    process.exit(1);
  }
  const r = run("claude", ["mcp", "remove", "-s", opts.scope, NAME]);
  process.stdout.write(r.out);
  if (r.code !== 0) {
    process.stderr.write(r.err);
    process.exit(r.code || 1);
  }
  process.stdout.write(`==> uninstalled (scope=${opts.scope}).\n`);
  process.exit(0);
}

function commandDoctor(): never {
  const claudeBin = which("claude");
  const ver = packageVersion();
  process.stdout.write(`node-debugger-mcp doctor

  package:        ${PKG_NAME} @ ${ver}
  node:           ${process.versions.node}
  platform:       ${process.platform} ${process.arch}
  claude CLI:     ${claudeBin ?? "NOT FOUND ON PATH"}
`);
  if (claudeBin) {
    const r = run("claude", ["mcp", "list"]);
    const hit = (r.out ?? "")
      .split("\n")
      .find((l) => l.includes(NAME));
    process.stdout.write(`  registration:   ${hit ? hit.trim() : "not registered"}\n`);
  }
  process.exit(0);
}

export async function runCli(subcommand: string, argv: string[]): Promise<void> {
  switch (subcommand) {
    case "install":
      commandInstall(parseFlags(argv));
      break;
    case "uninstall":
      commandUninstall({ scope: parseFlags(argv).scope });
      break;
    case "doctor":
      commandDoctor();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      process.exit(0);
      break;
    default:
      process.stderr.write(`unknown subcommand: ${subcommand} (try --help)\n`);
      process.exit(1);
  }
}
