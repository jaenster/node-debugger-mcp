import { spawn, type ChildProcess } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import { connectToWsUrl, type CdpClient } from "./cdp/client.js";
import { ObjectRegistry } from "./cdp/object-registry.js";
import {
  shapeRemoteObject,
  type RemoteObjectLike,
  type ShapedValue,
} from "./cdp/shape.js";
import { SourceMapIndex } from "./cdp/sourcemaps.js";
import { createDeferred, type Deferred } from "./util/defer.js";
import { log } from "./util/log.js";
import { RingBuffer, type RingEntry } from "./util/ring-buffer.js";
import { bootstrapShimPath } from "./util/bootstrap-path.js";

export interface ScopeRef {
  type: string;
  /** local id pointing at the scope's object via objectRegistry */
  localObjectId?: string;
}

export interface FrameSnapshot {
  ordinal: number;
  functionName: string;
  scriptId: string;
  /** Compiled URL (the URL V8 actually loaded). */
  url: string;
  /** Compiled line (0-indexed). */
  line: number;
  /** Compiled column (0-indexed). */
  column: number;
  /** Source-mapped original position, when a sourcemap covers this frame. */
  original?: { url: string; line: number; column: number };
  snippet?: string;
  scopes?: ScopeRef[];
  thisLocalObjectId?: string;
}

interface RawCallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber: number };
  url?: string;
  scopeChain?: Array<{ type: string; object: RemoteObjectLike }>;
  this?: RemoteObjectLike;
}

interface RawAsyncStackTrace {
  description?: string;
  callFrames?: Array<{
    functionName: string;
    url: string;
    lineNumber: number;
  }>;
  parent?: RawAsyncStackTrace;
}

export interface PauseSnapshot {
  reason: string;
  hitBreakpoints?: string[];
  frames: FrameSnapshot[];
  /** Number of node-internal frames hidden from `frames`. Undefined when 0. */
  hiddenInternalFrames?: number;
  /**
   * Compact async-stack summary: each entry is one async "boundary" the V8
   * inspector observed (e.g. await, setTimeout, Promise.then), with up to a
   * handful of frames each. Null when no async stack is attached.
   */
  asyncStack?: AsyncStackEntry[];
  watches?: WatchResult[];
}

export interface AsyncStackEntry {
  description: string;
  frames: { functionName: string; url: string; line: number }[];
}

export interface WatchResult {
  id: string;
  expression: string;
  value?: ShapedValue;
  error?: string;
}

export interface WatchRecord {
  id: string;
  expression: string;
}

export type SessionMode = "spawned" | "attached" | "auto" | "worker";
export type SessionStatus = "running" | "paused" | "terminated";

export interface LaunchOptions {
  /** Path to a .js/.cjs/.mjs file. Mutually exclusive with `command`. */
  script?: string;
  /** Arbitrary executable + args; uses NODE_OPTIONS for inspector injection. */
  command?: string[];
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  nodeBinary?: string;
  /** Auto-attach to descendant Node processes. Default "noBreak". */
  followChildren?: "off" | "noBreak" | "break";
  /** If true, the bootstrap shim registers process.on("unhandledRejection") → debugger; in the main thread of every Node descendant. */
  pauseOnUnhandledRejection?: boolean;
  /**
   * Apply pause-on-exceptions BEFORE the target resumes from --inspect-brk.
   * Needed to catch exceptions that fire during fast startup paths (e.g.
   * `node --test`'s assertion failures) that would otherwise race ahead of
   * a post-launch setExceptionPause call.
   */
  exceptionPause?: { state: ExceptionPauseState; filter?: string[] };
}

export interface AttachOptions {
  host?: string;
  port?: number;
  url?: string;
  pid?: number;
}

export type AutoChildHandler = (
  wsUrl: string,
) => Promise<void>;

export type BreakpointKind = "line" | "logpoint" | "function" | "break_on_load";

export interface BreakpointRecord {
  id: string;
  kind: BreakpointKind;
  file?: string;
  line?: number;
  column?: number;
  condition?: string;
  expression?: string; // for logpoint / function BP
  urlPattern?: string; // for break_on_load
  hitCount: number;
  hitCountThreshold?: number;
  temporary?: boolean;
  enabled: boolean;
  cdpBreakpointId?: string;
  resolved: Array<{ scriptId: string; url: string; line: number; column: number }>;
}

export type ExceptionPauseState = "none" | "caught" | "uncaught" | "all";

export interface ConsoleEvent {
  level: string;
  text: string;
  url?: string;
  line?: number;
}

interface ScriptEntry {
  scriptId: string;
  url: string;
  source?: string;
}

const LISTEN_RE = /Debugger listening on (ws:\/\/\S+)/;

export class Session {
  readonly id: string;
  readonly mode: SessionMode;
  readonly createdAt = new Date().toISOString();
  pid?: number;
  cmdline?: string;
  parentSessionId?: string;
  readonly childSessionIds = new Set<string>();
  child?: ChildProcess;
  cdp!: CdpClient;
  status: SessionStatus = "running";
  pauseState: PauseSnapshot | null = null;
  readonly stdout = new RingBuffer<string>(500);
  readonly stderr = new RingBuffer<string>(500);
  readonly console = new RingBuffer<ConsoleEvent>(500);
  readonly scripts = new Map<string, ScriptEntry>();
  readonly breakpoints = new Map<string, BreakpointRecord>();
  readonly objects = new ObjectRegistry();
  readonly sourceMaps = new SourceMapIndex();
  exceptionPause: ExceptionPauseState = "none";
  /** When set, exception pauses whose class is not in this list are auto-resumed silently. */
  exceptionFilter: string[] | null = null;
  readonly watches = new Map<string, WatchRecord>();
  private nextWatchId = 1;
  /** url-pattern → set of bp records (break_on_load pending matches) */
  private breakOnLoadPending: BreakpointRecord[] = [];
  /** The CDP callFrames from the current pause, keyed by ordinal. Empty when running. */
  private currentFrames: RawCallFrame[] = [];
  private cdpBpToBp = new Map<string, string>();
  private nextBpId = 1;
  private pendingPause: Deferred<PauseSnapshot | null> | null = null;
  private exitCode: number | null = null;

  constructor(id: string, mode: SessionMode) {
    this.id = id;
    this.mode = mode;
  }

