import { spawn as childSpawn, spawnSync as childSpawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createLogger, randomId, safeJsonParse, safePathJoin, toErrorMessage } from "./util.mjs";

export const FULL_HANDLING_BUCKET = [
  "ready",
  "fetch",
  "cancel-fetch",
  "fetch-stream",
  "cancel-fetch-stream",
  "mcp-request",
  "mcp-response",
  "mcp-notification",
  "terminal-create",
  "terminal-attach",
  "terminal-write",
  "terminal-resize",
  "terminal-close",
  "persisted-atom-sync-request",
  "persisted-atom-update",
  "persisted-atom-reset",
  "shared-object-subscribe",
  "shared-object-set",
  "shared-object-unsubscribe",
  "thread-archived",
  "thread-unarchived",
  "archive-thread",
  "unarchive-thread",
  "thread-stream-state-changed",
  "thread-overlay-proxy-start-turn-request",
  "thread-overlay-proxy-start-turn-response",
  "thread-overlay-proxy-interrupt-request",
  "thread-overlay-proxy-interrupt-response",
  "worker-request",
  "worker-request-cancel",
  "set-telemetry-user",
  "view-focused"
];

export const BROWSER_EQUIVALENT_BUCKET = [
  "open-in-browser",
  "show-diff",
  "show-plan-summary",
  "navigate-in-new-editor-tab"
];

export const GRACEFUL_UNSUPPORTED_BUCKET = [
  "install-wsl",
  "install-app-update",
  "open-extension-settings",
  "open-vscode-command",
  "open-keyboard-shortcuts",
  "open-debug-window",
  "electron-request-microphone-permission"
];

const NATIVE_UNSUPPORTED = new Set(GRACEFUL_UNSUPPORTED_BUCKET);
const IPC_BROADCAST_FORWARD_METHODS = new Set([
  "thread-archived",
  "thread-unarchived",
  "thread-title-updated",
  "pinned-threads-updated",
  "automation-runs-updated",
  "custom-prompts-updated",
  "active-workspace-roots-updated",
  "workspace-root-options-updated"
]);

const DEFAULT_CONFIGURATION_VALUES = Object.freeze({
  appearanceTheme: "system",
  appearanceLightCodeThemeId: "codex",
  appearanceDarkCodeThemeId: "codex"
});

const DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT = Object.freeze({
  apps: true,
  plugins: true,
  tool_call_mcp_elicitation: true,
  tool_search: true,
  tool_suggest: false
});

class TerminalRegistry {
  constructor(sendToWs, logger) {
    this.sendToWs = sendToWs;
    this.logger = logger;
    this.sessions = new Map();
    this.bunPtyAvailable = this._detectBunPtyAvailability();
    this.loggedBunPtyFailure = false;
    this.pythonPtyAvailable = this._detectPythonPtyAvailability();
    this.loggedPythonPtyFailure = false;
    this.hasPtyLikeRuntime = this.bunPtyAvailable || this.pythonPtyAvailable;
  }

  createOrAttach(ws, message) {
    const sessionId = message.sessionId || randomId(8);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.listeners.add(ws);
      this.sendToWs(ws, {
        type: "terminal-attached",
        sessionId,
        cwd: existing.cwd,
        shell: existing.shell
      });
      this.sendToWs(ws, {
        type: "terminal-init-log",
        sessionId,
        log: existing.attachLog
      });
      if (this._hasExplicitDimensions(message)) {
        this.resize(sessionId, message.cols, message.rows);
      }
      return;
    }

    const launchConfig = this._resolveLaunchConfig(message);
    let runtime;
    try {
      runtime = this._spawnRuntime(launchConfig, message);
    } catch (error) {
      this.sendToWs(ws, {
        type: "terminal-error",
        sessionId,
        message: toErrorMessage(error)
      });
      this.logger.warn("Terminal spawn failed", {
        sessionId,
        error: toErrorMessage(error)
      });
      return;
    }

    const attachLogLines = [
      `Terminal attached via codex-app-linux web (${runtime.mode})`
    ];
    if (launchConfig.cwdWasFallback && launchConfig.requestedCwd) {
      attachLogLines.push(`[webstrap] Requested cwd unavailable: ${launchConfig.requestedCwd}`);
      attachLogLines.push(`[webstrap] Using cwd: ${launchConfig.cwd}`);
    }
    const attachLog = `${attachLogLines.join("\r\n")}\r\n`;

    const session = {
      sessionId,
      listeners: new Set([ws]),
      cwd: launchConfig.cwd,
      shell: launchConfig.shell,
      attachLog,
      cols: runtime.cols ?? this._coerceDimension(message?.cols, 120),
      rows: runtime.rows ?? this._coerceDimension(message?.rows, 30),
      ...runtime
    };

    this.sessions.set(sessionId, session);

    this.sendToWs(ws, {
      type: "terminal-attached",
      sessionId,
      cwd: session.cwd,
      shell: session.shell
    });
    this.sendToWs(ws, {
      type: "terminal-init-log",
      sessionId,
      log: session.attachLog
    });

    if (session.mode === "bun-pty") {
      this._attachBunPtyProcess(sessionId, session);
      return;
    }

    session.proc.stdout?.on("data", (chunk) => {
      this._broadcast(sessionId, {
        type: "terminal-data",
        sessionId,
        data: chunk.toString("utf8")
      });
    });

    session.proc.stderr?.on("data", (chunk) => {
      this._broadcast(sessionId, {
        type: "terminal-data",
        sessionId,
        data: chunk.toString("utf8")
      });
    });

    session.proc.on("error", (error) => {
      this._broadcast(sessionId, {
        type: "terminal-error",
        sessionId,
        message: toErrorMessage(error)
      });
    });

