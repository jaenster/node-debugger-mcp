import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asToolResult } from "../encoding.js";
import { sessions } from "../session-manager.js";

export function registerInspectionTools(server: McpServer): void {
  server.registerTool(
    "debug_eval",
    {
      title: "debug_eval",
      description:
        "Evaluate a JS expression. If the session is paused, evaluation runs in the call-frame scope (defaults to top frame, frameOrdinal=0). If not paused, runs in the global Runtime context. Returns a shaped value with `localObjectId` for further drill-in via debug_get_properties.",
      inputSchema: {
        sessionId: z.string().optional(),
        expression: z.string(),
        frameOrdinal: z.number().int().nonnegative().optional(),
        returnByValue: z.boolean().optional().default(false),
      },
    },
    async ({ sessionId, expression, frameOrdinal, returnByValue }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.evaluate({ expression, frameOrdinal, returnByValue });
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_get_stack",
    {
      title: "debug_get_stack",
      description:
        "Return the current pause's call stack. By default hides node-internal frames (URLs starting with `node:`) and caps at maxFrames. PauseSnapshot.frames is capped at 5 for context-efficiency; this tool gives you the full list when you need it.",
      inputSchema: {
        sessionId: z.string().optional(),
        includeNodeInternals: z.boolean().optional().default(false),
        maxFrames: z.number().int().positive().optional(),
      },
    },
    async ({ sessionId, includeNodeInternals, maxFrames }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      if (!session.pauseState) return asToolResult({ error: "session is not paused" });
      const all = session.stackFromCurrentFrames({ includeNodeInternals });
      const sliced = maxFrames !== undefined ? all.slice(0, maxFrames) : all;
      return asToolResult({
        frames: sliced,
        totalFrames: all.length,
        ...(session.pauseState.hiddenInternalFrames
          ? { hiddenInternalFrames: session.pauseState.hiddenInternalFrames }
          : {}),
      });
    },
  );

  server.registerTool(
    "debug_get_scope",
    {
      title: "debug_get_scope",
      description:
        "Flatten one scope of one frame to a key→value preview list. `scopeType` defaults to 'local'; other common values are 'closure', 'global', 'block'. Equivalent to calling debug_get_properties on the matching frame.scopes[i].localObjectId, but more convenient.",
      inputSchema: {
        sessionId: z.string().optional(),
        frameOrdinal: z.number().int().nonnegative(),
        scopeType: z.string().optional().default("local"),
      },
    },
    async ({ sessionId, frameOrdinal, scopeType }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      if (!session.pauseState) return asToolResult({ error: "session is not paused" });
      // Frame ordinals in PauseSnapshot.frames are V8-aligned (we keep the
      // V8 ordinal even when hiding internals), so a plain `.find` lets
      // Claude pass either the visible index or the V8 index.
      const frame =
        session.pauseState.frames[frameOrdinal] ??
        session.pauseState.frames.find((f) => f.ordinal === frameOrdinal);
      if (!frame) return asToolResult({ error: `no frame at ordinal ${frameOrdinal}` });
      const scope = (frame.scopes ?? []).find((s) => s.type === scopeType);
      if (!scope || !scope.localObjectId) {
        return asToolResult({
          error: `no '${scopeType}' scope on frame ${frameOrdinal}`,
          availableScopes: (frame.scopes ?? []).map((s) => s.type),
        });
      }
      const res = await session.getProperties({ localObjectId: scope.localObjectId });
      // For the local scope, prepend a synthetic `this` entry (matches the
      // way IDE debuggers present it). The `this` objectId was minted
      // alongside the scopes during onPaused.
      if (
        scopeType === "local" &&
        frame.thisLocalObjectId &&
        "properties" in res
      ) {
        const thisVal = await session.getProperties({
          localObjectId: frame.thisLocalObjectId,
          ownOnly: false,
        });
        // We want a single `this` entry showing the preview, not the inner
        // properties. Use a tiny shaped value.
        res.properties = [
          {
            name: "this",
            value: {
              type: "object",
              preview:
                "properties" in thisVal && thisVal.properties.length > 0
                  ? `Object`
                  : "undefined",
              localObjectId: frame.thisLocalObjectId,
            },
          },
          ...res.properties,
        ];
      }
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_get_properties",
    {
      title: "debug_get_properties",
      description:
        "Expand an object (referenced by localObjectId from a prior debug_eval / debug_get_scope / debug_get_stack call) into its property list. Returns previewed values; nested objects get fresh localObjectIds. NOTE: localObjectIds are invalidated when the session resumes; stale lookups return an explicit error.",
      inputSchema: {
        sessionId: z.string().optional(),
        localObjectId: z.string(),
        ownOnly: z.boolean().optional().default(true),
      },
    },
    async ({ sessionId, localObjectId, ownOnly }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.getProperties({ localObjectId, ownOnly });
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_get_source",
    {
      title: "debug_get_source",
      description:
        "Return a script's source as the runtime sees it. Pass either a V8 scriptId or a file path / file:// URL. Useful when the on-disk file has been modified after the runtime loaded it.",
      inputSchema: {
        sessionId: z.string().optional(),
        file: z.string(),
        fromLine: z.number().int().nonnegative().optional(),
        toLine: z.number().int().nonnegative().optional(),
      },
    },
    async ({ sessionId, file, fromLine, toLine }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.getScriptSource(file);
      if ("error" in res) return asToolResult(res);
      if (fromLine === undefined && toLine === undefined) {
        return asToolResult(res);
      }
      const lines = res.source.split("\n");
      const a = Math.max(0, fromLine ?? 0);
      const b = Math.min(lines.length - 1, toLine ?? lines.length - 1);
      const slice = lines
        .slice(a, b + 1)
        .map((l, i) => `${a + i + 1}: ${l}`)
        .join("\n");
      return asToolResult({ url: res.url, fromLine: a, toLine: b, source: slice });
    },
  );

  server.registerTool(
    "debug_patch_source",
    {
      title: "debug_patch_source",
      description:
        "Replace a script's source AT RUNTIME via Debugger.setScriptSource — the 'edit-and-continue' feature IDEs use. Pass the file path (or V8 scriptId) and the FULL new source. V8 restrictions: cannot change function arity, scope structure, or top-level ES module imports. Returns `status`: 'Ok' (applied) or 'CompileError' / 'BlockedByActiveGenerator' / 'BlockedByActiveFunction' / 'BlockedByTopLevelEsModuleChange' on rejection. Use `dryRun: true` to verify the edit would apply without changing anything. `allowTopFrameEditing: true` lets you replace the body of the function currently on top of the call stack — the only function that's normally blocked because it's executing.",
      inputSchema: {
        sessionId: z.string().optional(),
        file: z.string().describe("File path, file:// URL, or V8 scriptId of the script to patch."),
        newSource: z.string().describe("The complete new source for the script."),
        dryRun: z.boolean().optional().default(false),
        allowTopFrameEditing: z.boolean().optional().default(false),
      },
    },
    async ({ sessionId, file, newSource, dryRun, allowTopFrameEditing }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.patchScriptSource({ file, newSource, dryRun, allowTopFrameEditing });
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_cpu_profile",
    {
      title: "debug_cpu_profile",
      description:
        "Record a CPU profile for `durationMs` and return the top-N hottest functions by sample count (≈ self-time). The full profile is processed server-side so the response stays small. Use to answer 'why is this slow?' Cost: ~0 — V8's sampling profiler is cheap.",
      inputSchema: {
        sessionId: z.string().optional(),
        durationMs: z.number().int().positive().default(2000),
        topN: z.number().int().positive().optional().default(20),
        includeNodeInternals: z.boolean().optional().default(false),
      },
    },
    async ({ sessionId, durationMs, topN, includeNodeInternals }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.cpuProfile({ durationMs, topN, includeNodeInternals });
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_coverage",
    {
      title: "debug_coverage",
      description:
        "Capture per-line code coverage during `durationMs` of execution. Returns, for each matching script: total lines, executed lines, missed lines (with their line numbers, 1-indexed), and a coverage percentage. Different from debug_cpu_profile (sampling-based, hottest functions) and from debug_trace_stop (function-level call counts) — this gives you the per-line execution map. Answers 'is my test actually exercising the code I think?'.",
      inputSchema: {
        sessionId: z.string().optional(),
        durationMs: z.number().int().positive().default(2000),
        urlFilter: z.string().optional(),
        includeNodeInternals: z.boolean().optional().default(false),
      },
    },
    async ({ sessionId, durationMs, urlFilter, includeNodeInternals }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.coverage({ durationMs, urlFilter, includeNodeInternals });
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_heap_snapshot",
    {
      title: "debug_heap_snapshot",
      description:
        "Take a V8 heap snapshot and write it to disk (defaults to /tmp/ndb-heap-<session>-<ts>.heapsnapshot). The full snapshot is too big to return inline — load the file in Chrome DevTools → Memory tab for the full retainer-path UI. Returns the file path + a class-level summary (top-N classes by instance count + their total self-size).",
      inputSchema: {
        sessionId: z.string().optional(),
        savePath: z.string().optional(),
      },
    },
    async ({ sessionId, savePath }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.heapSnapshot({ savePath });
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_trace_start",
    {
      title: "debug_trace_start",
      description:
        "Start a function-execution trace using V8's precise coverage profiler. Cheap (~no overhead) — records which functions get called, how many times. Stop with debug_trace_stop to get the ranked list. Useful for 'what actually ran when this happens' on unfamiliar code.",
      inputSchema: {
        sessionId: z.string().optional(),
      },
    },
    async ({ sessionId }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      await session.startExecutionTrace();
      return asToolResult({ tracing: true });
    },
  );

  server.registerTool(
    "debug_trace_stop",
    {
      title: "debug_trace_stop",
      description:
        "Stop the function-execution trace started by debug_trace_start. Returns the top-N functions ranked by invocation count (default top 50), filtered to non-node-internal scripts by default. Each entry includes the script URL, function name, call count, and start/end character offsets (use debug_get_source for the surrounding lines).",
      inputSchema: {
        sessionId: z.string().optional(),
        topN: z.number().int().positive().optional().default(50),
        urlFilter: z.string().optional(),
        includeNodeInternals: z.boolean().optional().default(false),
      },
    },
    async ({ sessionId, topN, urlFilter, includeNodeInternals }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.stopExecutionTrace({ topN, urlFilter, includeNodeInternals });
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_event_loop_status",
    {
      title: "debug_event_loop_status",
      description:
        "Snapshot of what's currently holding the Node event loop open. Returns active handles (timers, sockets, file descriptors, child processes, servers, intervals) and active requests (in-flight async ops), plus uptime and event-loop utilization. Each handle/request has a `localObjectId` so you can drill into it with debug_get_properties. Use this when a script won't exit or for diagnosing event-loop holds.",
      inputSchema: {
        sessionId: z.string().optional(),
      },
    },
    async ({ sessionId }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.getEventLoopStatus();
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_get_async_context",
    {
      title: "debug_get_async_context",
      description:
        "Find every live AsyncLocalStorage instance in the target's heap and return its current .getStore() value. Useful for inspecting request-scoped context (trace IDs, tenant info, user) in HTTP servers, framework middleware, etc. Returns one entry per instance with `index`, `store` (or `error` if .getStore() threw). Cost: one Runtime.queryObjects roundtrip (non-trivial on large heaps).",
      inputSchema: {
        sessionId: z.string().optional(),
      },
    },
    async ({ sessionId }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const res = await session.getAsyncContext();
      return asToolResult(res);
    },
  );

  server.registerTool(
    "debug_list_scripts",
    {
      title: "debug_list_scripts",
      description:
        "List loaded scripts the runtime knows about. By default filters out node-internal scripts (node:* URLs). Use this to discover which URL pattern to set a breakpoint against.",
      inputSchema: {
        sessionId: z.string().optional(),
        includeNodeInternals: z.boolean().optional().default(false),
        urlFilter: z.string().optional(),
      },
    },
    async ({ sessionId, includeNodeInternals, urlFilter }) => {
      const session = sessions.resolve(sessionId);
      if (!session) return asToolResult({ error: "no such session" });
      const scripts = session.listScripts({ includeNodeInternals, urlFilter });
      return asToolResult({ scripts });
    },
  );
}
