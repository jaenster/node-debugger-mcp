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

installStdoutGuard();

const server = new McpServer({
  name: "node-debugger-mcp",
  version: "0.0.1",
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
      version: "0.0.1",
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
