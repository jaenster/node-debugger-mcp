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