  static async launch(
    id: string,
    opts: LaunchOptions,
    onAutoChild?: AutoChildHandler,
  ): Promise<Session> {
    if (!opts.script && !opts.command) {
      throw new Error("launch requires either `script` or `command`");
    }
    if (opts.script && opts.command) {
      throw new Error("launch: pass either `script` or `command`, not both");
    }

    const session = new Session(id, "spawned");
    const follow = opts.followChildren ?? "noBreak";
    const childInjectionFlag =
      follow === "off" ? null : follow === "break" ? "--inspect-brk=0" : "--inspect=0";

    let bin: string;
    let args: string[];
    const env: Record<string, string> = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;

    if (opts.pauseOnUnhandledRejection) {
      env.MCP_DEBUGGER_PAUSE_ON_UNHANDLED_REJECTION = "1";
    }

    // The bootstrap shim is --require'd into every Node descendant when
    // followChildren is on. It (1) monkeypatches worker_threads.Worker so
    // each worker also --require's it, and (2) inside workers, calls
    // inspector.open(0) so they announce on stderr like child processes.
    const shimRequire = follow !== "off" ? `--require ${bootstrapShimPath()}` : null;

    if (opts.script) {
      bin = opts.nodeBinary ?? "node";
      args = [
        "--inspect-brk=127.0.0.1:0",
        opts.script,
        ...(opts.args ?? []),
      ];
      // For `script` launch, the root is owned by us — inject NODE_OPTIONS only
      // to influence DESCENDANTS, not the root (which already has --inspect-brk on the cmdline).
      // But the shim must also load in the root for the Worker patch to apply.
      if (childInjectionFlag) {
        env.NODE_OPTIONS = mergeNodeOptions(env.NODE_OPTIONS, childInjectionFlag);
      }
      if (shimRequire) {
        env.NODE_OPTIONS = mergeNodeOptions(env.NODE_OPTIONS, shimRequire);
      }
    } else {
      // `command` mode — bin/args are user-supplied; NODE_OPTIONS does the inspector work.
      const [first, ...rest] = opts.command!;
      bin = first!;
      args = rest;
      const rootFlag = childInjectionFlag ?? "--inspect=0";
      env.NODE_OPTIONS = mergeNodeOptions(env.NODE_OPTIONS, rootFlag);
      if (shimRequire) {
        env.NODE_OPTIONS = mergeNodeOptions(env.NODE_OPTIONS, shimRequire);
      }
    }

    log.info("launching", bin, args.join(" "));
    log.info("  NODE_OPTIONS=", env.NODE_OPTIONS ?? "(unset)");
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.child = child;
    session.pid = child.pid;
    session.cmdline = `${bin} ${args.join(" ")}`;

    child.on("exit", (code) => {
      session.exitCode = code;
      session.status = "terminated";
      log.info(`session ${id} target exited with code ${code}`);
    });

    child.stdout?.on("data", (buf: Buffer) => {
      session.stdout.push(buf.toString("utf8"));
    });

    // Persistent stderr parser. Captures stderr to the ring buffer AND watches
    // for inspector-announce lines from the root and any descendant Node process.
    // Resolves the root's wsUrl on first announce; subsequent announces become
    // auto-child events.
    const rootAnnounce = createStderrAnnounceParser(child, session, onAutoChild);

    const wsUrl = await rootAnnounce;
    log.info(`session ${id} root inspector at ${wsUrl}`);

    session.cdp = await connectToWsUrl(wsUrl);
    await session.setupRoot();

    // Apply exception-pause BEFORE the target executes any user code. Without
    // this, fast startup paths (e.g. `node --test`'s assertion failures) race
    // ahead of any post-launch setExceptionPause call.
    if (opts.exceptionPause && opts.exceptionPause.state !== "none") {
      await session.setExceptionPause({
        state: opts.exceptionPause.state,
        filter: opts.exceptionPause.filter,
      });
    }

    await session.runIfWaitingForDebugger();

    // "Resume past Break on start" only applies when we actually launched
    // with --inspect-brk (the `script` mode). In `command` mode we use
    // --inspect=0 so there's no entry pause — and blindly resuming past
    // whatever first pause arrives (which might be a meaningful one like
    // an exception) is wrong.
    if (opts.stopOnEntry === false && opts.script) {
      const entry = await session.waitForNextPause(2000);
      if (entry && entry.reason === "Break on start") {
        await session.cdp.Debugger.resume({});
      }
    }

    return session;
  }

  /** Attach to a discovered WS URL as an auto-child of an existing session. */
  static async attachAuto(
    id: string,
    parent: Session,
    wsUrl: string,
  ): Promise<Session> {
    const session = new Session(id, "auto");
    session.parentSessionId = parent.id;
    session.cmdline = `auto-attached to ${wsUrl}`;
    session.cdp = await connectToWsUrl(wsUrl);
    await session.setupRoot();
    await session.runIfWaitingForDebugger();
    // Inherit parent's exception-pause state so e.g. `debug_run_tests`'s
    // AssertionError filter applies in the subprocess where `node --test`
    // actually runs the test file.
    if (parent.exceptionPause !== "none") {
      try {
        await session.setExceptionPause({
          state: parent.exceptionPause,
          filter: parent.exceptionFilter ?? undefined,
        });
      } catch (e) {
        log.debug(`failed to inherit exception pause into auto-session ${id}: ${String(e)}`);
      }
    }
    parent.childSessionIds.add(id);
    return session;
  }

  static async attach(id: string, opts: AttachOptions): Promise<Session> {
    const session = new Session(id, "attached");
    let wsUrl: string | undefined = opts.url;

    if (!wsUrl && opts.pid !== undefined) {
      if (process.platform === "win32") {
        throw new Error("pid-based attach requires POSIX (SIGUSR1 is unavailable on Windows)");
      }
      log.info(`sending SIGUSR1 to pid ${opts.pid} to open inspector`);
      try {
        process.kill(opts.pid, "SIGUSR1");
      } catch (e) {
        throw new Error(`failed to SIGUSR1 pid ${opts.pid}: ${String(e)}`);
      }
      session.pid = opts.pid;
      wsUrl = await pollForTarget(opts.host ?? "127.0.0.1", opts.port ?? 9229, 3000);
    } else if (!wsUrl) {
      wsUrl = await pollForTarget(opts.host ?? "127.0.0.1", opts.port ?? 9229, 1500);
    }

    if (!wsUrl) throw new Error("could not determine inspector WebSocket URL");

    session.cmdline = `attached to ${wsUrl}`;
    log.info(`session ${id} attaching to ${wsUrl}`);
    session.cdp = await connectToWsUrl(wsUrl);
    await session.setupRoot();
    // If the target was --inspect-brk, kick it off; otherwise no-op.
    await session.runIfWaitingForDebugger();
    return session;
  }

  private async setupRoot(): Promise<void> {
    const { Debugger, Runtime } = this.cdp;

    this.cdp.on("Debugger.scriptParsed", (event: unknown) => this.onScriptParsed(event));
    this.cdp.on("Debugger.paused", (event: unknown) => this.onPaused(event));
    this.cdp.on("Debugger.resumed", () => this.onResumed());
    this.cdp.on("Debugger.breakpointResolved", (event: unknown) =>
      this.onBreakpointResolved(event),
    );
    this.cdp.on("Runtime.consoleAPICalled", (event: unknown) =>
      this.onConsole(event),
    );
    this.cdp.on("Runtime.exceptionThrown", (event: unknown) =>
      this.onException(event),
    );

    await Debugger.enable({});
    await Runtime.enable();
    await Debugger.setAsyncCallStackDepth({ maxDepth: 32 });
  }

