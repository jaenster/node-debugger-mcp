import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asToolResult } from "../encoding.js";
import { sessions } from "../session-manager.js";
import { log } from "../util/log.js";

/**
 * Gated CDP escape hatch. Registered only when MCP_DEBUGGER_ALLOW_RAW=1 is
 * set at server startup — keeps Claude from defaulting to raw CDP when a
 * higher-level wrapper has a small bug.
 */
export function maybeRegisterRawTool(server: McpServer): void {
  if (process.env.MCP_DEBUGGER_ALLOW_RAW !== "1") {
    log.info("cdp_raw escape hatch DISABLED (set MCP_DEBUGGER_ALLOW_RAW=1 to enable)");
    return;
  }
  log.info("cdp_raw escape hatch ENABLED");

  server.registerTool(
    "debug_cdp_raw",
    {
      title: "debug_cdp_raw",
      description:
        "Send an arbitrary V8 Inspector Protocol command. Use ONLY when a higher-level wrapper doesn't cover what you need. Method is a fully qualified CDP method (e.g. 'Debugger.evaluateOnCallFrame', 'Runtime.queryObjects'). Result is the raw CDP response. Gated behind MCP_DEBUGGER_ALLOW_RAW=1.",
      inputSchema: {
        sessionId: z.string().optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ sessionId, method, params }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      try {
        const result = await session.cdp.send(method, params ?? {});
        return asToolResult({ method, result });
      } catch (e) {
        return asToolResult({ method, error: String(e) });
      }
    },
  );
}
