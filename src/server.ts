import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { asToolResult, getFormat } from "./encoding.js";
import { installStdoutGuard } from "./util/stdout-guard.js";
import { log } from "./util/log.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerBreakpointTools } from "./tools/breakpoints.js";
import { registerExecutionTools } from "./tools/execution.js";
import { registerInspectionTools } from "./tools/inspection.js";
import { registerWatchTools } from "./tools/watches.js";
import { registerOutputTools } from "./tools/output.js";
import { maybeRegisterRawTool } from "./tools/raw.js";

// CLI dispatch: when invoked with a subcommand (install/uninstall/doctor)
// we delegate to the CLI module and exit. With no subcommand we start the
// MCP server on stdio — this is the path Claude Code uses.
const subcommand = process.argv[2];
if (
  subcommand === "install" ||
  subcommand === "uninstall" ||
  subcommand === "doctor" ||
  subcommand === "help" ||
  subcommand === "--help" ||
  subcommand === "-h"
) {
  const { runCli } = await import("./cli.js");
  await runCli(subcommand, process.argv.slice(3));
  // runCli always exits, but TS doesn't know that — guard for safety.
  process.exit(0);
}

installStdoutGuard();

// Injected by tsup at build time (see tsup.config.ts `define`). Falls back to
// "dev" when running an unbundled file (e.g. via tsx / vitest).
declare const __PKG_VERSION__: string;
const VERSION =
  typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";

const server = new McpServer({
  name: "node-debugger-mcp",
  version: VERSION,
});

server.registerTool(
  "debug_ping",
  {
    title: "debug_ping",
    description:
      "Health check. Returns server name, version, the active response format (toon|json), and a tabular array of fixture rows so a caller can verify TOON tabular encoding works end-to-end.",
    inputSchema: { message: z.string().optional() },
  },
  async ({ message }) => {
    const payload = {
      ok: true,
      name: "node-debugger-mcp",
      version: VERSION,
      format: getFormat(),
      echo: message ?? null,
      ts: new Date().toISOString(),
      fixtures: [
        { id: 1, name: "alpha", value: 100 },
        { id: 2, name: "beta", value: 200 },
        { id: 3, name: "gamma", value: 300 },
      ],
    };
    return asToolResult(payload);
  },
);

registerSessionTools(server);
registerBreakpointTools(server);
registerExecutionTools(server);
registerInspectionTools(server);
registerWatchTools(server);
registerOutputTools(server);
maybeRegisterRawTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);
log.info("node-debugger-mcp ready");