  private onConsole(event: unknown): void {
    const e = event as {
      type: string;
      args?: Array<RemoteObjectLike>;
      stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> };
    };
    const text = (e.args ?? [])
      .map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description !== undefined) return a.description;
        return `[${a.type}]`;
      })
      .join(" ");
    const frame = e.stackTrace?.callFrames?.[0];
    this.console.push({
      level: e.type,
      text,
      url: frame?.url,
      line: frame?.lineNumber,
    });
  }

  private onException(event: unknown): void {
    const e = event as {
      exceptionDetails?: {
        text?: string;
        exception?: RemoteObjectLike;
      };
    };
    const desc = e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? "exception";
    this.console.push({ level: "error", text: `[exception] ${desc}` });
  }

  private onScriptParsed(event: unknown): void {
    const e = event as { scriptId: string; url: string; sourceMapURL?: string };
    this.scripts.set(e.scriptId, { scriptId: e.scriptId, url: e.url });
    if (e.sourceMapURL) {
      // Fire-and-forget ingest; failure is non-fatal.
      this.sourceMaps
        .ingest({
          scriptId: e.scriptId,
          scriptUrl: e.url,
          sourceMapURL: e.sourceMapURL,
        })
        .catch(() => {
          /* ignored — sourcemaps.ts already logs */
        });
    }
    // Resolve any break_on_load that's waiting for this URL.
    const remaining: BreakpointRecord[] = [];
    for (const rec of this.breakOnLoadPending) {
      if (rec.urlPattern && e.url.includes(rec.urlPattern)) {
        // Fire-and-forget set a one-shot BP at line 0 of the matched URL.
        this.installLineBpForUrl(rec, e.url).catch((err) =>
          log.error(`break_on_load setup failed: ${String(err)}`),
        );
      } else {
        remaining.push(rec);
      }
    }
    this.breakOnLoadPending = remaining;
  }

  private async installLineBpForUrl(rec: BreakpointRecord, url: string): Promise<void> {
    const res = (await this.cdp.Debugger.setBreakpointByUrl({
      url,
      lineNumber: 0,
    })) as {
      breakpointId: string;
      locations: Array<{ scriptId: string; lineNumber: number; columnNumber: number }>;
    };
    rec.cdpBreakpointId = res.breakpointId;
    rec.resolved = res.locations.map((loc) => ({
      scriptId: loc.scriptId,
      url: this.scripts.get(loc.scriptId)?.url ?? url,
      line: loc.lineNumber,
      column: loc.columnNumber,
    }));
    this.cdpBpToBp.set(res.breakpointId, rec.id);
  }

  private async onPaused(event: unknown): Promise<void> {
    const e = event as {
      reason: string;
      hitBreakpoints?: string[];
      callFrames: RawCallFrame[];
      data?: { className?: string; description?: string };
      asyncStackTrace?: RawAsyncStackTrace;
    };

    // Filtered-exception auto-resume: when the user asked to pause on
    // exceptions but only for specific classes, drop non-matching ones
    // BEFORE setting pauseState / resolving pendingPause so the rest of
    // the system never sees them.
    if (
      this.exceptionFilter &&
      this.exceptionFilter.length > 0 &&
      (e.reason === "exception" || e.reason === "promiseRejection")
    ) {
      const className = e.data?.className ?? extractClassName(e.data?.description);
      if (className && !this.exceptionFilter.includes(className)) {
        log.debug(
          `session ${this.id} auto-resuming filtered ${className} (not in [${this.exceptionFilter.join(",")}])`,
        );
        this.cdp.Debugger.resume({}).catch(() => {});
        return;
      }
    }

    this.currentFrames = e.callFrames;

    // Build FrameSnapshot[] but skip node-internal frames and cap by maxFrames.
    // currentFrames keeps the full V8-indexed list for eval/restart_frame
    // ordinals to remain valid.
    const allBuilt: FrameSnapshot[] = [];
    let hiddenInternalCount = 0;
    for (let i = 0; i < e.callFrames.length; i++) {
      const f = e.callFrames[i]!;
      const script = this.scripts.get(f.location.scriptId);
      const url = script?.url ?? f.url ?? "";
      if (isInternalUrl(url)) {
        hiddenInternalCount++;
        continue;
      }
      const compiledLine = f.location.lineNumber;
      const compiledColumn = f.location.columnNumber;
      const orig = this.sourceMaps.reverseMap({
        scriptId: f.location.scriptId,
        line0: compiledLine,
        column0: compiledColumn,
      });

      // Snippet only for the TOP user frame (the one Claude will look at first).
      let snippet: string | undefined;
      if (allBuilt.length === 0) {
        if (orig) {
          const embedded = this.sourceMaps.sourceContent(f.location.scriptId, orig.url);
          if (embedded !== undefined) {
            snippet = renderSnippet(embedded, orig.line0);
          } else if (script && script.url.startsWith("file://")) {
            snippet = await this.snippetFor(script, compiledLine);
          }
        } else if (script && script.url.startsWith("file://")) {
          snippet = await this.snippetFor(script, compiledLine);
        }
      }

      const scopes: ScopeRef[] = (f.scopeChain ?? []).map((s) => ({
        type: s.type,
        localObjectId: s.object.objectId
          ? this.objects.mint(s.object.objectId)
          : undefined,
      }));
      const thisLocalObjectId = f.this?.objectId
        ? this.objects.mint(f.this.objectId)
        : undefined;

      const frame: FrameSnapshot = {
        ordinal: i,
        functionName: f.functionName || "<anonymous>",
        scriptId: f.location.scriptId,
        url,
        line: compiledLine,
        column: compiledColumn,
        ...(orig ? { original: { url: orig.url, line: orig.line0, column: orig.column0 } } : {}),
        ...(snippet ? { snippet } : {}),
        ...(scopes.length > 0 ? { scopes } : {}),
        ...(thisLocalObjectId ? { thisLocalObjectId } : {}),
      };
      allBuilt.push(frame);
    }

    // Cap PauseSnapshot at maxFrames (default 5); full stack via debug_get_stack.
    const MAX_FRAMES = 5;
    const frames =
      allBuilt.length > MAX_FRAMES ? allBuilt.slice(0, MAX_FRAMES) : allBuilt;

    // Evaluate watches on the top frame (or globally if no frame).
    const watchResults: WatchResult[] = [];
    if (this.watches.size > 0) {
      for (const w of this.watches.values()) {
        try {
          const v = await this.evaluate({ expression: w.expression });
          if ("error" in v) {
            watchResults.push({ id: w.id, expression: w.expression, error: v.error });
          } else {
            watchResults.push({ id: w.id, expression: w.expression, value: v });
          }
        } catch (err) {
          watchResults.push({
            id: w.id,
            expression: w.expression,
            error: String(err),
          });
        }
      }
    }

    const asyncStack = e.asyncStackTrace ? summariseAsyncStack(e.asyncStackTrace) : undefined;

    this.pauseState = {
      reason: e.reason,
      ...(e.hitBreakpoints && e.hitBreakpoints.length > 0
        ? { hitBreakpoints: e.hitBreakpoints }
        : {}),
      frames,
      ...(hiddenInternalCount > 0 ? { hiddenInternalFrames: hiddenInternalCount } : {}),
      ...(asyncStack && asyncStack.length > 0 ? { asyncStack } : {}),
      ...(watchResults.length > 0 ? { watches: watchResults } : {}),
    };
    this.status = "paused";

    // Update hit counts and queue temporary BPs for removal.
    const toRemoveAfter: string[] = [];
    for (const cdpBpId of e.hitBreakpoints ?? []) {
      const bpId = this.cdpBpToBp.get(cdpBpId);
      if (bpId) {
        const rec = this.breakpoints.get(bpId);
        if (rec) {
          rec.hitCount++;
          if (rec.temporary) toRemoveAfter.push(bpId);
        }
      }
    }

    log.debug(`session ${this.id} paused: reason=${e.reason} frames=${e.callFrames.length}`);

    // Resolve any in-flight wait.
    if (this.pendingPause) {
      const d = this.pendingPause;
      this.pendingPause = null;
      d.resolve(this.pauseState);
    }

    // Clean up temporary BPs after the snapshot is observable.
    for (const bpId of toRemoveAfter) {
      this.removeBreakpoint(bpId).catch((err) =>
        log.error(`failed to remove temporary BP ${bpId}: ${String(err)}`),
      );
    }
  }

  private onResumed(): void {
    this.pauseState = null;
    this.currentFrames = [];
    this.objects.invalidate();
    this.status = this.exitCode === null ? "running" : "terminated";
    log.debug(`session ${this.id} resumed`);
  }

  private onBreakpointResolved(event: unknown): void {
    const e = event as {
      breakpointId: string;
      location: { scriptId: string; lineNumber: number; columnNumber: number };
    };
    const bpId = this.cdpBpToBp.get(e.breakpointId);
    if (!bpId) return;
    const rec = this.breakpoints.get(bpId);
    if (!rec) return;
    const script = this.scripts.get(e.location.scriptId);
    rec.resolved.push({
      scriptId: e.location.scriptId,
      url: script?.url ?? "",
      line: e.location.lineNumber,
      column: e.location.columnNumber,
    });
  }

  private async snippetFor(script: ScriptEntry, line: number): Promise<string | undefined> {
    if (script.source === undefined) {
      try {
        const res = (await this.cdp.Debugger.getScriptSource({
          scriptId: script.scriptId,
        })) as { scriptSource: string };
        script.source = res.scriptSource;
      } catch {
        return undefined;
      }
    }
    return renderSnippet(script.source ?? "", line);
  }

  async runIfWaitingForDebugger(): Promise<void> {
    await this.cdp.Runtime.runIfWaitingForDebugger();
  }

  /**
   * Long-poll: wait until next Debugger.paused event or timeout.
   * Installs a Deferred BEFORE the caller's resume/step command so the
   * pause event can never arrive while no one is listening.
   *
   * Call site pattern:
   *   const wait = session.armPause();      // installs deferred
   *   await cdp.Debugger.resume(...);       // safe to send now
   *   const snap = await wait(5000);        // get the snapshot or null on timeout
   */
  armPause(): (timeoutMs: number) => Promise<PauseSnapshot | null> {
    if (this.pendingPause) {
      // Someone else is already waiting — chain onto theirs.
      const existing = this.pendingPause.promise;
      return async (timeoutMs: number) => {
        return await Promise.race([
          existing,
          new Promise<null>((res) => setTimeout(() => res(null), timeoutMs)),
        ]);
      };
    }
    const deferred = createDeferred<PauseSnapshot | null>();
    this.pendingPause = deferred;
    return async (timeoutMs: number) => {
      return await Promise.race([
        deferred.promise,
        new Promise<null>((res) =>
          setTimeout(() => {
            if (this.pendingPause === deferred) {
              this.pendingPause = null;
              res(null);
            } else {
              res(null);
            }
          }, timeoutMs),
        ),
      ]);
    };
  }

  /** Simpler wait that doesn't arm before a command — only useful at startup. */
  async waitForNextPause(timeoutMs: number): Promise<PauseSnapshot | null> {
    if (this.pauseState) return this.pauseState;
    return await this.armPause()(timeoutMs);
  }

  /** Build the urlRegex that matches both file:// and bare absolute paths for a given absolute path. */
  private fileUrlRegex(absFile: string): string {
    const escaped = absFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `^(file://)?${escaped}$`;
  }

  /** Compose user condition with hit-count counter into a single CDP condition. */
  private compileCondition(opts: {
    condition?: string;
    hitCount?: number;
    bpId: string;
  }): string | undefined {
    const parts: string[] = [];
    if (opts.hitCount !== undefined) {
      const counterVar = `__bp_hits_${opts.bpId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      parts.push(
        `((globalThis.${counterVar} = (globalThis.${counterVar} || 0) + 1) >= ${opts.hitCount})`,
      );
    }
    if (opts.condition) parts.push(`(${opts.condition})`);
    if (parts.length === 0) return undefined;
    return parts.join(" && ");
  }

  async setBreakpoint(opts: {
    file?: string;
    line?: number;
    urlRegex?: string;
    column?: number;
    condition?: string;
    hitCount?: number;
    temporary?: boolean;
  }): Promise<BreakpointRecord | { error: string }> {
    if ((opts.file === undefined || opts.line === undefined) && !opts.urlRegex) {
      return { error: "either file+line or urlRegex is required" };
    }
    if (opts.line === undefined && opts.urlRegex) {
      return { error: "line is required even when urlRegex is given" };
    }
    const id = `bp${this.nextBpId++}`;
    const abs = opts.file ? pathResolve(opts.file) : undefined;

    // Source-map forward map: if the file looks like a TS/JS source not directly
    // loaded by V8, look it up via the source-map index.
    let targetLine = opts.line!;
    let targetColumn = opts.column;
    let urlRegex = opts.urlRegex ?? (abs ? this.fileUrlRegex(abs) : undefined);
    let originalFile: string | undefined;
    let originalLine: number | undefined;

    if (abs && !opts.urlRegex) {
      // Prefer source-map forward map when any loaded script has a sourcemap
      // covering this source — covers both tsc (TS line ≠ JS line) and tsx
      // (where V8's URL is the .ts but line numbering still tracks the JS body).
      const compiled = this.sourceMaps.forwardMap({
        sourcePath: abs,
        line0: targetLine,
        column0: targetColumn,
      });
      if (compiled.length > 0) {
        const best = compiled[0]!;
        urlRegex = this.fileUrlRegex(
          best.scriptUrl.startsWith("file://")
            ? best.scriptUrl.slice("file://".length)
            : best.scriptUrl,
        );
        originalFile = abs;
        originalLine = targetLine;
        targetLine = best.line0;
        targetColumn = best.column0;
      }
      // else: fall through with the urlRegex computed from abs — V8 will
      // resolve it lazily via Debugger.breakpointResolved when a matching
      // script loads (or never, if the file isn't actually executed).
    }

    if (!urlRegex) return { error: "could not compute urlRegex" };

    const condition = this.compileCondition({
      condition: opts.condition,
      hitCount: opts.hitCount,
      bpId: id,
    });
    const res = (await this.cdp.Debugger.setBreakpointByUrl({
      urlRegex,
      lineNumber: targetLine,
      columnNumber: targetColumn,
      condition,
    })) as {
      breakpointId: string;
      locations: Array<{ scriptId: string; lineNumber: number; columnNumber: number }>;
    };
    const resolved = res.locations.map((loc) => ({
      scriptId: loc.scriptId,
      url: this.scripts.get(loc.scriptId)?.url ?? "",
      line: loc.lineNumber,
      column: loc.columnNumber,
    }));
    const rec: BreakpointRecord = {
      id,
      kind: "line",
      file: abs,
      line: opts.line,
      column: opts.column,
      condition: opts.condition,
      hitCountThreshold: opts.hitCount,
      temporary: opts.temporary,
      cdpBreakpointId: res.breakpointId,
      resolved,
      enabled: true,
      hitCount: 0,
    };
    // Attach original-position metadata when sourcemap was used.
    if (originalFile !== undefined) {
      (rec as Record<string, unknown>).originalFile = originalFile;
      (rec as Record<string, unknown>).originalLine = originalLine;
      (rec as Record<string, unknown>).compiledUrl = res.locations[0]?.scriptId
        ? this.scripts.get(res.locations[0].scriptId)?.url
        : undefined;
    }
    this.breakpoints.set(id, rec);
    this.cdpBpToBp.set(res.breakpointId, id);
    return rec;
  }

  async setLogpoint(opts: {
    file: string;
    line: number;
    column?: number;
    expression: string;
    captureStack?: boolean;
  }): Promise<BreakpointRecord> {
    const id = `bp${this.nextBpId++}`;
    const abs = pathResolve(opts.file);
    const urlRegex = this.fileUrlRegex(abs);
    // Condition that logs and returns false. Stack capture is delegated to console.log itself.
    const expr = opts.captureStack
      ? `console.log("[logpoint ${id}]", ${opts.expression}, "\\n" + new Error().stack)`
      : `console.log("[logpoint ${id}]", ${opts.expression})`;
    const condition = `(function(){ try { ${expr} } catch (e) { console.log("[logpoint ${id} error]", e && e.message); } return false; })()`;
    const res = (await this.cdp.Debugger.setBreakpointByUrl({
      urlRegex,
      lineNumber: opts.line,
      columnNumber: opts.column,
      condition,
    })) as {
      breakpointId: string;
      locations: Array<{ scriptId: string; lineNumber: number; columnNumber: number }>;
    };
    const resolved = res.locations.map((loc) => ({
      scriptId: loc.scriptId,
      url: this.scripts.get(loc.scriptId)?.url ?? "",
      line: loc.lineNumber,
      column: loc.columnNumber,
    }));
    const rec: BreakpointRecord = {
      id,
      kind: "logpoint",
      file: abs,
      line: opts.line,
      column: opts.column,
      expression: opts.expression,
      cdpBreakpointId: res.breakpointId,
      resolved,
      enabled: true,
      hitCount: 0,
    };
    this.breakpoints.set(id, rec);
    this.cdpBpToBp.set(res.breakpointId, id);
    return rec;
  }

  async setFunctionBreakpoint(opts: {
    expression: string;
  }): Promise<BreakpointRecord | { error: string }> {
    // Need a function objectId. If paused, evaluate on the top frame; otherwise Runtime.evaluate.
    const id = `bp${this.nextBpId++}`;
    const evalRes =
      this.currentFrames.length > 0
        ? ((await this.cdp.Debugger.evaluateOnCallFrame({
            callFrameId: this.currentFrames[0]!.callFrameId,
            expression: opts.expression,
          })) as { result: RemoteObjectLike; exceptionDetails?: { text: string } })
        : ((await this.cdp.Runtime.evaluate({
            expression: opts.expression,
          })) as { result: RemoteObjectLike; exceptionDetails?: { text: string } });
    if (evalRes.exceptionDetails) {
      return { error: `expression did not evaluate: ${evalRes.exceptionDetails.text}` };
    }
    if (evalRes.result.type !== "function" || !evalRes.result.objectId) {
      return {
        error: `expression must resolve to a function with an objectId (got type=${evalRes.result.type})`,
      };
    }
    await this.cdp.Debugger.setBreakpointOnFunctionCall({
      objectId: evalRes.result.objectId,
    });
    const rec: BreakpointRecord = {
      id,
      kind: "function",
      expression: opts.expression,
      enabled: true,
      hitCount: 0,
      resolved: [],
    };
    this.breakpoints.set(id, rec);
    return rec;
  }

  async setExceptionPause(opts: {
    state: ExceptionPauseState;
    filter?: string[];
  }): Promise<void> {
    await this.cdp.Debugger.setPauseOnExceptions({ state: opts.state });
    this.exceptionPause = opts.state;
    this.exceptionFilter = opts.filter && opts.filter.length > 0 ? opts.filter : null;
  }

  async setBreakOnLoad(opts: { urlPattern: string }): Promise<BreakpointRecord> {
    const id = `bp${this.nextBpId++}`;
    const rec: BreakpointRecord = {
      id,
      kind: "break_on_load",
      urlPattern: opts.urlPattern,
      temporary: true,
      enabled: true,
      hitCount: 0,
      resolved: [],
    };
    this.breakpoints.set(id, rec);
    // Check already-loaded scripts first.
    for (const s of this.scripts.values()) {
      if (s.url.includes(opts.urlPattern)) {
        await this.installLineBpForUrl(rec, s.url);
        return rec;
      }
    }
    // Not loaded yet → queue for scriptParsed handler.
    this.breakOnLoadPending.push(rec);
    return rec;
  }

  async removeBreakpoint(id: string): Promise<boolean> {
    const rec = this.breakpoints.get(id);
    if (!rec) return false;
    if (rec.cdpBreakpointId) {
      try {
        await this.cdp.Debugger.removeBreakpoint({ breakpointId: rec.cdpBreakpointId });
      } catch {
        // ignore — BP may already be gone
      }
      this.cdpBpToBp.delete(rec.cdpBreakpointId);
    }
    // also strip from pending break_on_load queue
    this.breakOnLoadPending = this.breakOnLoadPending.filter((r) => r.id !== id);
    this.breakpoints.delete(id);
    return true;
  }

  async clearBreakpoints(kind?: BreakpointKind): Promise<number> {
    const ids = Array.from(this.breakpoints.values())
      .filter((r) => !kind || r.kind === kind)
      .map((r) => r.id);
    for (const id of ids) await this.removeBreakpoint(id);
    return ids.length;
  }

  async toggleBreakpoint(id: string, enabled: boolean): Promise<BreakpointRecord | { error: string }> {
    const rec = this.breakpoints.get(id);
    if (!rec) return { error: `no breakpoint ${id}` };
    if (rec.enabled === enabled) return rec;
    if (!enabled) {
      // Disable by removing from CDP but keep the record.
      if (rec.cdpBreakpointId) {
        try {
          await this.cdp.Debugger.removeBreakpoint({ breakpointId: rec.cdpBreakpointId });
        } catch {
          // ignore
        }
        this.cdpBpToBp.delete(rec.cdpBreakpointId);
        rec.cdpBreakpointId = undefined;
      }
      rec.enabled = false;
      return rec;
    }
    // Re-enable: re-create via the same kind path.
    if (rec.kind === "line" && rec.file !== undefined && rec.line !== undefined) {
      const re = await this.setBreakpoint({
        file: rec.file,
        line: rec.line,
        column: rec.column,
        condition: rec.condition,
        hitCount: rec.hitCountThreshold,
        temporary: rec.temporary,
      });
      if ("error" in re) return re;
      // Replace the old record's CDP id and resolved with the new one's.
      rec.cdpBreakpointId = re.cdpBreakpointId;
      rec.resolved = re.resolved;
      if (rec.cdpBreakpointId) this.cdpBpToBp.set(rec.cdpBreakpointId, rec.id);
      // Drop the throwaway record we just made.
      this.breakpoints.delete(re.id);
    } else if (
      rec.kind === "logpoint" &&
      rec.file !== undefined &&
      rec.line !== undefined &&
      rec.expression
    ) {
      const re = await this.setLogpoint({
        file: rec.file,
        line: rec.line,
        column: rec.column,
        expression: rec.expression,
      });
      rec.cdpBreakpointId = re.cdpBreakpointId;
      rec.resolved = re.resolved;
      if (rec.cdpBreakpointId) this.cdpBpToBp.set(rec.cdpBreakpointId, rec.id);
      this.breakpoints.delete(re.id);
    }
    rec.enabled = true;
    return rec;
  }

  // -- Watches -----------------------------------------------------------

  addWatch(expression: string): WatchRecord {
    const id = `w${this.nextWatchId++}`;
    const rec: WatchRecord = { id, expression };
    this.watches.set(id, rec);
    return rec;
  }

  removeWatch(id: string): boolean {
    return this.watches.delete(id);
  }

  listWatches(): WatchRecord[] {
    return Array.from(this.watches.values());
  }

  async runToLine(opts: {
    file: string;
    line: number;
    timeoutMs?: number;
  }): Promise<PauseSnapshot | { error: string } | { status: "running" }> {
    if (!this.pauseState) return { error: "session is not paused; cannot run to line" };
    const bp = await this.setBreakpoint({
      file: opts.file,
      line: opts.line,
      temporary: true,
    });
    if ("error" in bp) return bp;
    const wait = this.armPause();
    await this.resume();
    const pause = await wait(opts.timeoutMs ?? 10_000);
    // Whether the BP hit or we timed out, clean it up.
    await this.removeBreakpoint(bp.id);
    if (pause === null) return { status: "running" };
    return pause;
  }

  async restartFrame(opts: {
    mode?: "StepInto" | "StepOver" | "StepOut";
  }): Promise<PauseSnapshot | { error: string }> {
    if (!this.pauseState) return { error: "session is not paused; cannot restart frame" };
    if (this.currentFrames.length === 0) return { error: "no current frame to restart" };
    // CDP refuses anything but the top frame, and refuses inside generators/async-iterators.
    const top = this.currentFrames[0]!;
    const wait = this.armPause();
    try {
      await this.cdp.Debugger.restartFrame({
        callFrameId: top.callFrameId,
        mode: opts.mode ?? "StepInto",
      });
    } catch (e) {
      return { error: `restartFrame rejected by V8: ${String(e)}` };
    }
    const pause = await wait(5000);
    if (pause === null) return { error: "restart_frame: timed out waiting for pause" };
    return pause;
  }

  async resume(): Promise<void> {
    await this.cdp.Debugger.resume({});
  }
  async stepOver(): Promise<void> {
    await this.cdp.Debugger.stepOver({});
  }
  async stepInto(): Promise<void> {
    await this.cdp.Debugger.stepInto({});
  }
  async stepOut(): Promise<void> {
    await this.cdp.Debugger.stepOut();
  }
  async pause(): Promise<void> {
    await this.cdp.Debugger.pause();
  }

  /** Re-derive FrameSnapshots from currentFrames with a filter option. */
  stackFromCurrentFrames(opts: { includeNodeInternals?: boolean } = {}): FrameSnapshot[] {
    const out: FrameSnapshot[] = [];
    for (let i = 0; i < this.currentFrames.length; i++) {
      const f = this.currentFrames[i]!;
      const script = this.scripts.get(f.location.scriptId);
      const url = script?.url ?? f.url ?? "";
      if (!opts.includeNodeInternals && isInternalUrl(url)) continue;
      const orig = this.sourceMaps.reverseMap({
        scriptId: f.location.scriptId,
        line0: f.location.lineNumber,
        column0: f.location.columnNumber,
      });
      const scopes: ScopeRef[] = (f.scopeChain ?? []).map((s) => ({
        type: s.type,
        // NOTE: these objectIds were minted during onPaused — we don't re-mint
        // here. Tools like debug_get_scope use ordinal lookups against
        // currentFrames anyway.
        localObjectId: undefined,
      }));
      out.push({
        ordinal: i,
        functionName: f.functionName || "<anonymous>",
        scriptId: f.location.scriptId,
        url,
        line: f.location.lineNumber,
        column: f.location.columnNumber,
        ...(orig ? { original: { url: orig.url, line: orig.line0, column: orig.column0 } } : {}),
        ...(scopes.length > 0 ? { scopes } : {}),
      });
    }
    return out;
  }

  // -- Inspection --------------------------------------------------------

  async evaluate(opts: {
    expression: string;
    frameOrdinal?: number;
    returnByValue?: boolean;
  }): Promise<ShapedValue | { error: string }> {
    const returnByValue = opts.returnByValue ?? false;
    if (this.currentFrames.length > 0) {
      const ord = opts.frameOrdinal ?? 0;
      const frame = this.currentFrames[ord];
      if (!frame) return { error: `no frame at ordinal ${ord}` };
      const res = (await this.cdp.Debugger.evaluateOnCallFrame({
        callFrameId: frame.callFrameId,
        expression: opts.expression,
        returnByValue,
        generatePreview: true,
      })) as { result: RemoteObjectLike; exceptionDetails?: { text: string } };
      if (res.exceptionDetails) return { error: res.exceptionDetails.text };
      return shapeRemoteObject(res.result, this.objects);
    }
    const res = (await this.cdp.Runtime.evaluate({
      expression: opts.expression,
      returnByValue,
      generatePreview: true,
    })) as { result: RemoteObjectLike; exceptionDetails?: { text: string } };
    if (res.exceptionDetails) return { error: res.exceptionDetails.text };
    return shapeRemoteObject(res.result, this.objects);
  }

  /** Expand a scope or any object id into key→preview pairs. */
  async getProperties(opts: {
    localObjectId: string;
    ownOnly?: boolean;
  }): Promise<{ properties: { name: string; value: ShapedValue }[] } | { error: string }> {
    const entry = this.objects.get(opts.localObjectId);
    if (!entry) {
      return {
        error: `object ${opts.localObjectId} expired — execution has resumed since it was minted`,
      };
    }
    const res = (await this.cdp.Runtime.getProperties({
      objectId: entry.cdpObjectId,
      ownProperties: opts.ownOnly ?? true,
      generatePreview: true,
    })) as {
      result: Array<{ name: string; value?: RemoteObjectLike }>;
    };
    return {
      properties: res.result.map((p) => ({
        name: p.name,
        value: shapeRemoteObject(p.value, this.objects),
      })),
    };
  }

  async getScriptSource(scriptIdOrUrl: string): Promise<{ source: string; url: string } | { error: string }> {
    let scriptId: string | undefined;
    let entry: ScriptEntry | undefined;
    // Caller can pass either the V8 scriptId or a URL/path.
    entry = this.scripts.get(scriptIdOrUrl);
    if (entry) {
      scriptId = entry.scriptId;
    } else {
      // try URL match (with or without file://)
      const want = scriptIdOrUrl.startsWith("file://")
        ? scriptIdOrUrl
        : `file://${pathResolve(scriptIdOrUrl)}`;
      for (const s of this.scripts.values()) {
        if (s.url === want || s.url === scriptIdOrUrl) {
          entry = s;
          scriptId = s.scriptId;
          break;
        }
      }
    }
    if (!scriptId || !entry) return { error: `no script matching '${scriptIdOrUrl}'` };
    if (entry.source === undefined) {
      const res = (await this.cdp.Debugger.getScriptSource({ scriptId })) as {
        scriptSource: string;
      };
      entry.source = res.scriptSource;
    }
    return { source: entry.source!, url: entry.url };
  }

  /**
   * Find every live AsyncLocalStorage instance in the target's heap and
   * return its current .getStore() value. Uses Runtime.queryObjects under
   * the hood — non-trivial cost on a large heap, but typically fast on
   * dev/test workloads.
   */
  async getAsyncContext(): Promise<
    | { error: string }
    | {
        count: number;
        instances: {
          index: number;
          store?: ShapedValue;
          error?: string;
        }[];
      }
  > {
    // 1. Resolve the AsyncLocalStorage prototype. Try CJS require first
    //    (works in most contexts including ESM main modules); fall back to
    //    process.mainModule.require.
    const protoEval = (await this.cdp.Runtime.evaluate({
      expression: `(() => {
        try { return require('node:async_hooks').AsyncLocalStorage.prototype; } catch (e) {}
        try { return process.mainModule.require('node:async_hooks').AsyncLocalStorage.prototype; } catch (e) {}
        return null;
      })()`,
      returnByValue: false,
      generatePreview: false,
    })) as { result: RemoteObjectLike; exceptionDetails?: { text: string } };
    if (protoEval.exceptionDetails) return { error: protoEval.exceptionDetails.text };
    if (!protoEval.result.objectId) {
      return { error: "AsyncLocalStorage not reachable from eval context (no require)" };
    }

    // 2. queryObjects → array RemoteObject containing every live instance.
    const objs = (await this.cdp.Runtime.queryObjects({
      prototypeObjectId: protoEval.result.objectId,
    })) as { objects: RemoteObjectLike };
    if (!objs.objects.objectId) {
      return { count: 0, instances: [] };
    }

    // 3. Map each instance to {index, store|error} via callFunctionOn on the array.
    const mapped = (await this.cdp.Runtime.callFunctionOn({
      objectId: objs.objects.objectId,
      functionDeclaration: `function() {
        return this.map((als, i) => {
          try { return { index: i, store: als.getStore() }; }
          catch (e) { return { index: i, error: String(e && e.message || e) }; }
        });
      }`,
      returnByValue: false,
      generatePreview: false,
    })) as { result: RemoteObjectLike; exceptionDetails?: { text: string } };
    if (mapped.exceptionDetails) return { error: mapped.exceptionDetails.text };
    if (!mapped.result.objectId) return { count: 0, instances: [] };

    // 4. Walk the result array's properties — one entry per instance.
    const arrProps = (await this.cdp.Runtime.getProperties({
      objectId: mapped.result.objectId,
      ownProperties: true,
      generatePreview: true,
    })) as { result: Array<{ name: string; value?: RemoteObjectLike }> };

    const instances: {
      index: number;
      store?: ShapedValue;
      error?: string;
    }[] = [];
    for (const entry of arrProps.result) {
      if (!/^\d+$/.test(entry.name)) continue; // skip 'length' etc.
      const v = entry.value;
      if (!v || v.type !== "object" || !v.objectId) continue;
      const inner = (await this.cdp.Runtime.getProperties({
        objectId: v.objectId,
        ownProperties: true,
        generatePreview: true,
      })) as { result: Array<{ name: string; value?: RemoteObjectLike }> };
      const flat: { index: number; store?: ShapedValue; error?: string } = {
        index: -1,
      };
      for (const ip of inner.result) {
        if (ip.name === "index") flat.index = Number(ip.value?.value ?? -1);
        if (ip.name === "store") flat.store = shapeRemoteObject(ip.value, this.objects);
        if (ip.name === "error") flat.error = String(ip.value?.value ?? "");
      }
      instances.push(flat);
    }
    return { count: instances.length, instances };
  }

  // -- CPU profile ------------------------------------------------------

  /**
   * Run a CPU profile for `durationMs` and return the top-N hottest
   * functions by self-time. Uses Profiler.start / Profiler.stop and
   * processes the returned tree client-side.
   */
  async cpuProfile(opts: {
    durationMs: number;
    topN?: number;
    includeNodeInternals?: boolean;
  }): Promise<{
    durationMs: number;
    totalSamples: number;
    topByTotal: Array<{ functionName: string; url: string; line: number; samples: number }>;
  }> {
    await this.cdp.Profiler.enable();
    await this.cdp.Profiler.start();
    await new Promise((r) => setTimeout(r, opts.durationMs));
    const res = (await this.cdp.Profiler.stop()) as {
      profile: {
        nodes: Array<{
          id: number;
          callFrame: { functionName: string; url: string; lineNumber: number };
          hitCount?: number;
          children?: number[];
        }>;
        samples?: number[];
      };
    };
    await this.cdp.Profiler.disable();

    // Aggregate by callFrame signature. Each sample's leaf is the function
    // currently executing; we count samples per node to estimate self-time.
    const nodeById = new Map<number, (typeof res.profile.nodes)[0]>();
    for (const n of res.profile.nodes) nodeById.set(n.id, n);

    const samples = res.profile.samples ?? [];
    const counts = new Map<number, number>(); // node id → leaf-sample count
    for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1);

    type Row = { functionName: string; url: string; line: number; samples: number };
    const rows: Row[] = [];
    for (const [id, count] of counts.entries()) {
      const n = nodeById.get(id);
      if (!n) continue;
      if (!opts.includeNodeInternals && isInternalUrl(n.callFrame.url)) continue;
      rows.push({
        functionName: n.callFrame.functionName || "<anonymous>",
        url: n.callFrame.url,
        line: n.callFrame.lineNumber,
        samples: count,
      });
    }
    rows.sort((a, b) => b.samples - a.samples);
    const topN = opts.topN ?? 20;
    return {
      durationMs: opts.durationMs,
      totalSamples: samples.length,
      topByTotal: rows.slice(0, topN),
    };
  }

  // -- Heap snapshot ----------------------------------------------------

  /**
   * Capture a heap snapshot, write it to disk (the full thing is too big
   * to return as a tool response), and compute a class-level summary.
   * The .heapsnapshot file is openable in Chrome DevTools → Memory.
   */
  async heapSnapshot(opts: { savePath?: string }): Promise<{
    path: string;
    sizeBytes: number;
    nodeCount: number;
    topByCount: Array<{ name: string; count: number; selfSize: number }>;
  }> {
    const path = opts.savePath ?? `/tmp/ndb-heap-${this.id}-${Date.now()}.heapsnapshot`;
    const { writeFileSync } = await import("node:fs");

    const chunks: string[] = [];
    const onChunk = (event: unknown) => {
      const e = event as { chunk: string };
      chunks.push(e.chunk);
    };
    this.cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);

    await this.cdp.HeapProfiler.enable();
    await this.cdp.HeapProfiler.takeHeapSnapshot({ reportProgress: false });
    // Give the last chunk events a tick to arrive.
    await new Promise((r) => setImmediate(r));
    this.cdp.removeListener("HeapProfiler.addHeapSnapshotChunk", onChunk);
    await this.cdp.HeapProfiler.disable();

    const raw = chunks.join("");
    writeFileSync(path, raw, "utf8");

    // Parse the snapshot JSON enough to summarise. Format docs:
    // https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshot-schema
    const parsed = JSON.parse(raw) as {
      snapshot: { node_count: number; meta: { node_fields: string[]; node_types: Array<string | string[]> } };
      nodes: number[];
      strings: string[];
    };
    const fields = parsed.snapshot.meta.node_fields;
    const fieldCount = fields.length;
    const nameIdx = fields.indexOf("name");
    const typeIdx = fields.indexOf("type");
    const selfSizeIdx = fields.indexOf("self_size");
    const nodeTypeEnum = parsed.snapshot.meta.node_types[typeIdx];
    const typeNames = Array.isArray(nodeTypeEnum) ? nodeTypeEnum : [];

    const tally = new Map<string, { count: number; selfSize: number }>();
    const nodes = parsed.nodes;
    for (let i = 0; i < nodes.length; i += fieldCount) {
      const typeId = nodes[i + typeIdx];
      const name = parsed.strings[nodes[i + nameIdx]!] ?? "?";
      const selfSize = nodes[i + selfSizeIdx]!;
      const className = typeNames[typeId!] === "object" ? name : (typeNames[typeId!] ?? "?");
      const entry = tally.get(className) ?? { count: 0, selfSize: 0 };
      entry.count += 1;
      entry.selfSize += selfSize;
      tally.set(className, entry);
    }
    const topByCount = Array.from(tally.entries())
      .map(([name, v]) => ({ name, count: v.count, selfSize: v.selfSize }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return {
      path,
      sizeBytes: raw.length,
      nodeCount: parsed.snapshot.node_count,
      topByCount,
    };
  }

  // -- Profiler-based execution trace -----------------------------------
  private traceActive = false;

  async startExecutionTrace(): Promise<void> {
    if (this.traceActive) return;
    await this.cdp.Profiler.enable();
    await this.cdp.Profiler.startPreciseCoverage({ callCount: true, detailed: true });
    this.traceActive = true;
  }

  async stopExecutionTrace(opts: {
    topN?: number;
    urlFilter?: string;
    includeNodeInternals?: boolean;
  }): Promise<{
    totalFunctions: number;
    functions: Array<{
      url: string;
      functionName: string;
      startOffset: number;
      endOffset: number;
      count: number;
    }>;
  }> {
    if (!this.traceActive) {
      return { totalFunctions: 0, functions: [] };
    }
    const cov = (await this.cdp.Profiler.takePreciseCoverage()) as {
      result: Array<{
        scriptId: string;
        url: string;
        functions: Array<{
          functionName: string;
          ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
        }>;
      }>;
    };
    await this.cdp.Profiler.stopPreciseCoverage();
    await this.cdp.Profiler.disable();
    this.traceActive = false;

    const include = !!opts.includeNodeInternals;
    const filter = opts.urlFilter;
    const flat: Array<{
      url: string;
      functionName: string;
      startOffset: number;
      endOffset: number;
      count: number;
    }> = [];
    for (const script of cov.result) {
      if (!include && isInternalUrl(script.url)) continue;
      if (filter && !script.url.includes(filter)) continue;
      for (const fn of script.functions) {
        // The first range covers the full function body; its count is the
        // function's invocation count.
        const top = fn.ranges[0];
        if (!top || top.count === 0) continue;
        flat.push({
          url: script.url,
          functionName: fn.functionName || "<anonymous>",
          startOffset: top.startOffset,
          endOffset: top.endOffset,
          count: top.count,
        });
      }
    }
    flat.sort((a, b) => b.count - a.count);
    const topN = opts.topN ?? 50;
    return { totalFunctions: flat.length, functions: flat.slice(0, topN) };
  }

  /**
   * Snapshot what's currently holding the Node event loop open.
   * Uses process._getActiveHandles() / _getActiveRequests() (private but
   * stable APIs) — the same data `node --trace-exit` shows. Useful for
   * "why won't this script exit" and "what's pending."
   */
  async getEventLoopStatus(): Promise<
    | { error: string }
    | {
        uptime: number;
        eventLoopUtilization: number;
        handles: Array<{ index: number; type: string; summary?: string; localObjectId?: string }>;
        requests: Array<{ index: number; type: string; summary?: string; localObjectId?: string }>;
      }
  > {
    const expr = `(() => {
      const out = { uptime: process.uptime(), handles: [], requests: [], eventLoopUtilization: 0 };
      try {
        const perf = require('node:perf_hooks');
        const elu = perf.performance.eventLoopUtilization();
        out.eventLoopUtilization = elu.utilization;
      } catch (e) {}
      try {
        for (const [i, h] of process._getActiveHandles().entries()) {
          const t = h && h.constructor ? h.constructor.name : typeof h;
          const summary = (() => {
            try {
              if (t === "Timeout") return "after " + (h._idleTimeout || h._repeat || "?") + "ms";
              if (t === "Socket" || t === "TLSSocket") return (h.remoteAddress || "?") + ":" + (h.remotePort || "?");
              if (t === "Server") return "listening " + (h.address && JSON.stringify(h.address()));
              if (t === "ReadStream" || t === "WriteStream") return h.path || h.fd;
              if (t === "ChildProcess") return "pid " + h.pid;
              return undefined;
            } catch (e) { return undefined; }
          })();
          out.handles.push({ index: i, type: t, summary, ref: h });
        }
      } catch (e) {}
      try {
        for (const [i, r] of process._getActiveRequests().entries()) {
          const t = r && r.constructor ? r.constructor.name : typeof r;
          out.requests.push({ index: i, type: t, ref: r });
        }
      } catch (e) {}
      return out;
    })()`;

    const res = (await this.cdp.Runtime.evaluate({
      expression: expr,
      returnByValue: false,
      generatePreview: false,
    })) as { result: RemoteObjectLike; exceptionDetails?: { text: string } };

    if (res.exceptionDetails) return { error: res.exceptionDetails.text };
    if (!res.result.objectId) return { error: "evaluation did not return an object" };

    // Walk the result object's properties to extract the structured fields.
    const top = (await this.cdp.Runtime.getProperties({
      objectId: res.result.objectId,
      ownProperties: true,
    })) as { result: Array<{ name: string; value?: RemoteObjectLike }> };

    let uptime = 0;
    let elu = 0;
    let handlesObjId: string | undefined;
    let requestsObjId: string | undefined;
    for (const p of top.result) {
      if (p.name === "uptime") uptime = Number(p.value?.value ?? 0);
      else if (p.name === "eventLoopUtilization") elu = Number(p.value?.value ?? 0);
      else if (p.name === "handles") handlesObjId = p.value?.objectId;
      else if (p.name === "requests") requestsObjId = p.value?.objectId;
    }

    const expandArray = async (
      arrayId: string | undefined,
    ): Promise<Array<{ index: number; type: string; summary?: string; localObjectId?: string }>> => {
      if (!arrayId) return [];
      const arr = (await this.cdp.Runtime.getProperties({
        objectId: arrayId,
        ownProperties: true,
      })) as { result: Array<{ name: string; value?: RemoteObjectLike }> };
      const out: Array<{ index: number; type: string; summary?: string; localObjectId?: string }> = [];
      for (const entry of arr.result) {
        if (!/^\d+$/.test(entry.name)) continue;
        const v = entry.value;
        if (!v || v.type !== "object" || !v.objectId) continue;
        const inner = (await this.cdp.Runtime.getProperties({
          objectId: v.objectId,
          ownProperties: true,
        })) as { result: Array<{ name: string; value?: RemoteObjectLike }> };
        let index = -1;
        let type = "?";
        let summary: string | undefined;
        let refId: string | undefined;
        for (const ip of inner.result) {
          if (ip.name === "index") index = Number(ip.value?.value ?? -1);
          else if (ip.name === "type") type = String(ip.value?.value ?? "?");
          else if (ip.name === "summary" && ip.value?.value !== undefined) summary = String(ip.value.value);
          else if (ip.name === "ref" && ip.value?.objectId) refId = ip.value.objectId;
        }
        out.push({
          index,
          type,
          ...(summary ? { summary } : {}),
          ...(refId ? { localObjectId: this.objects.mint(refId) } : {}),
        });
      }
      return out;
    };

    return {
      uptime,
      eventLoopUtilization: elu,
      handles: await expandArray(handlesObjId),
      requests: await expandArray(requestsObjId),
    };
  }

  listScripts(opts: { includeNodeInternals?: boolean; urlFilter?: string }): {
    scriptId: string;
    url: string;
  }[] {
    const out: { scriptId: string; url: string }[] = [];
    for (const s of this.scripts.values()) {
      const isInternal = s.url.startsWith("node:") || s.url === "";
      if (isInternal && !opts.includeNodeInternals) continue;
      if (opts.urlFilter && !s.url.includes(opts.urlFilter)) continue;
      out.push({ scriptId: s.scriptId, url: s.url });
    }
    return out;
  }

  async disconnect(opts: { kill?: boolean } = {}): Promise<void> {
    try {
      await this.cdp.close();
    } catch {
      // ignore
    }
    if (opts.kill && this.child && this.exitCode === null) {
      this.child.kill("SIGTERM");
    }
    this.status = "terminated";
  }

  snapshot(): Record<string, unknown> {
    return {
      id: this.id,
      mode: this.mode,
      parentSessionId: this.parentSessionId ?? null,
      childSessionIds: Array.from(this.childSessionIds),
      pid: this.pid ?? null,
      cmdline: this.cmdline ?? null,
      status: this.status,
      exitCode: this.exitCode,
      pauseState: this.pauseState,
    };
  }

  breakpointRecords(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = Array.from(this.breakpoints.values()).map(
      (b) => ({
        id: b.id,
        kind: b.kind,
        file: b.file ?? null,
        line: b.line ?? null,
        column: b.column ?? null,
        condition: b.condition ?? null,
        expression: b.expression ?? null,
        urlPattern: b.urlPattern ?? null,
        hitCount: b.hitCount,
        hitCountThreshold: b.hitCountThreshold ?? null,
        temporary: b.temporary ?? false,
        enabled: b.enabled,
        resolved: b.resolved,
      }),
    );
    if (this.exceptionPause !== "none") {
      out.push({
        id: "exception",
        kind: "exception",
        state: this.exceptionPause,
        enabled: true,
        hitCount: 0,
      });
    }
    return out;
  }
}

