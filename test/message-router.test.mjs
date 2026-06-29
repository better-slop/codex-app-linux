import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { MessageRouter } from "../runtime/webstrap/message-router.mjs";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

test("MessageRouter replies to failed MCP requests with mcp-response error", async () => {
  const appServer = new EventEmitter();
  appServer.sendRaw = async () => {
    throw new Error("app-server request timeout: account/read");
  };

  const router = new MessageRouter({
    appServer,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._forwardToAppServer(ws, {
    id: "req-1",
    method: "account/read",
    params: {}
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "main-message",
    payload: {
      hostId: "local",
      type: "mcp-response",
      message: {
        id: "req-1",
        result: null,
        error: {
          message: "app-server request timeout: account/read",
          code: -32000
        }
      }
    }
  });

  router.dispose();
});

test("MessageRouter ignores electron-only startup pings in web mode", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "hotkey-window-enabled-changed",
      enabled: true
    }
  });

  for (const type of [
    "remote-hosted-pip-visibility-changed",
    "remote-hosted-pip-active-thread-changed",
    "electron-avatar-overlay-feedback-diagnostics-changed",
    "electron-sparkle-gates-changed"
  ]) {
    await router.handleEnvelope(ws, {
      type: "view-message",
      payload: { type }
    });
  }

  assert.deepEqual(sent, []);

  router.dispose();
});

test("MessageRouter ignores side-panel runtime config change pings in web mode", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "codex-runtimes-config-changed",
      config: {
        selectedRuntime: "local"
      }
    }
  });

  assert.deepEqual(sent, []);

  router.dispose();
});

test("MessageRouter ignores app shell shortcut state pings in web mode", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "app-shell-shortcut-state-changed",
      enabled: true
    }
  });

  assert.deepEqual(sent, []);

  router.dispose();
});

test("MessageRouter ignores heartbeat automation thread state pings in web mode", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "heartbeat-automation-thread-state-changed",
      threadId: "thread-1",
      isEligible: true,
      collaborationMode: "default",
      reason: null
    }
  });

  assert.deepEqual(sent, []);

  router.dispose();
});

test("MessageRouter ignores mac menu bar pings in web mode", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "mac-menu-bar-enabled-changed",
      enabled: true
    }
  });

  assert.deepEqual(sent, []);

  router.dispose();
});

test("MessageRouter returns Codex code theme defaults for configuration reads", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._handleVirtualFetch(ws, "req-1", {
    requestId: "req-1",
    method: "POST",
    url: "vscode://codex/get-configuration",
    body: JSON.stringify({ key: "appearanceDarkCodeThemeId" })
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.status, 200);
  assert.equal(JSON.parse(sent[0].payload.bodyJsonString).value, "codex");

  router.dispose();
});

test("MessageRouter returns web settings in upstream shape", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._handleVirtualFetch(ws, "req-settings", {
    requestId: "req-settings",
    method: "POST",
    url: "vscode://codex/get-settings",
    body: JSON.stringify({})
  });

  await router._handleVirtualFetch(ws, "req-set-setting", {
    requestId: "req-set-setting",
    method: "POST",
    url: "vscode://codex/set-setting",
    body: JSON.stringify({
      params: {
        key: "mac-menu-bar-enabled",
        value: false
      }
    })
  });

  await router._handleVirtualFetch(ws, "req-get-setting", {
    requestId: "req-get-setting",
    method: "POST",
    url: "vscode://codex/get-setting",
    body: JSON.stringify({
      params: {
        key: "mac-menu-bar-enabled"
      }
    })
  });

  assert.deepEqual(JSON.parse(sent[0].payload.bodyJsonString), {
    values: {}
  });
  assert.deepEqual(JSON.parse(sent[1].payload.bodyJsonString), {
    ok: true
  });
  assert.deepEqual(JSON.parse(sent[2].payload.bodyJsonString), {
    value: false
  });

  router.dispose();
});

