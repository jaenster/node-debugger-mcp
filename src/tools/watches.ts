import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asToolResult } from "../encoding.js";
import { sessions } from "../session-manager.js";

export function registerWatchTools(server: McpServer): void {
  server.registerTool(
    "debug_add_watch",
    {
      title: "debug_add_watch",
      description:
        "Add a watch expression. Re-evaluated on every pause (against the top frame, or globally if not paused) and included in the PauseSnapshot's `watches` array so the caller sees the value at each pause.",
      inputSchema: {
        sessionId: z.string().optional(),
        expression: z.string(),
      },
    },
    async ({ sessionId, expression }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const rec = session.addWatch(expression);
      return asToolResult({ id: rec.id, expression: rec.expression });
    },
  );

  server.registerTool(
    "debug_remove_watch",
    {
      title: "debug_remove_watch",
      description: "Remove a watch by its id.",
      inputSchema: {
        sessionId: z.string().optional(),
        watchId: z.string(),
      },
    },
    async ({ sessionId, watchId }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const removed = session.removeWatch(watchId);
      return asToolResult({ removed, watchId });
    },
  );

  server.registerTool(
    "debug_list_watches",
    {
      title: "debug_list_watches",
      description:
        "List all watches on a session. Values are reported as of the last pause (see PauseSnapshot.watches).",
      inputSchema: {
        sessionId: z.string().optional(),
      },
    },
    async ({ sessionId }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      return asToolResult({
        watches: session.listWatches(),
        lastValues: session.pauseState?.watches ?? [],
      });
    },
  );
}