    session.proc.on("exit", (code, signal) => {
      this._broadcast(sessionId, {
        type: "terminal-exit",
        sessionId,
        code,
        signal
      });
      this.sessions.delete(sessionId);
    });
  }

  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.mode === "bun-pty") {
      try {
        this._writeToBunPty(session, {
          type: "write",
          data
        });
      } catch (error) {
        this._broadcast(sessionId, {
          type: "terminal-error",
          sessionId,
          message: toErrorMessage(error)
        });
      }
      return;
    }

    if (!session.proc.stdin || session.proc.stdin.destroyed) {
      return;
    }

    try {
      session.proc.stdin.write(data);
    } catch (error) {
      this._broadcast(sessionId, {
        type: "terminal-error",
        sessionId,
        message: toErrorMessage(error)
      });
    }
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.mode === "bun-pty") {
      try {
        const nextCols = this._coerceDimension(cols, session.cols || 120);
        const nextRows = this._coerceDimension(rows, session.rows || 30);
        this._writeToBunPty(session, {
          type: "resize",
          cols: nextCols,
          rows: nextRows
        });
        session.cols = nextCols;
        session.rows = nextRows;
      } catch (error) {
        this._broadcast(sessionId, {
          type: "terminal-error",
          sessionId,
          message: toErrorMessage(error)
        });
      }
      return;
    }

    if (session.mode !== "python-pty") {
      this.logger.debug("Terminal resize ignored (non-PTY mode)", { sessionId });
      return;
    }
  }

  close(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.mode === "bun-pty") {
      try {
        this._writeToBunPty(session, {
          type: "close"
        });
      } catch (error) {
        this.logger.debug("Bun PTY close command failed", {
          sessionId,
          error: toErrorMessage(error)
        });
      }
      if (!session.proc.killed) {
        session.proc.kill();
      }
      this.sessions.delete(sessionId);
      return;
    }

    if (!session.proc.killed) {
      session.proc.kill();
    }
    this.sessions.delete(sessionId);
  }

  removeListener(ws) {
    for (const [sessionId, session] of this.sessions.entries()) {
      session.listeners.delete(ws);
      if (session.listeners.size === 0) {
        this.close(sessionId);
      }
    }
  }

  dispose() {
    for (const sessionId of this.sessions.keys()) {
      this.close(sessionId);
    }
  }

  _broadcast(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    for (const listener of session.listeners) {
      this.sendToWs(listener, message);
    }
  }

  _resolveLaunchConfig(message) {
    const requestedCwd = typeof message?.cwd === "string" ? message.cwd.trim() : "";
    const cwdResult = this._resolveCwd(requestedCwd);

    const commandFromMessage = Array.isArray(message?.command)
      ? message.command.filter((entry) => typeof entry === "string" && entry.length > 0)
      : [];

    let command = commandFromMessage;
    let shell = null;

    if (command.length === 0) {
      shell = this._resolveShellPath(message?.shell);
      command = this._defaultShellCommand(shell);
    } else {
      shell = command[0];
    }

    return {
      command,
      shell,
      cwd: cwdResult.cwd,
      requestedCwd: cwdResult.requestedCwd,
      cwdWasFallback: cwdResult.cwdWasFallback,
      env: this._buildEnv(message?.env)
    };
  }

  _spawnRuntime(launchConfig, message) {
    const bunPtyRuntime = this._spawnBunPtyRuntime(launchConfig, message);
    if (bunPtyRuntime) {
      return bunPtyRuntime;
    }

    const pythonPtyRuntime = this._spawnPythonPtyRuntime(launchConfig);
    if (pythonPtyRuntime) {
      return pythonPtyRuntime;
    }

    const [bin, ...args] = launchConfig.command;
    const proc = childSpawn(bin, args, {
      cwd: launchConfig.cwd,
      env: launchConfig.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    return {
      mode: "pipe",
      proc,
      cols: this._coerceDimension(message?.cols, 120),
      rows: this._coerceDimension(message?.rows, 30)
    };
  }

  _spawnBunPtyRuntime(launchConfig, message) {
    if (!this.bunPtyAvailable) {
      return null;
    }

    const [bin, ...args] = launchConfig.command;
    try {
      const bridgePath = fileURLToPath(new URL("./bun-pty-bridge.mjs", import.meta.url));
      const initialCols = this._coerceDimension(message?.cols, 120);
      const initialRows = this._coerceDimension(message?.rows, 30);
      const config = JSON.stringify({
        file: bin,
        args,
        cwd: launchConfig.cwd,
        env: launchConfig.env,
        cols: initialCols,
        rows: initialRows,
        term: launchConfig.env.TERM || "xterm-256color"
      });

      const proc = childSpawn("bun", [bridgePath], {
        cwd: launchConfig.cwd,
        env: {
          ...launchConfig.env,
          CODEX_WEBSTRAP_BUN_PTY_CONFIG: config
        },
        stdio: ["pipe", "pipe", "pipe"]
      });

      return {
        mode: "bun-pty",
        proc,
        bunStdoutBuffer: "",
        cols: initialCols,
        rows: initialRows
      };
    } catch (error) {
      this.bunPtyAvailable = false;
      if (!this.loggedBunPtyFailure) {
        this.loggedBunPtyFailure = true;
        this.logger.warn("Bun PTY unavailable; falling back", {
          error: toErrorMessage(error)
        });
      }
      return null;
    }
  }

  _spawnPythonPtyRuntime(launchConfig) {
    if (!this.pythonPtyAvailable) {
      return null;
    }

    const [bin, ...args] = launchConfig.command;
    try {
      const proc = childSpawn(
        "python3",
        [
          "-c",
          "import pty, sys; pty.spawn(sys.argv[1:])",
          bin,
          ...args
        ],
        {
          cwd: launchConfig.cwd,
          env: launchConfig.env,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      return {
        mode: "python-pty",
        proc,
        cols: 120,
        rows: 30
      };
    } catch (error) {
      this.pythonPtyAvailable = false;
      if (!this.loggedPythonPtyFailure) {
        this.loggedPythonPtyFailure = true;
        this.logger.warn("python3 PTY fallback unavailable; using pipe terminal", {
          error: toErrorMessage(error)
        });
      }
      return null;
    }
  }

  _attachBunPtyProcess(sessionId, session) {
    const handleBridgeLine = (line) => {
      const parsed = safeJsonParse(line);
      if (!parsed || typeof parsed !== "object") {
        return;
      }

      if (parsed.type === "data") {
        this._broadcast(sessionId, {
          type: "terminal-data",
          sessionId,
          data: typeof parsed.data === "string" ? parsed.data : ""
        });
        return;
      }

      if (parsed.type === "error") {
        this._broadcast(sessionId, {
          type: "terminal-error",
          sessionId,
          message: typeof parsed.message === "string" ? parsed.message : "bun-pty bridge error"
        });
        return;
      }

      if (parsed.type === "exit") {
        this._broadcast(sessionId, {
          type: "terminal-exit",
          sessionId,
          code: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
          signal: parsed.signal ?? null
        });
        this.sessions.delete(sessionId);
      }
    };

    session.proc.stdout?.on("data", (chunk) => {
      session.bunStdoutBuffer += chunk.toString("utf8");
      for (;;) {
        const newlineAt = session.bunStdoutBuffer.indexOf("\n");
        if (newlineAt < 0) {
          break;
        }
        const line = session.bunStdoutBuffer.slice(0, newlineAt);
        session.bunStdoutBuffer = session.bunStdoutBuffer.slice(newlineAt + 1);
        if (line.trim().length === 0) {
          continue;
        }
        handleBridgeLine(line);
      }
    });

    session.proc.stderr?.on("data", (chunk) => {
      this._broadcast(sessionId, {
        type: "terminal-error",
        sessionId,
        message: chunk.toString("utf8")
      });
    });

    session.proc.on("error", (error) => {
      this._broadcast(sessionId, {
        type: "terminal-error",
        sessionId,
        message: toErrorMessage(error)
      });
    });

    session.proc.on("exit", (code, signal) => {
      if (!this.sessions.has(sessionId)) {
        return;
      }
      this._broadcast(sessionId, {
        type: "terminal-exit",
        sessionId,
        code,
        signal
      });
      this.sessions.delete(sessionId);
    });
  }

  _writeToBunPty(session, payload) {
    if (!session?.proc?.stdin || session.proc.stdin.destroyed) {
      return;
    }
    session.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _detectBunPtyAvailability() {
    const hasBun = childSpawnSync("bun", ["--version"], { stdio: "ignore" });
    if (hasBun.status !== 0 || hasBun.error) {
      return false;
    }

    const probe = childSpawnSync(
      "bun",
      ["-e", "import 'bun-pty';"],
      { stdio: "ignore" }
    );
    return probe.status === 0 && !probe.error;
  }

  _detectPythonPtyAvailability() {
    const probe = childSpawnSync(
      "python3",
      ["-c", "import pty"],
      { stdio: "ignore" }
    );
    return probe.status === 0 && !probe.error;
  }

  _buildEnv(messageEnv) {
    const env = {
      ...process.env,
      ...(messageEnv && typeof messageEnv === "object" ? messageEnv : {})
    };

    if (!env.TERM || env.TERM === "dumb") {
      env.TERM = "xterm-256color";
    }
    if (!env.COLORTERM) {
      env.COLORTERM = "truecolor";
    }
    if (!env.TERM_PROGRAM) {
      env.TERM_PROGRAM = "codex-app-linux-web";
    }
    return env;
  }

  _resolveShellPath(messageShell) {
    if (typeof messageShell === "string" && messageShell.trim().length > 0) {
      return messageShell.trim();
    }
    return process.env.SHELL || "/bin/zsh";
  }

  _defaultShellCommand(shellPath) {
    const shellName = path.basename(shellPath).toLowerCase();
    const disableProfileLoad = process.env.CODEX_WEBSTRAP_TERMINAL_NO_PROFILE === "1";
    const preferLoginProfile = this.hasPtyLikeRuntime && !disableProfileLoad;

    if (shellName === "zsh") {
      return preferLoginProfile
        ? [shellPath, "-il"]
        : [shellPath, "-fi"];
    }
    if (shellName === "bash") {
      return preferLoginProfile
        ? [shellPath, "-il"]
        : [shellPath, "--noprofile", "--norc", "-i"];
    }
    if (shellName === "fish") {
      return preferLoginProfile
        ? [shellPath, "-il"]
        : [shellPath, "-i"];
    }
    return [shellPath, "-i"];
  }

  _resolveCwd(requestedCwd) {
    const requested = requestedCwd && requestedCwd.length > 0
      ? path.resolve(requestedCwd)
      : null;
    if (requested && this._isDirectory(requested)) {
      return {
        cwd: requested,
        requestedCwd: requested,
        cwdWasFallback: false
      };
    }

    const fallbackCandidates = [process.cwd(), os.homedir(), "/"];
    const fallback = fallbackCandidates.find((candidate) => this._isDirectory(candidate)) || process.cwd();
    return {
      cwd: fallback,
      requestedCwd: requested,
      cwdWasFallback: Boolean(requested)
    };
  }

  _isDirectory(candidatePath) {
    if (!candidatePath || typeof candidatePath !== "string") {
      return false;
    }
    try {
      return statSync(candidatePath).isDirectory();
    } catch {
      return false;
    }
  }

  _coerceDimension(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.max(1, Math.floor(parsed));
  }

  _hasExplicitDimensions(message) {
    const cols = Number(message?.cols);
    const rows = Number(message?.rows);
    return Number.isFinite(cols) && cols > 0 && Number.isFinite(rows) && rows > 0;
  }
}

class GitWorkerBridge {
  constructor({ workerPath, sendWorkerEvent, logger, sentryInitOptions }) {
    this.workerPath = workerPath;
    this.sendWorkerEvent = sendWorkerEvent;
    this.logger = logger;
    this.sentryInitOptions = sentryInitOptions || {};
    this.worker = null;
    this.pendingByRequestId = new Map();
  }

  async isAvailable() {
    if (!this.workerPath) {
      return false;
    }

    try {
      await fs.access(this.workerPath);
      return true;
    } catch {
      return false;
    }
  }

  async postMessage(ws, payload) {
    if (!(await this.isAvailable())) {
      this.sendWorkerEvent(ws, "git", {
        type: "worker-response",
        workerId: "git",
        response: {
          id: payload?.request?.id || payload?.id,
          ok: false,
          error: "git worker unavailable"
        }
      });
      return;
    }

    this._ensureWorker();

    if (payload.type === "worker-request" && payload.request?.id) {
      this.pendingByRequestId.set(payload.request.id, ws);
    }

    if (payload.type === "worker-request-cancel" && payload.id) {
      this.pendingByRequestId.delete(payload.id);
    }

    this.worker.postMessage(payload);
  }

  removeClient(ws) {
    for (const [requestId, owner] of this.pendingByRequestId.entries()) {
      if (owner === ws) {
        this.pendingByRequestId.delete(requestId);
      }
    }
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingByRequestId.clear();
  }

  _ensureWorker() {
    if (this.worker) {
      return;
    }

    this.worker = new Worker(this.workerPath, {
      workerData: {
        workerId: "git",
        sentryInitOptions: this.sentryInitOptions,
        maxLogLevel: "info",
        sentryRewriteFramesRoot: process.cwd()
      }
    });

    this.worker.on("message", (message) => {
      if (message?.type === "worker-response" && message?.response?.id) {
        const owner = this.pendingByRequestId.get(message.response.id);
        if (owner) {
          this.pendingByRequestId.delete(message.response.id);
          this.sendWorkerEvent(owner, "git", message);
          return;
        }
      }

      // Broadcast unknown worker events to all connected clients.
      this.sendWorkerEvent(null, "git", message);
    });

    this.worker.on("error", (error) => {
      this.logger.warn("Git worker error", { error: toErrorMessage(error) });
    });

    this.worker.on("exit", (code) => {
      this.logger.warn("Git worker exited", { code });
      this.worker = null;
    });
  }
}

export class MessageRouter {
  constructor({ appServer, udsClient, workerPath, hostConfig, logger, globalStatePath, extensionInfo }) {
    this.logger = logger || createLogger("router");
    this.appServer = appServer;
    this.udsClient = udsClient;
    this.hostConfig = hostConfig || {
      id: "local",
      display_name: "Codex",
      kind: "local"
    };
    this.extensionInfo = extensionInfo || {
      name: "codex-webstrapper",
      version: "0.1.0",
      platform: process.platform,
      uiKind: "desktop"
    };

    this.clients = new Set();
    this.fetchControllers = new Map();
    this.persistedAtomState = new Map();
    this.sharedObjects = new Map();
    this.sharedObjectSubscribers = new Map();
    this.lastAccountRead = null;
    this.defaultWorkspaceRoot = process.cwd();
    this.workspaceRootOptions = {
      roots: [this.defaultWorkspaceRoot],
      labels: {}
    };
    this.activeWorkspaceRoots = [this.defaultWorkspaceRoot];
    this.userSelectedActiveWorkspaceRoots = false;
    this.globalStatePath = globalStatePath || path.join(os.homedir(), ".codex", ".codex-global-state.json");
    this.globalState = {};
    this.globalStateWriteTimer = null;
    this._loadPersistedGlobalState();
    this._persistWorkspaceState({ writeToDisk: false });
    this.sharedObjects.set("host_config", this.hostConfig);

    this.terminals = new TerminalRegistry((ws, payload) => {
      this.sendMainMessage(ws, payload);
    }, this.logger);

    this.gitWorker = new GitWorkerBridge({
      workerPath,
      sendWorkerEvent: (ws, workerId, payload) => {
        if (ws) {
          this.sendWorkerEvent(ws, workerId, payload);
          return;
        }
        this.broadcastWorkerEvent(workerId, payload);
      },
      logger: this.logger,
      sentryInitOptions: {
        appVersion: this.extensionInfo?.version || "0.0.0"
      }
    });

    this._wireBackends();
  }

  _wireBackends() {
    if (this.appServer) {
      this.appServer.on("initialized", () => {
        this.broadcastMainMessage({
          type: "codex-app-server-initialized"
        });
      });

      this.appServer.on("notification", (notification) => {
        this.broadcastMainMessage({
          type: "mcp-notification",
          method: notification?.method,
          params: notification?.params ?? {}
        });
      });

      this.appServer.on("request", (request) => {
        this.broadcastMainMessage({ type: "mcp-request", request });
      });

      this.appServer.on("connection-changed", (state) => {
        this.broadcastMainMessage({
          type: "codex-app-server-connection-changed",
          state: state.connected ? "connected" : "disconnected",
          transport: state.transportKind
        });
      });
    }

    if (this.udsClient) {
      this.udsClient.on("broadcast", (message) => {
        if (!IPC_BROADCAST_FORWARD_METHODS.has(message.method)) {
          return;
        }
        this.broadcastMainMessage({
          type: "ipc-broadcast",
          method: message.method,
          sourceClientId: message.sourceClientId,
          version: message.version,
          params: message.params
        });
      });
    }
  }

  registerClient(ws) {
    this.clients.add(ws);

    this.sendBridgeEnvelope(ws, {
      type: "bridge-ready",
      payload: {
        ts: Date.now()
      }
    });

    if (this.appServer) {
      const state = this.appServer.getState();
      this.sendMainMessage(ws, {
        type: "codex-app-server-connection-changed",
        state: state.connected ? "connected" : "disconnected",
        transport: state.transportKind
      });
      if (state.initialized) {
        this.sendMainMessage(ws, {
          type: "codex-app-server-initialized"
        });
      }
    }
  }

  unregisterClient(ws) {
    this.clients.delete(ws);
    this.terminals.removeListener(ws);
    this.gitWorker.removeClient(ws);

    for (const subscribers of this.sharedObjectSubscribers.values()) {
      subscribers.delete(ws);
    }
  }

  dispose() {
    if (this.globalStateWriteTimer) {
      clearTimeout(this.globalStateWriteTimer);
      this.globalStateWriteTimer = null;
      void this._writeGlobalStateToDisk();
    }

    this.terminals.dispose();
    this.gitWorker.dispose();

    for (const controller of this.fetchControllers.values()) {
      controller.abort();
    }
    this.fetchControllers.clear();
  }

  async handleEnvelope(ws, envelope) {
    if (!envelope || typeof envelope !== "object") {
      this.sendBridgeError(ws, "invalid_envelope", "Envelope must be a JSON object.");
      return;
    }

    switch (envelope.type) {
      case "view-message": {
        await this._handleViewMessage(ws, envelope.payload);
        return;
      }
      case "worker-message": {
        const workerId = envelope.workerId || envelope.payload?.workerId || "git";
        await this._handleWorkerMessage(ws, workerId, envelope.payload);
        return;
      }
      default: {
        this.sendBridgeError(ws, "unsupported_envelope_type", `Unsupported envelope type: ${envelope.type}`);
      }
    }
  }

  async _handleViewMessage(ws, message) {
    if (!message || typeof message !== "object") {
      this.sendBridgeError(ws, "invalid_view_message", "View payload must be an object.");
      return;
    }

    const type = message.type;

    if (!type) {
      this.sendBridgeError(ws, "missing_message_type", "View payload is missing `type`.");
      return;
    }

    try {
      this.logger.debug("renderer-message", {
        type
      });
      switch (type) {
        case "ready":
          this._handleReady(ws);
          return;
        case "electron-window-focus-request":
          this.sendMainMessage(ws, {
            type: "electron-window-focus-changed",
            isFocused: true
          });
          return;
        case "log-message":
          this.logger.debug("renderer-log-message", {
            level: message.level || "info",
            message: typeof message.message === "string" ? message.message.slice(0, 500) : null
          });
          return;
        case "fetch":
          await this._handleFetch(ws, message);
          return;
        case "cancel-fetch":
          this._handleCancelFetch(message);
          return;
        case "fetch-stream":
          this.sendMainMessage(ws, {
            type: "fetch-stream-error",
            requestId: message.requestId,
            error: "Streaming fetch is not implemented in webstrapper."
          });
          return;
        case "cancel-fetch-stream":
          return;
        case "mcp-request":
          await this._forwardToAppServer(ws, message.request || message.payload || message);
          return;
        case "mcp-response":
          await this._forwardToAppServer(ws, message.response || message.payload || message);
          return;
        case "mcp-notification":
          await this._forwardToAppServer(ws, message.notification || message.payload || message);
          return;
        case "terminal-create":
        case "terminal-attach":
          this.terminals.createOrAttach(ws, message);
          return;
        case "terminal-write":
          this.terminals.write(message.sessionId, message.data || "");
          return;
        case "terminal-resize":
          this.terminals.resize(message.sessionId, message.cols, message.rows);
          return;
        case "terminal-close":
          this.terminals.close(message.sessionId);
          return;
        case "persisted-atom-sync-request":
          this.sendMainMessage(ws, {
            type: "persisted-atom-sync",
            state: Object.fromEntries(this.persistedAtomState.entries())
          });
          return;
        case "persisted-atom-update":
          if (message.key) {
            this.persistedAtomState.set(message.key, message.value);
            this.broadcastMainMessage({
              type: "persisted-atom-updated",
              key: message.key,
              value: message.value
            });
            this._scheduleGlobalStateWrite();
          }
          return;
        case "persisted-atom-reset":
          if (message.key) {
            this.persistedAtomState.delete(message.key);
            this.broadcastMainMessage({
              type: "persisted-atom-updated",
              key: message.key,
              value: null
            });
            this._scheduleGlobalStateWrite();
          }
          return;
        case "shared-object-subscribe":
          this._subscribeSharedObject(ws, message.key);
          return;
        case "shared-object-set":
          this._setSharedObject(message.key, message.value);
          return;
        case "shared-object-unsubscribe":
          this._unsubscribeSharedObject(ws, message.key);
          return;
        case "archive-thread":
          await this._archiveThread(ws, message);
          return;
        case "unarchive-thread":
          await this._unarchiveThread(ws, message);
          return;
        case "thread-archived":
        case "thread-unarchived":
        case "thread-stream-state-changed":
        case "thread-overlay-proxy-start-turn-response":
        case "thread-overlay-proxy-interrupt-response":
        case "set-telemetry-user":
        case "view-focused":
          return;
        case "thread-overlay-proxy-start-turn-request":
          await this._handleThreadOverlayStartTurn(ws, message);
          return;
        case "thread-overlay-proxy-interrupt-request":
          await this._handleThreadOverlayInterrupt(ws, message);
          return;
        case "electron-onboarding-skip-workspace":
          this.workspaceRootOptions = {
            ...this.workspaceRootOptions,
            roots: [this.defaultWorkspaceRoot]
          };
          this.activeWorkspaceRoots = [this.defaultWorkspaceRoot];
          this.userSelectedActiveWorkspaceRoots = false;
          this._persistWorkspaceState();
          this.broadcastMainMessage({
            type: "workspace-root-options-updated",
            options: this.workspaceRootOptions.roots
          });
          this.broadcastMainMessage({
            type: "active-workspace-roots-updated",
            roots: this.activeWorkspaceRoots
          });
          this.sendMainMessage(ws, {
            type: "electron-onboarding-skip-workspace-result",
            success: true,
            error: null
          });
          return;
        case "electron-update-workspace-root-options":
          if (Array.isArray(message.roots)) {
            const normalizedRoots = [...new Set(
              message.roots
                .map((root) => this._normalizeWorkspaceRoot(root))
                .filter(Boolean)
            )];
            this.workspaceRootOptions = {
              ...this.workspaceRootOptions,
              roots: normalizedRoots
            };
            this._persistWorkspaceState();
            this.broadcastMainMessage({
              type: "workspace-root-options-updated",
              options: this.workspaceRootOptions.roots
            });
          }
          return;
        case "electron-set-active-workspace-root":
          {
            const normalizedRoot = this._normalizeWorkspaceRoot(message.root);
            if (!normalizedRoot) {
              return;
            }
            this.activeWorkspaceRoots = [normalizedRoot];
            this.userSelectedActiveWorkspaceRoots = true;
            this._persistWorkspaceState();
            this.broadcastMainMessage({
              type: "active-workspace-roots-updated",
              roots: this.activeWorkspaceRoots
            });
          }
          return;
        case "worker-request":
        case "worker-request-cancel":
          await this._handleWorkerMessage(ws, message.workerId || "git", message);
          return;
        case "open-in-browser":
          this._openInBrowser(ws, message);
          return;
        case "show-diff":
          this.sendMainMessage(ws, {
            type: "toggle-diff-panel",
            open: true
          });
          return;
        case "show-plan-summary":
        case "navigate-in-new-editor-tab":
          // Matches desktop host behavior: these are no-ops.
          return;
        case "electron-set-badge-count":
        case "power-save-blocker-set":
        case "hotkey-window-enabled-changed":
        case "heartbeat-automations-enabled-changed":
        case "codex-runtimes-config-changed":
        case "mac-menu-bar-enabled-changed":
        case "electron-desktop-features-changed":
        case "desktop-notification-show":
        case "desktop-notification-hide":
        case "show-context-menu":
        case "inbox-item-set-read-state":
        case "codex-app-server-restart":
        case "open-thread-overlay":
        case "electron-set-window-mode":
        case "electron-pick-workspace-root-option":
        case "electron-app-state-snapshot-trigger":
        case "update-diff-if-open":
          // Electron-only side effects that are safe to ignore in browser mode.
          return;
      default:
          if (NATIVE_UNSUPPORTED.has(type)) {
            this.logger.warn("Unsupported native action in browser mode", {
              type
            });
            this.sendBridgeError(ws, "unsupported_native_action", `${type} is not available in browser mode.`);
            return;
          }

          this.logger.warn("Unsupported renderer message type", {
            type,
            keys: Object.keys(message)
          });
          this.sendBridgeError(ws, "unsupported_message_type", `Unsupported renderer message type: ${type}`);
      }
    } catch (error) {
      this.logger.warn("Message handling error", {
        type,
        error: toErrorMessage(error)
      });
      this.sendBridgeError(ws, "message_handler_error", toErrorMessage(error));
    }
  }

  _handleReady(ws) {
    this.sendMainMessage(ws, {
      type: "shared-object-updated",
      key: "host_config",
      value: this.sharedObjects.get("host_config")
    });

    this.sendMainMessage(ws, {
      type: "active-workspace-roots-updated",
      roots: this.activeWorkspaceRoots
    });

    this.sendMainMessage(ws, {
      type: "workspace-root-options-updated",
      options: this.workspaceRootOptions.roots
    });

    this.sendMainMessage(ws, {
      type: "persisted-atom-sync",
      state: Object.fromEntries(this.persistedAtomState.entries())
    });

    this.sendMainMessage(ws, {
      type: "custom-prompts-updated",
      prompts: []
    });

    this.sendMainMessage(ws, {
      type: "app-update-ready-changed",
      isUpdateReady: false
    });
  }

  async _handleFetch(ws, message) {
    const requestId = message.requestId || randomId(8);
    this.logger.debug("renderer-fetch", {
      requestId,
      method: message.method || "GET",
      url: this._sanitizeUrlForLogs(message.url),
      hasBody: message.body != null
    });

    if (await this._handleVirtualFetch(ws, requestId, message)) {
      return;
    }

    if (typeof message.url === "string" && message.url === "/transcribe") {
      const controller = new AbortController();
      this.fetchControllers.set(requestId, controller);
      try {
        await this._handleTranscribeFetch(ws, requestId, message, controller.signal);
      } finally {
        this.fetchControllers.delete(requestId);
      }
      return;
    }

    const resolvedUrl = this._resolveFetchUrl(message.url);
    if (!resolvedUrl) {
      this.sendMainMessage(ws, {
        type: "fetch-response",
        requestId,
        responseType: "error",
        status: 0,
        error: `Unsupported fetch URL: ${String(message.url)}`
      });
      this.logger.warn("renderer-fetch-failed", {
        requestId,
        url: this._sanitizeUrlForLogs(message.url),
        error: "unsupported_fetch_url"
      });
      return;
    }

    const controller = new AbortController();
    this.fetchControllers.set(requestId, controller);

    try {
      const outbound = this._prepareOutgoingFetchRequest(message);
      const response = await fetch(resolvedUrl, {
        method: outbound.method,
        headers: outbound.headers,
        body: outbound.body,
        signal: controller.signal
      });

      const body = await response.text();
      const headers = {};
      for (const [key, value] of response.headers.entries()) {
        headers[key] = value;
      }

      let bodyJsonString = body;
      try {
        JSON.parse(bodyJsonString);
      } catch {
        bodyJsonString = JSON.stringify(body);
      }

      this.sendMainMessage(ws, {
        type: "fetch-response",
        requestId,
        responseType: "success",
        status: response.status,
        headers,
        bodyJsonString
      });
      this.logger.debug("renderer-fetch-response", {
        requestId,
        status: response.status,
        ok: response.ok,
        url: this._sanitizeUrlForLogs(response.url || resolvedUrl)
      });
    } catch (error) {
      this.sendMainMessage(ws, {
        type: "fetch-response",
        requestId,
        responseType: "error",
        status: 0,
        error: toErrorMessage(error)
      });
      this.logger.warn("renderer-fetch-failed", {
        requestId,
        url: this._sanitizeUrlForLogs(resolvedUrl),
        error: toErrorMessage(error)
      });
    } finally {
      this.fetchControllers.delete(requestId);
    }
  }

  async _handleTranscribeFetch(ws, requestId, message, signal) {
    try {
      const outbound = this._prepareOutgoingFetchRequest(message);
      const bodyBuffer = this._asBuffer(outbound.body);
      const contentType = this._readHeader(outbound.headers, "content-type");
      const boundary = this._extractMultipartBoundary(contentType);
      if (!boundary) {
        throw new Error("Missing multipart boundary for /transcribe request.");
      }

      const { fields, files } = this._parseMultipartBody(bodyBuffer, boundary);
      const file = files.find((part) => part.name === "file") || files[0];
      if (!file || !file.data || file.data.length === 0) {
        throw new Error("Missing audio file in /transcribe request.");
      }

      const authToken = await this._resolveTranscriptionAuthToken();
      if (!authToken) {
        throw new Error("Dictation requires ChatGPT authentication in Codex.");
      }

      const model = process.env.CODEX_WEBSTRAP_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
      const form = new FormData();
      form.append("model", model);
      if (typeof fields.language === "string" && fields.language.trim().length > 0) {
        form.append("language", fields.language.trim());
      }
      form.append(
        "file",
        new Blob([file.data], { type: file.contentType || "audio/webm" }),
        file.filename || "codex.webm"
      );

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`
        },
        body: form,
        signal
      });
      const responseText = await response.text();

      let bodyJsonString = responseText;
      if (response.ok) {
        const parsed = safeJsonParse(responseText);
        if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
          bodyJsonString = JSON.stringify({ text: parsed.text });
        } else {
          bodyJsonString = JSON.stringify({ text: "" });
        }
      }

      this.sendMainMessage(ws, {
        type: "fetch-response",
        requestId,
        responseType: "success",
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") || "application/json"
        },
        bodyJsonString
      });
    } catch (error) {
      this.sendMainMessage(ws, {
        type: "fetch-response",
        requestId,
        responseType: "error",
        status: 0,
        error: toErrorMessage(error)
      });
      this.logger.warn("transcribe-fetch-failed", {
        requestId,
        error: toErrorMessage(error)
      });
    }
  }

  _prepareOutgoingFetchRequest(message) {
    const method = message?.method || "GET";
    const headers = message?.headers && typeof message.headers === "object"
      ? { ...message.headers }
      : {};
    let body = message?.body;

    const base64Marker = this._readHeader(headers, "x-codex-base64");
    if (base64Marker === "1") {
      this._deleteHeader(headers, "x-codex-base64");
      if (typeof body !== "string") {
        throw new Error("X-Codex-Base64 fetch body must be a base64 string.");
      }
      body = Buffer.from(body, "base64");
    }

    return {
      method,
      headers,
      body
    };
  }

  _asBuffer(body) {
    if (Buffer.isBuffer(body)) {
      return body;
    }
    if (body instanceof Uint8Array) {
      return Buffer.from(body);
    }
    if (typeof body === "string") {
      return Buffer.from(body, "utf8");
    }
    if (body == null) {
      return Buffer.alloc(0);
    }
    return Buffer.from(String(body), "utf8");
  }

  _extractMultipartBoundary(contentType) {
    if (typeof contentType !== "string") {
      return null;
    }
    const match = contentType.match(/boundary=([^;]+)/i);
    if (!match || !match[1]) {
      return null;
    }
    return match[1].trim().replace(/^"|"$/g, "");
  }

  _parseMultipartBody(body, boundary) {
    const files = [];
    const fields = {};
    const delimiter = Buffer.from(`--${boundary}`);
    const partSeparator = Buffer.from("\r\n\r\n");

    let cursor = 0;
    for (;;) {
      const start = body.indexOf(delimiter, cursor);
      if (start < 0) {
        break;
      }

      cursor = start + delimiter.length;
      if (body[cursor] === 45 && body[cursor + 1] === 45) {
        break;
      }
      if (body[cursor] === 13 && body[cursor + 1] === 10) {
        cursor += 2;
      }

      const headerEnd = body.indexOf(partSeparator, cursor);
      if (headerEnd < 0) {
        break;
      }

      const headersText = body.slice(cursor, headerEnd).toString("utf8");
      const contentStart = headerEnd + partSeparator.length;
      const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
      const contentEnd = nextBoundary >= 0 ? nextBoundary : body.length;
      const content = body.slice(contentStart, contentEnd);

      const headers = {};
      for (const line of headersText.split("\r\n")) {
        const splitAt = line.indexOf(":");
        if (splitAt <= 0) {
          continue;
        }
        const key = line.slice(0, splitAt).trim().toLowerCase();
        const value = line.slice(splitAt + 1).trim();
        headers[key] = value;
      }

      const disposition = headers["content-disposition"] || "";
      const nameMatch = disposition.match(/\bname="([^"]+)"/i);
      const filenameMatch = disposition.match(/\bfilename="([^"]+)"/i);
      const name = nameMatch ? nameMatch[1] : null;
      const filename = filenameMatch ? filenameMatch[1] : null;
      const part = {
        name,
        filename,
        contentType: headers["content-type"] || null,
        data: content
      };

      if (filename) {
        files.push(part);
      } else if (name) {
        fields[name] = content.toString("utf8");
      }

      cursor = contentEnd + 2;
    }

    return { fields, files };
  }

  async _resolveTranscriptionAuthToken() {
    if (!this.appServer) {
      return null;
    }
    try {
      const response = await this.appServer.sendRequest("getAuthStatus", {
        includeToken: true,
        refreshToken: true
      }, {
        timeoutMs: 10_000
      });
      const token = response?.result?.authToken;
      return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
    } catch (error) {
      this.logger.warn("Failed to resolve transcription auth token", {
        error: toErrorMessage(error)
      });
      return null;
    }
  }

  _readHeader(headers, name) {
    if (!headers || typeof headers !== "object") {
      return null;
    }

    const target = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() !== target) {
        continue;
      }
      if (Array.isArray(value)) {
        return value.length > 0 ? String(value[0]) : "";
      }
      return value == null ? null : String(value);
    }
    return null;
  }

  _deleteHeader(headers, name) {
    if (!headers || typeof headers !== "object") {
      return;
    }

    const target = String(name).toLowerCase();
    for (const key of Object.keys(headers)) {
      if (String(key).toLowerCase() === target) {
        delete headers[key];
      }
    }
  }

  _sanitizeUrlForLogs(url) {
    if (typeof url !== "string" || url.length === 0) {
      return null;
    }

    // Drop query params and fragments from logs to avoid leaking tokens/user data.
    const withoutQuery = url.split("?")[0]?.split("#")[0] ?? "";
    if (withoutQuery.startsWith("http://") || withoutQuery.startsWith("https://")) {
      try {
        const parsed = new URL(withoutQuery);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return withoutQuery;
      }
    }
    return withoutQuery;
  }

  _resolveFetchUrl(url) {
    if (typeof url !== "string" || url.length === 0) {
      return null;
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    if (url.startsWith("/")) {
      return `https://chatgpt.com${url}`;
    }
    return null;
  }

  async _handleVirtualFetch(ws, requestId, message) {
    if (typeof message.url !== "string") {
      return false;
    }

    if (message.url.startsWith("sentry-ipc://")) {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 204,
        payload: ""
      });
      this.logger.debug("renderer-fetch-response", {
        requestId,
        status: 204,
        ok: true,
        sentryIpc: true
      });
      return true;
    }

    if (message.url.startsWith("vscode://codex/")) {
      const body = safeJsonParse(typeof message.body === "string" ? message.body : "{}") || {};
      const params = body?.params ?? body ?? {};

      let endpoint = "";
      try {
        endpoint = new URL(message.url).pathname.replace(/^\/+/, "");
      } catch {
        endpoint = "";
      }

      let payload = {};
      let status = 200;
      switch (endpoint) {
        case "get-global-state": {
          const key = params?.key;
          if (key === "active-workspace-roots") {
            payload = {
              value: this.activeWorkspaceRoots
            };
            break;
          }
          if (key === "electron-saved-workspace-roots") {
            payload = {
              value: this.workspaceRootOptions
            };
            break;
          }
          if (key === "electron-workspace-root-labels") {
            payload = {
              value: this.workspaceRootOptions.labels
            };
            break;
          }
          const hasGlobalStateValue = typeof key === "string"
            && Object.prototype.hasOwnProperty.call(this.globalState, key);
          payload = {
            value: key
              ? hasGlobalStateValue
                ? this.globalState[key]
                : this.persistedAtomState.get(key) ?? null
              : null
          };
          break;
        }
        case "set-global-state": {
          const key = params?.key;
          const value = params?.value;
          if (typeof key === "string" && key.length > 0) {
            const isActiveWorkspaceRoots = key === "active-workspace-roots";
            const isSavedWorkspaceRoots = key === "electron-saved-workspace-roots";
            const isWorkspaceLabels = key === "electron-workspace-root-labels";

            if (value == null) {
              this.persistedAtomState.delete(key);
              delete this.globalState[key];
            } else {
              this.persistedAtomState.set(key, value);
              this.globalState[key] = value;
            }

            if (isActiveWorkspaceRoots && Array.isArray(value)) {
              this.activeWorkspaceRoots = [...new Set(
                value
                  .map((root) => this._normalizeWorkspaceRoot(root))
                  .filter(Boolean)
              )];
              this.userSelectedActiveWorkspaceRoots = true;
            } else if (isSavedWorkspaceRoots && value && typeof value === "object") {
              const roots = Array.isArray(value.roots)
                ? [...new Set(
                  value.roots
                    .map((root) => this._normalizeWorkspaceRoot(root))
                    .filter(Boolean)
                )]
                : [];
              const labels = value.labels && typeof value.labels === "object" ? value.labels : {};
              if (roots.length > 0) {
                this.workspaceRootOptions = { roots, labels };
              }
            } else if (isWorkspaceLabels && value && typeof value === "object") {
              this.workspaceRootOptions = {
                ...this.workspaceRootOptions,
                labels: value
              };
            }

            if (isActiveWorkspaceRoots || isSavedWorkspaceRoots || isWorkspaceLabels) {
              this._persistWorkspaceState();
            } else {
              this._scheduleGlobalStateWrite();
            }
          }
          payload = { ok: true };
          break;
        }
        case "list-pinned-threads":
          payload = { threadIds: [] };
          break;
        case "set-thread-pinned":
          payload = { ok: true };
          break;
        case "local-custom-agents":
          payload = { agents: [] };
          break;
        case "extension-info":
          payload = this.extensionInfo;
          break;
        case "is-copilot-api-available":
          payload = { isAvailable: false };
          break;
        case "account-info":
          payload = {
            userId: this.lastAccountRead?.userId ?? null,
            accountId: this.lastAccountRead?.accountId ?? null,
            email: this.lastAccountRead?.account?.email ?? null,
            plan: this.lastAccountRead?.account?.planType ?? null,
            account: this.lastAccountRead?.account ?? null,
            requiresOpenaiAuth: this.lastAccountRead?.requiresOpenaiAuth ?? true
          };
          break;
        case "os-info":
          payload = { platform: process.platform };
          break;
        case "ide-context":
          payload = {
            ideContext: {
              workspaceRoot: params?.workspaceRoot ?? null,
              roots: typeof params?.workspaceRoot === "string" && params.workspaceRoot.length > 0
                ? [params.workspaceRoot]
                : [],
              openFiles: [],
              activeEditor: null
            },
            roots: []
          };
          break;
        case "get-copilot-api-proxy-info":
          payload = null;
          break;
        case "mcp-codex-config":
          payload = { config: {} };
          break;
        case "developer-instructions":
          payload = {
            instructions: typeof params?.baseInstructions === "string" ? params.baseInstructions : null
          };
          break;
        case "local-environments":
          payload = await this._resolveLocalEnvironments(params);
          break;
        case "has-custom-cli-executable":
          payload = { hasCustomCliExecutable: false };
          break;
        case "generate-thread-title": {
          const prompt = typeof params?.prompt === "string" ? params.prompt.trim() : "";
          payload = {
            title: prompt.length > 0
              ? prompt
                .replace(/\s+/g, " ")
                .split(" ")
                .slice(0, 8)
                .join(" ")
                .slice(0, 80)
              : "Update thread"
          };
          break;
        }
        case "read-file": {
          const result = await this._readFilePayload(params);
          payload = result.payload;
          status = result.ok ? 200 : 404;
          break;
        }
        case "read-file-binary":
          payload = await this._readFileBinaryPayload(params);
          break;
        case "active-workspace-roots":
          payload = { roots: this.activeWorkspaceRoots };
          break;
        case "workspace-root-options":
          payload = this.workspaceRootOptions;
          break;
        case "workspace-directory-entries":
          payload = await this._readWorkspaceDirectoryEntriesPayload(params);
          break;
        case "git-origins": {
          const dirs = Array.isArray(params?.dirs) ? params.dirs.filter((dir) => typeof dir === "string" && dir.length > 0) : [];
          payload = {
            origins: await Promise.all(dirs.map((dir) => this._resolveGitOrigin(dir)))
          };
          break;
        }
        case "git-create-branch": {
          payload = await this._handleGitCreateBranch(params);
          status = payload.ok ? 200 : 500;
          break;
        }
        case "git-checkout-branch": {
          payload = await this._handleGitCheckoutBranch(params);
          status = payload.ok ? 200 : 500;
          break;
        }
        case "git-push": {
          payload = await this._handleGitPush(params);
          status = payload.ok ? 200 : 500;
          break;
        }
        case "git-merge-base": {
          const gitRoot = typeof params?.gitRoot === "string" && params.gitRoot.length > 0
            ? params.gitRoot
            : process.cwd();
          const baseBranch = typeof params?.baseBranch === "string" ? params.baseBranch.trim() : "";
          payload = await this._resolveGitMergeBase({ gitRoot, baseBranch });
          break;
        }
        case "list-pending-automation-run-threads":
          payload = { threadIds: [] };
          break;
        case "inbox-items":
          payload = { items: [] };
          break;
        case "pending-automation-runs":
          payload = { runs: [] };
          break;
        case "list-automations":
          payload = { items: [] };
          break;
        case "open-in-targets":
          payload = { preferredTarget: null, targets: [], availableTargets: [] };
          break;
        case "codex-home":
          payload = { codexHome: null };
          break;
        case "locale-info":
          payload = { ideLocale: null, systemLocale: null };
          break;
        case "hotkey-window-hotkey-state":
          payload = {
            state: {
              supported: false,
              configuredHotkey: null
            }
          };
          break;
        case "get-configuration":
          payload = { value: this._resolveConfigurationValue(params?.key) };
          break;
        case "set-configuration":
          payload = { ok: true };
          break;
        case "recommended-skills":
          payload = { skills: [] };
          break;
        case "ambient-suggestions":
          payload = {
            file: {
              generatedAtMs: null,
              currentSuggestionIds: [],
              suggestions: []
            }
          };
          break;
        case "ambient-suggestions-refresh":
          payload = { success: true };
          status = 202;
          break;
        case "ambient-suggestions-generation-statuses":
          payload = { statuses: [] };
          break;
        case "projectless-thread-cwd":
          payload = { cwd: this.activeWorkspaceRoots[0] ?? process.cwd() };
          break;
        case "projectless-thread-ids":
          payload = [];
          break;
        case "third-party-notices":
          payload = { notices: [] };
          break;
        case "gh-cli-status":
          payload = await this._resolveGhCliStatus();
          break;
        case "gh-pr-status": {
          const cwd = typeof params?.cwd === "string" && params.cwd.length > 0
            ? params.cwd
            : process.cwd();
          const headBranch = typeof params?.headBranch === "string" ? params.headBranch.trim() : "";
          payload = await this._resolveGhPrStatus({ cwd, headBranch });
          break;
        }
        case "generate-pull-request-message":
          payload = await this._handleGeneratePullRequestMessage(params);
          break;
        case "gh-pr-create":
          payload = await this._handleGhPrCreate(params);
          break;
        case "paths-exist": {
          const paths = Array.isArray(params?.paths) ? params.paths.filter((p) => typeof p === "string") : [];
          payload = { existingPaths: paths };
          break;
        }
        default:
          if (endpoint.startsWith("git-")) {
            this.logger.warn("Unhandled git vscode fetch endpoint", { endpoint });
            payload = {
              ok: false,
              error: `unhandled git endpoint: ${endpoint}`
            };
            status = 500;
          } else {
            this.logger.warn("Unhandled vscode fetch endpoint", { endpoint });
            payload = {};
          }
      }

      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status,
        payload
      });
      return true;
    }

    if (message.url === "/wham/accounts/check") {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: {
          account_ordering: [],
          accounts: []
        }
      });
      return true;
    }

    if (message.url === "/wham/usage") {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: {}
      });
      return true;
    }

    if (message.url.startsWith("/wham/tasks/list")) {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: { items: [] }
      });
      return true;
    }

    if (message.url === "/wham/environments") {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: []
      });
      return true;
    }

    if (message.url.startsWith("/wham/tasks/")) {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: {}
      });
      return true;
    }

    if (message.url.includes("/accounts/") && message.url.endsWith("/settings")) {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: {}
      });
      return true;
    }

    return false;
  }

  async _resolveGitOrigin(dir) {
    const normalizedDir = this._normalizeWorkspaceRoot(dir) || dir;
    const fallback = {
      dir: normalizedDir,
      root: normalizedDir,
      commonDir: normalizedDir,
      originUrl: null
    };

    const rootResult = await this._runCommand("git", ["-C", normalizedDir, "rev-parse", "--show-toplevel"], {
      timeoutMs: 5_000
    });
    if (!rootResult.ok || !rootResult.stdout) {
      return fallback;
    }

    const root = this._normalizeWorkspaceRoot(rootResult.stdout) || normalizedDir;

    const commonDirResult = await this._runCommand("git", ["-C", normalizedDir, "rev-parse", "--git-common-dir"], {
      timeoutMs: 5_000
    });
    const commonDir = commonDirResult.ok && commonDirResult.stdout
      ? path.resolve(normalizedDir, commonDirResult.stdout)
      : root;

    const originResult = await this._runCommand("git", ["-C", normalizedDir, "remote", "get-url", "origin"], {
      timeoutMs: 5_000,
      allowNonZero: true
    });

    return {
      dir: normalizedDir,
      root,
      commonDir,
      originUrl: originResult.ok && originResult.stdout ? originResult.stdout : null
    };
  }

  async _readFileBinaryPayload(params) {
    const filePath = typeof params?.path === "string" ? params.path.trim() : "";
    if (filePath.length === 0) {
      return {
        contentsBase64: "",
        mimeType: null,
        sizeBytes: 0
      };
    }

    try {
      const data = await fs.readFile(filePath);
      return {
        contentsBase64: data.toString("base64"),
        mimeType: null,
        sizeBytes: data.byteLength
      };
    } catch (error) {
      this.logger.warn("Failed to read binary file", {
        path: filePath,
        error: toErrorMessage(error)
      });
      return {
        contentsBase64: "",
        mimeType: null,
        sizeBytes: 0
      };
    }
  }

  async _readFilePayload(params) {
    const filePath = this._resolveWorkspaceFilePath(params);
    if (!filePath) {
      return {
        ok: false,
        payload: {
          contents: ""
        }
      };
    }

    try {
      const contents = await fs.readFile(filePath, "utf8");
      return {
        ok: true,
        payload: {
          contents
        }
      };
    } catch (error) {
      this.logger.warn("Failed to read text file", {
        path: filePath,
        error: toErrorMessage(error)
      });
      return {
        ok: false,
        payload: {
          contents: ""
        }
      };
    }
  }

  async _readWorkspaceDirectoryEntriesPayload(params) {
    const workspaceRoot = this._resolveLocalEnvironmentWorkspaceRoot(params?.workspaceRoot);
    if (!workspaceRoot) {
      return { entries: [] };
    }

    const includeHidden = params?.includeHidden === true;
    const rawDirectoryPath = typeof params?.directoryPath === "string"
      ? params.directoryPath.trim()
      : "";
    const normalizedDirectoryPath = rawDirectoryPath
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    const targetDirectory = normalizedDirectoryPath.length > 0
      ? safePathJoin(workspaceRoot, normalizedDirectoryPath)
      : workspaceRoot;

    if (!targetDirectory) {
      return { entries: [] };
    }

    let directoryEntries;
    try {
      const stat = await fs.stat(targetDirectory);
      if (!stat.isDirectory()) {
        return { entries: [] };
      }
      directoryEntries = await fs.readdir(targetDirectory, { withFileTypes: true });
    } catch (error) {
      this.logger.warn("Failed to read workspace directory entries", {
        workspaceRoot,
        directoryPath: normalizedDirectoryPath,
        error: toErrorMessage(error)
      });
      return { entries: [] };
    }

    const entries = directoryEntries
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .flatMap((entry) => {
        if (!entry.isDirectory() && !entry.isFile()) {
          return [];
        }

        return [{
          path: normalizedDirectoryPath.length > 0
            ? path.posix.join(normalizedDirectoryPath, entry.name)
            : entry.name,
          type: entry.isDirectory() ? "directory" : "file"
        }];
      })
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === "directory" ? -1 : 1;
        }
        return left.path.localeCompare(right.path, undefined, {
          numeric: true,
          sensitivity: "base"
        });
      });

    return { entries };
  }

  _resolveWorkspaceFilePath(params) {
    const rawPath = typeof params?.path === "string" ? params.path.trim() : "";
    if (rawPath.length === 0) {
      return null;
    }

    if (path.isAbsolute(rawPath)) {
      return path.resolve(rawPath);
    }

    const workspaceRoot = this._resolveLocalEnvironmentWorkspaceRoot(params?.workspaceRoot);
    if (!workspaceRoot) {
      return null;
    }

    return safePathJoin(workspaceRoot, rawPath);
  }

  async _resolveGhCliStatus() {
    const ghVersion = await this._runCommand("gh", ["--version"], {
      timeoutMs: 3_000,
      allowNonZero: true
    });

    if (!ghVersion.ok) {
      return {
        isInstalled: false,
        isAuthenticated: false
      };
    }

    const auth = await this._runCommand("gh", ["auth", "status", "--hostname", "github.com"], {
      timeoutMs: 4_000,
      allowNonZero: true
    });

    return {
      isInstalled: true,
      isAuthenticated: auth.ok
    };
  }

  async _resolveGhPrStatus({ cwd, headBranch }) {
    if (!headBranch) {
      return {
        status: "success",
        hasOpenPr: false,
        url: null,
        number: null
      };
    }

    const ghStatus = await this._resolveGhCliStatus();
    if (!ghStatus.isInstalled || !ghStatus.isAuthenticated) {
      return {
        status: "error",
        hasOpenPr: false,
        url: null,
        number: null,
        error: "gh cli unavailable or unauthenticated"
      };
    }

    const listResult = await this._runCommand(
      "gh",
      ["pr", "list", "--state", "open", "--head", headBranch, "--json", "number,url", "--limit", "1"],
      {
        timeoutMs: 8_000,
        allowNonZero: true,
        cwd
      }
    );

    if (!listResult.ok) {
      return {
        status: "error",
        hasOpenPr: false,
        url: null,
        number: null,
        error: listResult.error || "failed to query open pull requests"
      };
    }

    const parsed = safeJsonParse(listResult.stdout);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return {
        status: "success",
        hasOpenPr: false,
        url: null,
        number: null
      };
    }

    const first = parsed[0] && typeof parsed[0] === "object" ? parsed[0] : {};
    const number = Number.isInteger(first.number) ? first.number : null;
    const url = typeof first.url === "string" && first.url.length > 0 ? first.url : null;

    return {
      status: "success",
      hasOpenPr: true,
      url,
      number
    };
  }

  async _handleGeneratePullRequestMessage(params) {
    const cwd = typeof params?.cwd === "string" && params.cwd.length > 0
      ? params.cwd
      : process.cwd();
    const prompt = typeof params?.prompt === "string" ? params.prompt : "";
    const generated = await this._generatePullRequestMessageWithCodex({ cwd, prompt });
    const fallback = generated || await this._generateFallbackPullRequestMessage({ cwd, prompt });
    const title = this._normalizePullRequestTitle(fallback.title);
    const body = this._normalizePullRequestBody(fallback.body);

    return {
      status: "success",
      title,
      body,
      // Older clients read `bodyInstructions`; keep it in sync with the generated body.
      bodyInstructions: body
    };
  }

  _normalizePullRequestTitle(title) {
    if (typeof title !== "string") {
      return "Update project files";
    }

    const normalized = title.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) {
      return "Update project files";
    }
    if (normalized.length <= 120) {
      return normalized;
    }
    return `${normalized.slice(0, 117).trimEnd()}...`;
  }

  _normalizePullRequestBody(body) {
    if (typeof body !== "string") {
      return "## Summary\n- Update project files.\n\n## Testing\n- Not run (context not provided).";
    }

    const normalized = body.trim();
    if (normalized.length > 0) {
      return normalized;
    }
    return "## Summary\n- Update project files.\n\n## Testing\n- Not run (context not provided).";
  }

  _buildPullRequestCodexPrompt(prompt) {
    const context = typeof prompt === "string" && prompt.trim().length > 0
      ? prompt.trim().slice(0, 20_000)
      : "No additional context was provided.";

    return [
      "Generate a GitHub pull request title and body.",
      "Return JSON that matches the provided schema.",
      "Requirements:",
      "- title: concise imperative sentence, maximum 72 characters.",
      "- body: markdown with sections exactly '## Summary' and '## Testing'.",
      "- Summary should include 2 to 6 concrete bullet points.",
      "- Testing should include bullet points. If unknown, say '- Not run (context not provided).'.",
      "- Do not wrap output in code fences.",
      "- Use only the provided context.",
      "",
      "Context:",
      context
    ].join("\n");
  }

  async _generatePullRequestMessageWithCodex({ cwd, prompt }) {
    let tempDir = null;
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-webstrap-prmsg-"));
      const schemaPath = path.join(tempDir, "schema.json");
      const outputPath = path.join(tempDir, "output.json");
      const schema = {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        required: ["title", "body"],
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          body: { type: "string" }
        }
      };
      await fs.writeFile(schemaPath, JSON.stringify(schema), "utf8");

      const result = await this._runCommand(
        "codex",
        [
          "exec",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          this._buildPullRequestCodexPrompt(prompt)
        ],
        {
          timeoutMs: 120_000,
          allowNonZero: true,
          cwd
        }
      );

      if (!result.ok) {
        this.logger.warn("PR message generation via codex failed", {
          cwd,
          error: result.error || result.stderr || "unknown error"
        });
        return null;
      }

      const rawOutput = await fs.readFile(outputPath, "utf8");
      const parsed = safeJsonParse(rawOutput);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const title = this._normalizePullRequestTitle(parsed.title);
      const body = this._normalizePullRequestBody(parsed.body);
      return { title, body };
    } catch (error) {
      this.logger.warn("PR message generation via codex errored", {
        cwd,
        error: toErrorMessage(error)
      });
      return null;
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async _resolvePullRequestBaseRef(cwd) {
    const originHead = await this._runCommand(
      "git",
      ["-C", cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { timeoutMs: 5_000, allowNonZero: true, cwd }
    );
    if (originHead.ok && originHead.stdout) {
      return originHead.stdout;
    }

    const candidates = ["origin/main", "origin/master", "main", "master"];
    for (const candidate of candidates) {
      const exists = await this._runCommand(
        "git",
        ["-C", cwd, "rev-parse", "--verify", "--quiet", candidate],
        { timeoutMs: 5_000, allowNonZero: true, cwd }
      );
      if (exists.code === 0) {
        return candidate;
      }
    }

    return null;
  }

  async _generateFallbackPullRequestMessage({ cwd, prompt }) {
    const baseRef = await this._resolvePullRequestBaseRef(cwd);
    const logArgs = baseRef
      ? ["-C", cwd, "log", "--no-merges", "--pretty=format:%s", `${baseRef}..HEAD`, "-n", "6"]
      : ["-C", cwd, "log", "--no-merges", "--pretty=format:%s", "-n", "6"];
    const logResult = await this._runCommand("git", logArgs, {
      timeoutMs: 8_000,
      allowNonZero: true,
      cwd
    });
    const commitSubjects = (logResult.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const range = baseRef ? `${baseRef}...HEAD` : "HEAD~1..HEAD";
    const filesResult = await this._runCommand(
      "git",
      ["-C", cwd, "diff", "--name-only", "--diff-filter=ACMR", range],
      { timeoutMs: 8_000, allowNonZero: true, cwd }
    );
    const changedFiles = (filesResult.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const statsResult = await this._runCommand(
      "git",
      ["-C", cwd, "diff", "--numstat", range],
      { timeoutMs: 8_000, allowNonZero: true, cwd }
    );
    let additions = 0;
    let deletions = 0;
    for (const line of (statsResult.stdout || "").split("\n")) {
      const [addedRaw, deletedRaw] = line.split("\t");
      const added = Number.parseInt(addedRaw, 10);
      const deleted = Number.parseInt(deletedRaw, 10);
      additions += Number.isFinite(added) ? added : 0;
      deletions += Number.isFinite(deleted) ? deleted : 0;
    }

    const branch = await this._resolveGitCurrentBranch(cwd);
    const title = this._normalizePullRequestTitle(
      commitSubjects[0] || (branch ? `Update ${branch}` : "Update project files")
    );

    const summaryBullets = [];
    for (const subject of commitSubjects.slice(0, 3)) {
      summaryBullets.push(subject);
    }
    if (summaryBullets.length === 0) {
      summaryBullets.push("Update project files.");
    }
    if (changedFiles.length > 0) {
      summaryBullets.push(`Modify ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}.`);
    }
    if (additions > 0 || deletions > 0) {
      summaryBullets.push(`Diff summary: +${additions} / -${deletions} lines.`);
    }
    if (baseRef) {
      summaryBullets.push(`Base branch: ${baseRef}.`);
    }

    const bodyLines = ["## Summary"];
    for (const bullet of summaryBullets.slice(0, 6)) {
      bodyLines.push(`- ${bullet}`);
    }

    bodyLines.push("", "## Testing", "- Not run (context not provided).");

    if (changedFiles.length > 0) {
      bodyLines.push("", "## Files Changed");
      for (const file of changedFiles.slice(0, 12)) {
        bodyLines.push(`- \`${file}\``);
      }
      if (changedFiles.length > 12) {
        bodyLines.push(`- \`...and ${changedFiles.length - 12} more\``);
      }
    } else if (typeof prompt === "string" && prompt.trim().length > 0) {
      bodyLines.push("", "## Notes", "- Generated from available thread context.");
    }

    return {
      title,
      body: this._normalizePullRequestBody(bodyLines.join("\n"))
    };
  }

  _extractGithubPrUrl(text) {
    if (typeof text !== "string" || text.length === 0) {
      return null;
    }
    const match = text.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/);
    return match ? match[0] : null;
  }

  async _handleGhPrCreate(params) {
    const cwd = typeof params?.cwd === "string" && params.cwd.length > 0
      ? params.cwd
      : process.cwd();
    const headBranch = typeof params?.headBranch === "string" ? params.headBranch.trim() : "";
    const baseBranch = typeof params?.baseBranch === "string" ? params.baseBranch.trim() : "";
    const bodyInstructions = typeof params?.bodyInstructions === "string" ? params.bodyInstructions : "";
    const titleOverride = typeof params?.titleOverride === "string" ? params.titleOverride.trim() : "";
    const bodyOverride = typeof params?.bodyOverride === "string" ? params.bodyOverride.trim() : "";

    if (!headBranch || !baseBranch) {
      return {
        status: "error",
        error: "headBranch and baseBranch are required",
        url: null,
        number: null
      };
    }

    const ghStatus = await this._resolveGhCliStatus();
    if (!ghStatus.isInstalled || !ghStatus.isAuthenticated) {
      return {
        status: "error",
        error: "gh cli unavailable or unauthenticated",
        url: null,
        number: null
      };
    }

    const args = [
      "pr",
      "create",
      "--head",
      headBranch,
      "--base",
      baseBranch
    ];
    const shouldFill = titleOverride.length === 0 || bodyOverride.length === 0;
    if (shouldFill) {
      args.push("--fill");
    }
    if (titleOverride.length > 0) {
      args.push("--title", titleOverride);
    }
    if (bodyOverride.length > 0) {
      args.push("--body", bodyOverride);
    } else if (bodyInstructions.trim().length > 0) {
      args.push("--body", bodyInstructions);
    }

    const result = await this._runCommand("gh", args, {
      timeoutMs: 30_000,
      allowNonZero: true,
      cwd
    });

    if (result.ok) {
      const url = this._extractGithubPrUrl(result.stdout) || this._extractGithubPrUrl(result.stderr);
      const numberMatch = url ? url.match(/\/pull\/(\d+)/) : null;
      const number = numberMatch ? Number.parseInt(numberMatch[1], 10) : null;
      return {
        status: "success",
        url: url || null,
        number: Number.isFinite(number) ? number : null
      };
    }

    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    const existingUrl = this._extractGithubPrUrl(combinedOutput);
    const alreadyExists = /already exists|a pull request for branch/i.test(combinedOutput);
    if (alreadyExists && existingUrl) {
      const numberMatch = existingUrl.match(/\/pull\/(\d+)/);
      const number = numberMatch ? Number.parseInt(numberMatch[1], 10) : null;
      return {
        status: "success",
        url: existingUrl,
        number: Number.isFinite(number) ? number : null
      };
    }

    return {
      status: "error",
      error: result.error || result.stderr || "failed to create pull request",
      url: null,
      number: null
    };
  }

  async _resolveGitMergeBase({ gitRoot, baseBranch }) {
    if (!baseBranch) {
      return {
        mergeBaseSha: null
      };
    }

    const result = await this._runCommand(
      "git",
      ["-C", gitRoot, "merge-base", "HEAD", baseBranch],
      {
        timeoutMs: 5_000,
        allowNonZero: true
      }
    );

    return {
      mergeBaseSha: result.ok && result.stdout ? result.stdout : null
    };
  }

  async _resolveGitCurrentBranch(cwd) {
    const result = await this._runCommand("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeoutMs: 5_000,
      allowNonZero: true,
      cwd
    });
    if (!result.ok || !result.stdout || result.stdout === "HEAD") {
      return null;
    }
    return result.stdout;
  }

  async _handleGitCreateBranch(params) {
    const cwd = typeof params?.cwd === "string" && params.cwd.length > 0
      ? params.cwd
      : process.cwd();
    const branch = typeof params?.branch === "string" && params.branch.trim().length > 0
      ? params.branch.trim()
      : null;

    if (!branch) {
      return {
        ok: false,
        code: null,
        error: "branch is required",
        stdout: "",
        stderr: ""
      };
    }

    const existingResult = await this._runCommand("git", ["-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      timeoutMs: 10_000,
      allowNonZero: true
    });
    if (existingResult.code === 0) {
      return {
        ok: true,
        code: 0,
        branch,
        created: false,
        alreadyExists: true,
        stdout: existingResult.stdout || "",
        stderr: existingResult.stderr || ""
      };
    }

    const createResult = await this._runCommand("git", ["-C", cwd, "branch", branch], {
      cwd,
      timeoutMs: 10_000,
      allowNonZero: true
    });
    if (createResult.ok) {
      return {
        ok: true,
        code: createResult.code,
        branch,
        created: true,
        alreadyExists: false,
        stdout: createResult.stdout || "",
        stderr: createResult.stderr || ""
      };
    }

    return {
      ok: false,
      code: createResult.code,
      error: createResult.error || createResult.stderr || "git branch failed",
      stdout: createResult.stdout || "",
      stderr: createResult.stderr || ""
    };
  }

  async _handleGitCheckoutBranch(params) {
    const cwd = typeof params?.cwd === "string" && params.cwd.length > 0
      ? params.cwd
      : process.cwd();
    const branch = typeof params?.branch === "string" && params.branch.trim().length > 0
      ? params.branch.trim()
      : null;

    if (!branch) {
      return {
        ok: false,
        code: null,
        error: "branch is required",
        stdout: "",
        stderr: ""
      };
    }

    const checkoutResult = await this._runCommand("git", ["-C", cwd, "checkout", branch], {
      cwd,
      timeoutMs: 20_000,
      allowNonZero: true
    });
    if (!checkoutResult.ok) {
      return {
        ok: false,
        code: checkoutResult.code,
        error: checkoutResult.error || checkoutResult.stderr || "git checkout failed",
        stdout: checkoutResult.stdout || "",
        stderr: checkoutResult.stderr || ""
      };
    }

    const currentBranch = await this._resolveGitCurrentBranch(cwd);
    return {
      ok: true,
      code: checkoutResult.code,
      branch: currentBranch || branch,
      stdout: checkoutResult.stdout || "",
      stderr: checkoutResult.stderr || ""
    };
  }

  async _handleGitPush(params) {
    const cwd = typeof params?.cwd === "string" && params.cwd.length > 0
      ? params.cwd
      : process.cwd();
    const explicitRemote = typeof params?.remote === "string" && params.remote.trim().length > 0
      ? params.remote.trim()
      : null;
    const branch = typeof params?.branch === "string" && params.branch.trim().length > 0
      ? params.branch.trim()
      : null;
    const refspec = typeof params?.refspec === "string" && params.refspec.trim().length > 0
      ? params.refspec.trim()
      : null;
    const remote = explicitRemote || (
      params?.setUpstream === true && (branch || refspec) ? "origin" : null
    );

    const args = ["-C", cwd, "push"];
    if (params?.force === true || params?.forceWithLease === true) {
      args.push("--force-with-lease");
    }
    if (params?.setUpstream === true) {
      args.push("--set-upstream");
    }
    if (remote) {
      args.push(remote);
    }
    if (refspec) {
      args.push(refspec);
    } else if (branch) {
      args.push(branch);
    }

    const result = await this._runCommand("git", args, {
      cwd,
      timeoutMs: 120_000,
      allowNonZero: true
    });

    if (result.ok) {
      return {
        ok: true,
        code: result.code,
        stdout: result.stdout || "",
        stderr: result.stderr || ""
      };
    }

    return {
      ok: false,
      code: result.code,
      error: result.error || result.stderr || "git push failed",
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    };
  }

  async _runCommand(command, args, { timeoutMs = 5_000, allowNonZero = false, cwd = process.cwd() } = {}) {
    return new Promise((resolve) => {
      const child = childSpawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        finish({
          ok: false,
          code: null,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: toErrorMessage(error)
        });
      });

      child.on("exit", (code) => {
        const success = code === 0;
        finish({
          ok: success,
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: success || allowNonZero ? null : stderr.trim() || `exit code ${String(code)}`
        });
      });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finish({
          ok: false,
          code: null,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: `command timed out after ${timeoutMs}ms`
        });
      }, timeoutMs);
    });
  }

  _sendFetchJson(ws, { requestId, url, status = 200, payload = {} }) {
    const bodyJsonString = JSON.stringify(payload);
    this.sendMainMessage(ws, {
      type: "fetch-response",
      requestId,
      responseType: "success",
      status,
      headers: { "content-type": "application/json" },
      bodyJsonString
    });
    this.logger.debug("renderer-fetch-response", {
      requestId,
      status,
      ok: status >= 200 && status < 300,
      url: this._sanitizeUrlForLogs(url)
    });
  }

  _handleCancelFetch(message) {
    const controller = this.fetchControllers.get(message.requestId);
    if (!controller) {
      return;
    }
    controller.abort();
    this.fetchControllers.delete(message.requestId);
  }

  async _forwardToAppServer(ws, payload) {
    if (this._handleVirtualMcpRequest(ws, payload)) {
      return;
    }

    if (!this.appServer) {
      this.sendBridgeError(ws, "app_server_unavailable", "App-server backend is unavailable.");
      return;
    }

    this.logger.debug("mcp-forward-request", {
      id: payload?.id ?? null,
      method: payload?.method ?? null
    });
    let response;
    try {
      response = await this.appServer.sendRaw(payload);
    } catch (error) {
      if (payload?.id != null) {
        this.logger.warn("mcp-forward-response-error", {
          id: payload.id,
          method: payload?.method ?? null,
          error: toErrorMessage(error)
        });
        this.sendMainMessage(ws, {
          type: "mcp-response",
          message: {
            id: payload.id,
            result: null,
            error: {
              message: toErrorMessage(error),
              code: typeof error?.code === "number" ? error.code : -32000
            }
          }
        });
        return;
      }
      throw error;
    }

    if (payload?.method === "account/read" && response?.result) {
      this.lastAccountRead = response.result;
    }

    if (payload?.method === "thread/list" && response?.result) {
      response.result = this._filterThreadListResult(response.result);
    }

    if (response && payload && payload.id != null) {
      this.logger.debug("mcp-forward-response", {
        id: response.id ?? payload.id,
        hasResult: response.result != null,
        hasError: response.error != null
      });
      this.sendMainMessage(ws, {
        type: "mcp-response",
        message: {
          id: response.id ?? payload.id,
          result: response.result,
          error: response.error
        }
      });
    }
  }

  _handleVirtualMcpRequest(ws, payload) {
    if (payload == null || typeof payload !== "object") {
      return false;
    }

    if (payload.method === "experimentalFeature/enablement/set") {
      this.sendMainMessage(ws, {
        type: "mcp-response",
        message: {
          id: payload.id,
          result: {
            enablement: {
              ...DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT,
              ...(payload.params?.enablement ?? {})
            }
          },
          error: null
        }
      });
      return true;
    }

    if (payload.method === "experimentalFeature/enablement/read") {
      this.sendMainMessage(ws, {
        type: "mcp-response",
        message: {
          id: payload.id,
          result: {
            enablement: DEFAULT_EXPERIMENTAL_FEATURE_ENABLEMENT
          },
          error: null
        }
      });
      return true;
    }

    return false;
  }

  _resolveConfigurationValue(key) {
    if (typeof key !== "string") {
      return null;
    }

    return DEFAULT_CONFIGURATION_VALUES[key] ?? null;
  }

  _normalizeWorkspaceRoot(root) {
    if (typeof root !== "string") {
      return null;
    }
    const trimmed = root.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.replace(/\/+$/, "");
  }

  async _resolveLocalEnvironments(params) {
    const workspaceRoot = this._resolveLocalEnvironmentWorkspaceRoot(params?.workspaceRoot);
    if (!workspaceRoot) {
      return { environments: [] };
    }

    const configDir = path.join(workspaceRoot, ".codex", "environments");
    let entries;
    try {
      entries = await fs.readdir(configDir, { withFileTypes: true });
    } catch {
      return { environments: [] };
    }

    const configFiles = entries
      .filter((entry) => entry.isFile() && /^environment(?:-\d+)?\.toml$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => {
        const leftIsDefault = left.toLowerCase() === "environment.toml";
        const rightIsDefault = right.toLowerCase() === "environment.toml";
        if (leftIsDefault && !rightIsDefault) {
          return -1;
        }
        if (!leftIsDefault && rightIsDefault) {
          return 1;
        }
        return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
      });

    if (configFiles.length === 0) {
      return { environments: [] };
    }

    const environments = await Promise.all(configFiles.map(async (fileName) => {
      const configPath = path.join(configDir, fileName);
      try {
        const raw = await fs.readFile(configPath, "utf8");
        const environment = this._parseLocalEnvironmentConfig(raw, configPath);
        return {
          type: "success",
          configPath,
          environment
        };
      } catch (error) {
        return {
          type: "error",
          configPath,
          error: {
            message: toErrorMessage(error)
          }
        };
      }
    }));

    return { environments };
  }

  _resolveLocalEnvironmentWorkspaceRoot(root) {
    const normalized = this._normalizeWorkspaceRoot(root);
    if (normalized) {
      return path.resolve(normalized);
    }

    const activeRoot = this._normalizeWorkspaceRoot(this.activeWorkspaceRoots?.[0]);
    if (activeRoot) {
      return path.resolve(activeRoot);
    }

    return this.defaultWorkspaceRoot ? path.resolve(this.defaultWorkspaceRoot) : null;
  }

  _parseLocalEnvironmentConfig(raw, configPath) {
    const name = this._parseTomlString(raw, "name") || path.basename(configPath, ".toml");
    const versionRaw = this._parseTomlNumber(raw, "version");
    const setupScript = this._parseTomlStringInSection(raw, "setup", "script") || "";

    return {
      version: Number.isInteger(versionRaw) ? versionRaw : 1,
      name,
      setup: {
        script: setupScript
      },
      actions: []
    };
  }

  _parseTomlString(raw, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*$`, "m");
    const match = raw.match(pattern);
    if (!match) {
      return null;
    }
    return match[1] ?? match[2] ?? null;
  }

  _parseTomlNumber(raw, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*(-?\\d+)\\s*$`, "m");
    const match = raw.match(pattern);
    if (!match) {
      return null;
    }
    const value = Number.parseInt(match[1], 10);
    return Number.isNaN(value) ? null : value;
  }

  _parseTomlStringInSection(raw, sectionName, key) {
    const escapedSection = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sectionPattern = new RegExp(`^\\s*\\[${escapedSection}\\]\\s*$`, "m");
    const sectionMatch = sectionPattern.exec(raw);
    if (!sectionMatch) {
      return null;
    }

    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const rest = raw.slice(sectionStart);
    const nextSectionMatch = rest.match(/^\s*\[[^\]]+\]\s*$/m);
    const sectionBody = nextSectionMatch ? rest.slice(0, nextSectionMatch.index) : rest;
    return this._parseTomlString(sectionBody, key);
  }

  _loadPersistedGlobalState() {
    if (!this.globalStatePath) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.globalStatePath, "utf8"));
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    this.globalState = parsed;

    const persistedAtoms = parsed["electron-persisted-atom-state"];
    if (persistedAtoms && typeof persistedAtoms === "object" && !Array.isArray(persistedAtoms)) {
      for (const [key, value] of Object.entries(persistedAtoms)) {
        this.persistedAtomState.set(key, value);
      }
    }

    const rawSavedRoots = parsed["electron-saved-workspace-roots"];
    const rawActiveRoots = parsed["active-workspace-roots"];
    const rawLabels = parsed["electron-workspace-root-labels"];

    let savedRoots = [];
    if (Array.isArray(rawSavedRoots)) {
      savedRoots = rawSavedRoots;
    } else if (rawSavedRoots && typeof rawSavedRoots === "object" && Array.isArray(rawSavedRoots.roots)) {
      savedRoots = rawSavedRoots.roots;
    }

    const normalizedSavedRoots = [...new Set(
      savedRoots
        .map((root) => this._normalizeWorkspaceRoot(root))
        .filter(Boolean)
    )];

    if (normalizedSavedRoots.length > 0) {
      const labels = rawLabels && typeof rawLabels === "object"
        ? rawLabels
        : rawSavedRoots && typeof rawSavedRoots === "object" && rawSavedRoots.labels && typeof rawSavedRoots.labels === "object"
          ? rawSavedRoots.labels
          : {};
      this.workspaceRootOptions = {
        roots: normalizedSavedRoots,
        labels
      };
    }

    if (Array.isArray(rawActiveRoots)) {
      const normalizedActiveRoots = [...new Set(
        rawActiveRoots
          .map((root) => this._normalizeWorkspaceRoot(root))
          .filter(Boolean)
      )];
      if (normalizedActiveRoots.length > 0) {
        this.activeWorkspaceRoots = normalizedActiveRoots;
        this.userSelectedActiveWorkspaceRoots = true;
      }
    }
  }

  _isCwdInRoot(cwd, root) {
    if (cwd === root) {
      return true;
    }
    return cwd.startsWith(`${root}/`);
  }

  _filterThreadListResult(result) {
    if (!result || !Array.isArray(result.data)) {
      return result;
    }

    const normalizedWorkspaceRoots = Array.isArray(this.workspaceRootOptions?.roots)
      ? this.workspaceRootOptions.roots
        .map((root) => this._normalizeWorkspaceRoot(root))
        .filter(Boolean)
      : [];

    // Desktop effectively scopes sidebar data to known/saved roots, not only the
    // currently active root. Using saved roots prevents global clutter while still
    // allowing threads to appear under every configured project folder.
    if (normalizedWorkspaceRoots.length === 0) {
      return result;
    }

    const filteredData = result.data.filter((item) => {
      const cwd = this._normalizeWorkspaceRoot(item?.cwd);
      if (!cwd) {
        return false;
      }

      return normalizedWorkspaceRoots.some((root) => this._isCwdInRoot(cwd, root));
    });

    if (filteredData.length === result.data.length) {
      return result;
    }

    return {
      ...result,
      data: filteredData
    };
  }

  _persistWorkspaceState({ writeToDisk = true } = {}) {
    const labels = this.workspaceRootOptions.labels || {};
    const roots = [...this.workspaceRootOptions.roots];
    const activeRoots = [...this.activeWorkspaceRoots];

    this.globalState["active-workspace-roots"] = activeRoots;
    this.globalState["electron-saved-workspace-roots"] = roots;
    this.globalState["electron-workspace-root-labels"] = labels;

    this.persistedAtomState.set("active-workspace-roots", this.activeWorkspaceRoots);
    this.persistedAtomState.set("electron-saved-workspace-roots", this.workspaceRootOptions);
    this.persistedAtomState.set("electron-workspace-root-labels", labels);

    if (writeToDisk) {
      this._scheduleGlobalStateWrite();
    }
  }

  _scheduleGlobalStateWrite() {
    if (!this.globalStatePath) {
      return;
    }

    if (this.globalStateWriteTimer) {
      clearTimeout(this.globalStateWriteTimer);
    }

    this.globalStateWriteTimer = setTimeout(() => {
      this.globalStateWriteTimer = null;
      void this._writeGlobalStateToDisk();
    }, 50);

    if (typeof this.globalStateWriteTimer?.unref === "function") {
      this.globalStateWriteTimer.unref();
    }
  }

  _buildGlobalStatePayload() {
    const persistedAtomState = {};
    for (const [key, value] of this.persistedAtomState.entries()) {
      if (
        key === "active-workspace-roots"
        || key === "electron-saved-workspace-roots"
        || key === "electron-workspace-root-labels"
      ) {
        continue;
      }
      persistedAtomState[key] = value;
    }

    return {
      ...this.globalState,
      "active-workspace-roots": this.activeWorkspaceRoots,
      "electron-saved-workspace-roots": this.workspaceRootOptions.roots,
      "electron-workspace-root-labels": this.workspaceRootOptions.labels || {},
      "electron-persisted-atom-state": persistedAtomState
    };
  }

  async _writeGlobalStateToDisk() {
    if (!this.globalStatePath) {
      return;
    }

    try {
      const payload = this._buildGlobalStatePayload();
      await fs.mkdir(path.dirname(this.globalStatePath), { recursive: true });
      await fs.writeFile(this.globalStatePath, JSON.stringify(payload));
    } catch (error) {
      this.logger.warn("Failed to persist global state", {
        path: this.globalStatePath,
        error: toErrorMessage(error)
      });
    }
  }

  _subscribeSharedObject(ws, key) {
    if (!key) {
      return;
    }

    let subscribers = this.sharedObjectSubscribers.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.sharedObjectSubscribers.set(key, subscribers);
    }
    subscribers.add(ws);

    this.sendMainMessage(ws, {
      type: "shared-object-updated",
      key,
      value: this.sharedObjects.get(key)
    });
  }

  _unsubscribeSharedObject(ws, key) {
    if (!key) {
      return;
    }

    const subscribers = this.sharedObjectSubscribers.get(key);
    if (!subscribers) {
      return;
    }

    subscribers.delete(ws);
    if (subscribers.size === 0) {
      this.sharedObjectSubscribers.delete(key);
    }
  }

  _setSharedObject(key, value) {
    if (!key) {
      return;
    }

    this.sharedObjects.set(key, value);
    const subscribers = this.sharedObjectSubscribers.get(key);
    if (!subscribers) {
      return;
    }

    for (const ws of subscribers) {
      this.sendMainMessage(ws, {
        type: "shared-object-updated",
        key,
        value
      });
    }
  }

  async _archiveThread(ws, message) {
    // Renderer handles the real archive operation via `thread/archive`.
    // This event is a pre-archive signal and must not invoke archive again.
    void ws;
    void message;
  }

  async _unarchiveThread(ws, message) {
    // Renderer handles the real unarchive operation via `thread/unarchive`.
    // This event is a pre-unarchive signal and must not invoke unarchive again.
    void ws;
    void message;
  }

  async _handleThreadOverlayStartTurn(ws, message) {
    const requestId = message.requestId;
    if (!this.appServer) {
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-start-turn-response",
        requestId,
        error: "app-server unavailable"
      });
      return;
    }

    try {
      const params = message.params || message.turnStartParams || {};
      const response = await this.appServer.sendRequest("turn/start", params);
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-start-turn-response",
        requestId,
        result: response?.result ?? null,
        error: null
      });
    } catch (error) {
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-start-turn-response",
        requestId,
        result: null,
        error: toErrorMessage(error)
      });
    }
  }

  async _handleThreadOverlayInterrupt(ws, message) {
    const requestId = message.requestId;
    if (!this.appServer) {
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-interrupt-response",
        requestId,
        error: "app-server unavailable"
      });
      return;
    }

    try {
      const params = message.params || message.interruptParams || {};
      await this.appServer.sendRequest("turn/interrupt", params);
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-interrupt-response",
        requestId,
        error: null
      });
    } catch (error) {
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-interrupt-response",
        requestId,
        error: toErrorMessage(error)
      });
    }
  }

  async _handleWorkerMessage(ws, workerId, payload) {
    if (workerId !== "git") {
      this.sendBridgeError(ws, "unsupported_worker", `Unsupported worker id: ${workerId}`);
      return;
    }

    await this.gitWorker.postMessage(ws, payload);
  }

  _openInBrowser(ws, message) {
    const url = message.url || message.href;
    if (!url) {
      this.sendBridgeError(ws, "missing_url", "open-in-browser requires `url`.");
      return;
    }

    const child = childSpawn("open", [url], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true
    });
    child.unref();
  }

  sendBridgeEnvelope(ws, envelope) {
    if (!ws || ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(envelope));
  }

  sendMainMessage(ws, payload) {
    const payloadWithHostId =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? {
            hostId: payload.hostId ?? this.hostConfig.id,
            ...payload
          }
        : payload;

    this.sendBridgeEnvelope(ws, {
      type: "main-message",
      payload: payloadWithHostId
    });
  }

  broadcastMainMessage(payload) {
    for (const ws of this.clients) {
      this.sendMainMessage(ws, payload);
    }
  }

  sendWorkerEvent(ws, workerId, payload) {
    this.sendBridgeEnvelope(ws, {
      type: "worker-event",
      workerId,
      payload
    });
  }

  broadcastWorkerEvent(workerId, payload) {
    for (const ws of this.clients) {
      this.sendWorkerEvent(ws, workerId, payload);
    }
  }

  sendBridgeError(ws, code, message, details) {
    this.logger.warn("bridge-error", {
      code,
      message
    });
    this.sendBridgeEnvelope(ws, {
      type: "bridge-error",
      code,
      message,
      details
    });
  }
}