test("MessageRouter answers experimental feature enablement writes locally", async () => {
  const appServer = new EventEmitter();
  appServer.sendRaw = async () => {
    throw new Error("should not reach app-server");
  };

  const router = new MessageRouter({
    appServer,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._forwardToAppServer(ws, {
    id: "req-2",
    method: "experimentalFeature/enablement/set",
    params: {
      enablement: {
        tool_search: false
      }
    }
  });

  assert.deepEqual(sent[0], {
    type: "main-message",
    payload: {
      hostId: "local",
      type: "mcp-response",
      message: {
        id: "req-2",
        result: {
          enablement: {
            apps: true,
            plugins: true,
            tool_call_mcp_elicitation: true,
            tool_search: false,
            tool_suggest: false
          }
        },
        error: null
      }
    }
  });

  router.dispose();
});

test("MessageRouter provides browser-safe virtual fetch defaults", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._handleVirtualFetch(ws, "req-3", {
    requestId: "req-3",
    method: "POST",
    url: "vscode://codex/local-custom-agents",
    body: JSON.stringify({})
  });

  await router._handleVirtualFetch(ws, "req-4", {
    requestId: "req-4",
    method: "POST",
    url: "vscode://codex/hotkey-window-hotkey-state",
    body: JSON.stringify({})
  });

  await router._handleVirtualFetch(ws, "req-4b", {
    requestId: "req-4b",
    method: "POST",
    url: "vscode://codex/codex-command-keymap-state",
    body: JSON.stringify({})
  });

  await router._handleVirtualFetch(ws, "req-4c", {
    requestId: "req-4c",
    method: "POST",
    url: "vscode://codex/inbox-items",
    body: JSON.stringify({})
  });

  await router._handleVirtualFetch(ws, "req-4d", {
    requestId: "req-4d",
    method: "POST",
    url: "vscode://codex/chronicle-permissions",
    body: JSON.stringify({})
  });

  await router._handleVirtualFetch(ws, "req-4e", {
    requestId: "req-4e",
    method: "POST",
    url: "vscode://codex/set-remote-control-connections-enabled",
    body: JSON.stringify({})
  });

  await router._handleVirtualFetch(ws, "req-4f", {
    requestId: "req-4f",
    method: "POST",
    url: "vscode://codex/worktree-shell-environment-config",
    body: JSON.stringify({})
  });

  await router._handleVirtualFetch(ws, "req-5", {
    requestId: "req-5",
    method: "POST",
    url: "vscode://codex/ambient-suggestions",
    body: JSON.stringify({
      params: {
        projectRoot: "/tmp/project"
      }
    })
  });

  await router._handleVirtualFetch(ws, "req-6", {
    requestId: "req-6",
    method: "POST",
    url: "vscode://codex/ambient-suggestions-refresh",
    body: JSON.stringify({
      params: {
        projectRoot: "/tmp/project"
      }
    })
  });

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-workspace-"));
  await fs.mkdir(path.join(workspaceRoot, "src"));
  await fs.writeFile(path.join(workspaceRoot, "README.md"), "# hi\n");
  await fs.writeFile(path.join(workspaceRoot, ".env"), "SECRET=1\n");
  await fs.writeFile(path.join(workspaceRoot, "src", "index.js"), "console.log('hi');\n");

  await router._handleVirtualFetch(ws, "req-7", {
    requestId: "req-7",
    method: "POST",
    url: "vscode://codex/workspace-directory-entries",
    body: JSON.stringify({
      params: {
        workspaceRoot,
        includeHidden: false
      }
    })
  });

  await router._handleVirtualFetch(ws, "req-8", {
    requestId: "req-8",
    method: "POST",
    url: "vscode://codex/workspace-directory-entries",
    body: JSON.stringify({
      params: {
        workspaceRoot,
        directoryPath: "src/",
        includeHidden: true
      }
    })
  });

  await router._handleVirtualFetch(ws, "req-9", {
    requestId: "req-9",
    method: "POST",
    url: "vscode://codex/workspace-directory-entries",
    body: JSON.stringify({
      params: {
        workspaceRoot,
        includeHidden: true
      }
    })
  });

  assert.equal(JSON.parse(sent[0].payload.bodyJsonString).agents.length, 0);
  assert.deepEqual(JSON.parse(sent[1].payload.bodyJsonString).state, {
    supported: false,
    configuredHotkey: null
  });
  assert.deepEqual(JSON.parse(sent[2].payload.bodyJsonString), {
    bindings: []
  });
  assert.deepEqual(JSON.parse(sent[3].payload.bodyJsonString), {
    items: [],
    unreadRunCounts: {
      unreadRuns: [],
      total: 0
    }
  });
  assert.deepEqual(JSON.parse(sent[4].payload.bodyJsonString), {
    permissions: []
  });
  assert.deepEqual(JSON.parse(sent[5].payload.bodyJsonString), {
    ok: true
  });
  assert.deepEqual(JSON.parse(sent[6].payload.bodyJsonString), {
    env: {}
  });
  assert.deepEqual(JSON.parse(sent[7].payload.bodyJsonString), {
    file: {
      generatedAtMs: null,
      currentSuggestionIds: [],
      suggestions: []
    }
  });
  assert.equal(sent[8].payload.status, 202);
  assert.deepEqual(JSON.parse(sent[8].payload.bodyJsonString), {
    success: true
  });
  assert.deepEqual(JSON.parse(sent[9].payload.bodyJsonString), {
    entries: [
      {
        name: "src",
        path: "src",
        type: "directory"
      },
      {
        name: "README.md",
        path: "README.md",
        type: "file"
      }
    ]
  });
  assert.deepEqual(JSON.parse(sent[10].payload.bodyJsonString), {
    entries: [
      {
        name: "index.js",
        path: "src/index.js",
        type: "file"
      }
    ]
  });
  assert.deepEqual(JSON.parse(sent[11].payload.bodyJsonString), {
    entries: [
      {
        name: "src",
        path: "src",
        type: "directory"
      },
      {
        name: ".env",
        path: ".env",
        type: "file"
      },
      {
        name: "README.md",
        path: "README.md",
        type: "file"
      }
    ]
  });

  router.dispose();
});

test("MessageRouter returns base64 payloads for read-file-binary", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-router-"));
  const filePath = path.join(root, "icon.png");
  await fs.writeFile(filePath, "png-data");

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._handleVirtualFetch(ws, "req-5", {
    requestId: "req-5",
    method: "POST",
    url: "vscode://codex/read-file-binary",
    body: JSON.stringify({
      params: {
        path: filePath,
        hostId: "local"
      }
    })
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.status, 200);
  assert.deepEqual(JSON.parse(sent[0].payload.bodyJsonString), {
    contentsBase64: Buffer.from("png-data").toString("base64"),
    mimeType: null,
    sizeBytes: 8
  });

  router.dispose();
});

test("MessageRouter returns text payloads for read-file from workspace-relative paths", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-read-file-"));
  await fs.mkdir(path.join(workspaceRoot, "docs"));
  await fs.writeFile(path.join(workspaceRoot, "docs", "notes.md"), "hello\nworld\n");

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._handleVirtualFetch(ws, "req-6", {
    requestId: "req-6",
    method: "POST",
    url: "vscode://codex/read-file",
    body: JSON.stringify({
      params: {
        workspaceRoot,
        path: "docs/notes.md",
        hostId: "local"
      }
    })
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.status, 200);
  assert.deepEqual(JSON.parse(sent[0].payload.bodyJsonString), {
    contents: "hello\nworld\n"
  });

  router.dispose();
});

test("MessageRouter rejects read-file path escapes outside workspace root", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-read-file-"));
  await fs.writeFile(path.join(workspaceRoot, "safe.txt"), "ok\n");

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._handleVirtualFetch(ws, "req-7", {
    requestId: "req-7",
    method: "POST",
    url: "vscode://codex/read-file",
    body: JSON.stringify({
      params: {
        workspaceRoot,
        path: "../escape.txt",
        hostId: "local"
      }
    })
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.status, 404);
  assert.deepEqual(JSON.parse(sent[0].payload.bodyJsonString), {
    contents: ""
  });

  router.dispose();
});

test("MessageRouter returns file metadata and browser editor targets for opened files", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-open-file-"));
  await fs.mkdir(path.join(workspaceRoot, "docs"));
  await fs.writeFile(path.join(workspaceRoot, "docs", "notes.md"), "hello world\n");

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._handleVirtualFetch(ws, "req-open", {
    requestId: "req-open",
    method: "POST",
    url: "vscode://codex/open-file",
    body: JSON.stringify({
      params: {
        workspaceRoot,
        path: "docs/notes.md",
        hostId: "local",
        line: 3,
        column: 4
      }
    })
  });

  await router._handleVirtualFetch(ws, "req-meta", {
    requestId: "req-meta",
    method: "POST",
    url: "vscode://codex/read-file-metadata",
    body: JSON.stringify({
      params: {
        workspaceRoot,
        path: "docs/notes.md",
        hostId: "local"
      }
    })
  });

  await router._handleVirtualFetch(ws, "req-ide", {
    requestId: "req-ide",
    method: "POST",
    url: "vscode://codex/ide-context",
    body: JSON.stringify({
      params: {
        workspaceRoot
      }
    })
  });

  await router._handleVirtualFetch(ws, "req-targets", {
    requestId: "req-targets",
    method: "POST",
    url: "vscode://codex/open-in-targets",
    body: JSON.stringify({
      params: {
        workspaceRoot,
        path: "docs/notes.md",
        hostId: "local"
      }
    })
  });

  const filePath = path.join(workspaceRoot, "docs", "notes.md");

  assert.equal(sent.length, 4);
  assert.equal(sent[0].payload.status, 200);
  assert.deepEqual(JSON.parse(sent[0].payload.bodyJsonString), {
    success: true,
    opened: {
      hostId: "local",
      path: filePath,
      line: 3,
      column: 4
    }
  });
  assert.deepEqual(JSON.parse(sent[1].payload.bodyJsonString), {
    exists: true,
    isFile: true,
    sizeBytes: 12,
    lastModifiedMs: JSON.parse(sent[1].payload.bodyJsonString).lastModifiedMs,
    name: "notes.md",
    path: filePath
  });
  assert.deepEqual(JSON.parse(sent[2].payload.bodyJsonString), {
    ideContext: {
      workspaceRoot,
      roots: [workspaceRoot],
      openFiles: [{
        hostId: "local",
        path: filePath,
        line: 3,
        column: 4
      }],
      activeEditor: {
        hostId: "local",
        path: filePath,
        line: 3,
        column: 4
      }
    },
    roots: []
  });
  assert.deepEqual(JSON.parse(sent[3].payload.bodyJsonString), {
    mode: "editor",
    preferredTarget: "browserEditor",
    availableTargets: ["browserEditor"],
    targets: [{
      id: "browser-editor",
      target: "browserEditor",
      label: "Editor",
      kind: "editor",
      appPath: null,
      hidden: false,
      default: true,
      icon: null
    }]
  });

  router.dispose();
});

test("MessageRouter opens cwd-relative files from chat references", async () => {
  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    workerPath: null,
    logger: createLogger()
  });

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-open-file-cwd-"));
  await fs.mkdir(path.join(workspaceRoot, "src"));
  await fs.writeFile(path.join(workspaceRoot, "src", "main.rs"), "fn main() {}\n");

  const sent = [];
  const ws = {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };

  await router._handleVirtualFetch(ws, "req-open-cwd", {
    requestId: "req-open-cwd",
    method: "POST",
    url: "vscode://codex/open-file",
    body: JSON.stringify({
      params: {
        cwd: workspaceRoot,
        path: "src/main.rs",
        line: 1,
        column: 4
      }
    })
  });

  const filePath = path.join(workspaceRoot, "src", "main.rs");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.status, 200);
  assert.deepEqual(JSON.parse(sent[0].payload.bodyJsonString), {
    success: true,
    opened: {
      hostId: "local",
      path: filePath,
      line: 1,
      column: 4
    }
  });

  router.dispose();
});
