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

  assert.equal(JSON.parse(sent[0].payload.bodyJsonString).agents.length, 0);
  assert.deepEqual(JSON.parse(sent[1].payload.bodyJsonString).state, {
    supported: false,
    configuredHotkey: null
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
