import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asToolResult } from "../encoding.js";
import { sessions } from "../session-manager.js";
import type { RingEntry } from "../util/ring-buffer.js";

export function registerOutputTools(server: McpServer): void {
  server.registerTool(
    "debug_get_output",
    {
      title: "debug_get_output",
      description:
        "Read the target's captured output. `stream` selects 'stdout', 'stderr', 'console' (Runtime.consoleAPICalled events — also includes logpoint output), or 'all'. Pass `sinceCursor` (from a prior call's `cursor`) to get only new entries. `tail` limits to the most recent N.",
      inputSchema: {
        sessionId: z.string().optional(),
        stream: z.enum(["stdout", "stderr", "console", "all"]).optional().default("all"),
        sinceCursor: z.number().int().nonnegative().optional(),
        tail: z.number().int().positive().optional().default(200),
      },
    },
    async ({ sessionId, stream, sinceCursor, tail }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });

      const result: Record<string, unknown> = {};
      let nextCursor = sinceCursor ?? 0;

      const collect = (
        name: string,
        items: RingEntry<unknown>[],
        cursor: number,
      ): void => {
        result[name] = items.map((e) => ({
          seq: e.seq,
          ts: e.ts,
          value: e.value,
        }));
        if (cursor > nextCursor) nextCursor = cursor;
      };

      if (stream === "stdout" || stream === "all") {
        const r = session.stdout.read({ sinceCursor, tail });
        collect("stdout", r.items, r.cursor);
      }
      if (stream === "stderr" || stream === "all") {
        const r = session.stderr.read({ sinceCursor, tail });
        collect("stderr", r.items, r.cursor);
      }
      if (stream === "console" || stream === "all") {
        const r = session.console.read({ sinceCursor, tail });
        collect("console", r.items, r.cursor);
      }

      result.cursor = nextCursor;
      return asToolResult(result);
    },
  );
}