function isInternalUrl(url: string): boolean {
  if (!url) return true;
  if (url.startsWith("node:")) return true;
  if (url.startsWith("node:internal/")) return true;
  // Heuristic for inspector-injected scripts (e.g. our shim, eval frames).
  if (url.includes("/node-debugger-mcp/bootstrap-") && url.endsWith(".cjs")) return true;
  return false;
}

function summariseAsyncStack(
  raw: RawAsyncStackTrace,
  maxBoundaries = 3,
  maxFramesPerBoundary = 3,
): AsyncStackEntry[] {
  const out: AsyncStackEntry[] = [];
  let cur: RawAsyncStackTrace | undefined = raw;
  while (cur && out.length < maxBoundaries) {
    const userFrames = (cur.callFrames ?? [])
      .filter((f) => !isInternalUrl(f.url))
      .slice(0, maxFramesPerBoundary)
      .map((f) => ({
        functionName: f.functionName || "<anonymous>",
        url: f.url,
        line: f.lineNumber,
      }));
    if (userFrames.length > 0) {
      out.push({
        description: cur.description ?? "async",
        frames: userFrames,
      });
    }
    cur = cur.parent;
  }
  return out;
}

function extractClassName(description?: string): string | undefined {
  if (!description) return undefined;
  // Stack-shaped strings start with "TypeError: ..." or "Error: ..."
  const m = description.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?::|\s+at\b)/);
  return m?.[1];
}

