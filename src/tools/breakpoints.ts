import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve as pathResolve } from "node:path";
import { z } from "zod";
import { asToolResult } from "../encoding.js";
import { sessions } from "../session-manager.js";
import { savePersisted, DEFAULT_PERSIST_FILENAME } from "../persistence.js";

export function registerBreakpointTools(server: McpServer): void {
  server.registerTool(
    "debug_set_breakpoint",
    {
      title: "debug_set_breakpoint",
      description:
        "Set a line breakpoint. Either pass file+line (path is resolved against cwd; matched against both file:// and bare absolute V8 URLs) or urlRegex+line for pattern matching across many files. Line is 0-indexed (V8 convention). Optional `condition` is a JS expression eval'd on each hit. Optional `hitCount` pauses only after N hits. `temporary: true` auto-removes after first hit.",
      inputSchema: {
        sessionId: z.string().optional(),
        file: z.string().optional(),
        line: z.number().int().nonnegative(),
        column: z.number().int().nonnegative().optional(),
        urlRegex: z.string().optional(),
        condition: z.string().optional(),
        hitCount: z.number().int().positive().optional(),
        temporary: z.boolean().optional().default(false),
      },
    },
    async ({ sessionId, file, line, column, urlRegex, condition, hitCount, temporary }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const rec = await session.setBreakpoint({
        file,
        line,
        column,
        urlRegex,
        condition,
        hitCount,
        temporary,
      });
      if ("error" in rec) return asToolResult(rec);
      return asToolResult({
        id: rec.id,
        kind: rec.kind,
        file: rec.file ?? null,
        line: rec.line ?? null,
        column: rec.column ?? null,
        condition: rec.condition ?? null,
        temporary: rec.temporary ?? false,
        resolved: rec.resolved,
      });
    },
  );

  server.registerTool(
    "debug_set_logpoint",
    {
      title: "debug_set_logpoint",
      description:
        "Set a logpoint at file:line. When hit, evaluates `expression` and logs it to the target's console (tagged with [logpoint <id>]); never pauses. If captureStack=true, the stack at the logpoint is appended. View output via debug_get_output.",
      inputSchema: {
        sessionId: z.string().optional(),
        file: z.string(),
        line: z.number().int().nonnegative(),
        column: z.number().int().nonnegative().optional(),
        expression: z.string(),
        captureStack: z.boolean().optional().default(false),
      },
    },
    async ({ sessionId, file, line, column, expression, captureStack }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const rec = await session.setLogpoint({ file, line, column, expression, captureStack });
      return asToolResult({
        id: rec.id,
        kind: rec.kind,
        file: rec.file,
        line: rec.line,
        column: rec.column ?? null,
        expression: rec.expression,
        resolved: rec.resolved,
      });
    },
  );

  server.registerTool(
    "debug_set_function_breakpoint",
    {
      title: "debug_set_function_breakpoint",
      description:
        "Break when a specific function is called. `expression` is JS that must evaluate to a function (e.g. `myUtils.parseInput`). Evaluated in the current frame if paused, else globally. The BP fires regardless of where the function is invoked from.",
      inputSchema: {
        sessionId: z.string().optional(),
        expression: z.string(),
      },
    },
    async ({ sessionId, expression }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.setFunctionBreakpoint({ expression });
      if ("error" in res) return asToolResult(res);
      return asToolResult({
        id: res.id,
        kind: res.kind,
        expression: res.expression,
      });
    },
  );

  server.registerTool(
    "debug_set_exception_breakpoint",
    {
      title: "debug_set_exception_breakpoint",
      description:
        "Configure pause-on-exception. State: 'none' (don't pause), 'caught' (pause on caught throws — expensive on try/catch-heavy code), 'uncaught' (recommended for chasing real errors), 'all' (pause on every throw). Optional `filter` is a list of exception class names — when set with state 'caught' or 'all', non-matching exceptions are auto-resumed silently (one CDP roundtrip each, so a narrow filter on noisy code can be costly). Idempotent.",
      inputSchema: {
        sessionId: z.string().optional(),
        state: z.enum(["none", "caught", "uncaught", "all"]),
        filter: z.array(z.string()).optional(),
      },
    },
    async ({ sessionId, state, filter }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      await session.setExceptionPause({ state, filter });
      return asToolResult({
        exceptionPause: state,
        filter: filter ?? null,
      });
    },
  );

  server.registerTool(
    "debug_break_on_load",
    {
      title: "debug_break_on_load",
      description:
        "Set a one-shot breakpoint at the first executable line of the first script whose URL contains `urlPattern`. Useful for catching plugin/dep init code before main runs.",
      inputSchema: {
        sessionId: z.string().optional(),
        urlPattern: z.string(),
      },
    },
    async ({ sessionId, urlPattern }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const rec = await session.setBreakOnLoad({ urlPattern });
      return asToolResult({
        id: rec.id,
        kind: rec.kind,
        urlPattern,
        resolved: rec.resolved,
      });
    },
  );

  server.registerTool(
    "debug_toggle_breakpoint",
    {
      title: "debug_toggle_breakpoint",
      description:
        "Enable or disable a breakpoint without removing its config. Useful for muting a noisy BP without losing the original definition.",
      inputSchema: {
        sessionId: z.string().optional(),
        id: z.string(),
        enabled: z.boolean(),
      },
    },
    async ({ sessionId, id, enabled }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.toggleBreakpoint(id, enabled);
      if ("error" in res) return asToolResult(res);
      return asToolResult({ id: res.id, enabled: res.enabled });
    },
  );

  server.registerTool(
    "debug_remove_breakpoint",
    {
      title: "debug_remove_breakpoint",
      description: "Remove a breakpoint by id. Works for any kind (line, logpoint, function, break_on_load).",
      inputSchema: {
        sessionId: z.string().optional(),
        id: z.string(),
      },
    },
    async ({ sessionId, id }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const removed = await session.removeBreakpoint(id);
      return asToolResult({ removed, id });
    },
  );

  server.registerTool(
    "debug_clear_breakpoints",
    {
      title: "debug_clear_breakpoints",
      description: "Remove all breakpoints (optionally filtered to one kind). The hammer.",
      inputSchema: {
        sessionId: z.string().optional(),
        kind: z.enum(["line", "logpoint", "function", "break_on_load"]).optional(),
      },
    },
    async ({ sessionId, kind }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const n = await session.clearBreakpoints(kind);
      return asToolResult({ cleared: n });
    },
  );

  server.registerTool(
    "debug_save_breakpoints",
    {
      title: "debug_save_breakpoints",
      description:
        "Write the current session's line BPs, logpoints, exception-pause config and watches to a JSON file (.node-debugger-mcp.json by default, in cwd). Future launches can opt in to loading via debug_launch({loadPersistedBreakpoints: true}). Paths in the file are stored relative to the file's directory so it's portable across machines.",
      inputSchema: {
        sessionId: z.string().optional(),
        path: z.string().optional(),
      },
    },
    async ({ sessionId, path }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const target = pathResolve(path ?? DEFAULT_PERSIST_FILENAME);
      const res = await savePersisted(session, target);
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_list_breakpoints",
    {
      title: "debug_list_breakpoints",
      description:
        "List all breakpoints on a session — line, logpoint, function-call, break_on_load — plus the current exception-pause setting if active. Includes resolved locations per BP.",
      inputSchema: {
        sessionId: z.string().optional(),
      },
    },
    async ({ sessionId }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      return asToolResult({ breakpoints: session.breakpointRecords() });
    },
  );
}