function renderSnippet(source: string, line0: number): string {
  const lines = source.split("\n");
  const from = Math.max(0, line0 - 2);
  const to = Math.min(lines.length - 1, line0 + 2);
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    const marker = i === line0 ? ">" : " ";
    out.push(`${marker} ${i + 1}: ${lines[i] ?? ""}`);
  }
  return out.join("\n");
}

async function pollForTarget(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://${host}:${port}/json/list`);
      if (res.ok) {
        const list = (await res.json()) as Array<{
          webSocketDebuggerUrl?: string;
          type?: string;
          title?: string;
        }>;
        if (Array.isArray(list) && list.length > 0) {
          const target = list.find((t) => t.webSocketDebuggerUrl) ?? list[0];
          if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
        }
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `timed out polling http://${host}:${port}/json/list${lastErr ? `: ${String(lastErr)}` : ""}`,
  );
}

function mergeNodeOptions(existing: string | undefined, flag: string): string {
  if (!existing) return flag;
  if (existing.includes(flag)) return existing;
  return `${existing} ${flag}`;
}

/**
 * Install a persistent stderr parser on the child. Always captures every
 * chunk into the session's ring buffer, and inspects each line for the
 * "Debugger listening on ws://..." announce.
 *
 * The first announce resolves the returned Promise (the root's ws URL).
 * Subsequent announces (from descendant Node processes that inherit our
 * stderr) are passed to `onAutoChild`.
 */
function createStderrAnnounceParser(
  child: ChildProcess,
  session: Session,
  onAutoChild?: AutoChildHandler,
): Promise<string> {
  return new Promise((resolveRoot, rejectRoot) => {
    let buffer = "";
    let rootResolved = false;
    const seenUrls = new Set<string>();

    const onData = (buf: Buffer) => {
      const chunk = buf.toString("utf8");
      buffer += chunk;
      session.stderr.push(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const m = LISTEN_RE.exec(line);
        if (!m) continue;
        const url = m[1]!;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        if (!rootResolved) {
          rootResolved = true;
          resolveRoot(url);
        } else if (onAutoChild) {
          // Don't block stderr processing on the auto-attach; report failures via log.
          onAutoChild(url).catch((err) =>
            log.error(`auto-attach for ${url} failed: ${String(err)}`),
          );
        }
      }
    };

    child.stderr?.on("data", onData);
    child.once("exit", () => {
      if (!rootResolved) rejectRoot(new Error("target exited before announcing inspector"));
    });
    setTimeout(() => {
      if (!rootResolved) {
        rejectRoot(new Error("timed out waiting for 'Debugger listening on ws://...'"));
      }
    }, 10_000);
  });
}
