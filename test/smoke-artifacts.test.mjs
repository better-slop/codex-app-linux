import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBundledCodexLauncherSource,
  evaluateDesktopBootResult,
  evaluateLinuxWindowFocusableContractSources,
  runCommandForTest
} from "../scripts/smoke-artifacts.mjs";
import {
  evaluateLinuxChromeExtensionHostArtifact,
  evaluateLinuxChromeExtensionHostEnsure,
  evaluateLinuxChromeExtensionHostHello,
  parseNativeMessageFrame
} from "../scripts/lib/chrome-extension-smoke.mjs";

test("desktop boot smoke accepts a silent process still alive at timeout", () => {
  assert.deepEqual(
    evaluateDesktopBootResult({
      code: null,
      timedOut: true,
      stdout: "",
      stderr: ""
    }),
    {
      exitCode: null,
      timedOut: true,
      bootSignal: "alive-timeout",
      inspectedWindows: false
    }
  );
});

test("desktop boot smoke still rejects fatal output", () => {
  assert.throws(
    () => evaluateDesktopBootResult({
      code: null,
      timedOut: true,
      stdout: "",
      stderr: "TypeError: Cannot read properties of undefined"
    }),
    /desktop binary printed fatal output/
  );
});

test("desktop boot smoke still rejects early failed exits", () => {
  assert.throws(
    () => evaluateDesktopBootResult({
      code: 1,
      timedOut: false,
      stdout: "",
      stderr: "failed before app ready"
    }),
    /desktop binary exited early/
  );
});

test("desktop boot smoke rejects native failed-start dialogs", () => {
  assert.throws(
    () => evaluateDesktopBootResult({
      code: null,
      timedOut: true,
      stdout: "",
      stderr: "",
      windowTree: '0x200001 "Codex (Beta) failed to start.": ("codex-app-linux-beta-bin" "Codex (Beta)")'
    }),
    /desktop binary showed startup failure dialog/
  );
});

test("timed-out smoke commands terminate descendants holding stdio open", {
  skip: process.platform === "win32"
}, async () => {
  const startedAt = Date.now();
  const result = await runCommandForTest(
    process.execPath,
    [
      "-e",
      `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
        stdio: ["ignore", "inherit", "inherit"]
      });
      setInterval(() => {}, 60000);`
    ],
    { allowTimeout: true, capture: true, timeoutMs: 100 }
  );

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 2000);
});

test("bundled Codex launcher smoke rejects PATH-first wrappers", () => {
  assert.throws(
    () => evaluateBundledCodexLauncherSource(`#!/bin/sh
set -eu
candidate="$(command -v codex 2>/dev/null || true)"
bundled_codex="$script_dir/resources/codex"
export CODEX_CLI_PATH="$candidate"
`),
    /resolves PATH codex before bundled/
  );
});

test("bundled Codex launcher smoke accepts bundled-first wrappers", () => {
  assert.doesNotThrow(() => evaluateBundledCodexLauncherSource(`#!/bin/sh
set -eu
if [ -n "\${CODEX_CLI_PATH:-}" ]; then
  true
fi
bundled_codex="$script_dir/resources/codex"
candidate="$(command -v codex 2>/dev/null || true)"
export CODEX_CLI_PATH="$bundled_codex"
`));
});

test("Linux window focusable smoke reports unguarded BrowserWindow defaults", () => {
  const source = [
    "function createWindow(e={}){",
    "let{focusable:m}=e;",
    "new a.BrowserWindow({title:`Codex`,focusable:m})",
    "}"
  ].join("");

  assert.deepEqual(
    evaluateLinuxWindowFocusableContractSources([
      { file: ".vite/build/main.js", source }
    ]),
    {
      checked: 1,
      unsafe: [".vite/build/main.js"]
    }
  );
});

test("Linux window focusable smoke accepts patched and legacy-safe defaults", () => {
  const patched = [
    "function createWindow(e={}){",
    "let{focusable:m}=e;",
    "new a.BrowserWindow({title:`Codex`,focusable:m??!0})",
    "}"
  ].join("");
  const legacy = [
    "function createWindow(e={}){",
    "let{focusable:m}=e;",
    "new a.BrowserWindow({title:`Codex`,...(m==null?{}:{focusable:m})})",
    "}"
  ].join("");

  assert.deepEqual(
    evaluateLinuxWindowFocusableContractSources([
      { file: ".vite/build/main.js", source: patched },
      { file: ".vite/build/legacy.js", source: legacy },
      { file: ".vite/build/overlay.js", source: "new a.BrowserWindow({focusable:!1})" }
    ]),
    {
      checked: 2,
      unsafe: []
    }
  );
});

test("Chrome extension host smoke accepts an executable static PIE x64 host", () => {
  assert.deepEqual(
    evaluateLinuxChromeExtensionHostArtifact({
      fileType:
        "ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), static-pie linked, stripped",
      mode: 0o755
    }),
    {
      executable: true,
      static: true,
      architecture: "x86-64"
    }
  );
});

test("Chrome extension host smoke rejects dynamic and non-executable hosts", () => {
  assert.throws(
    () =>
      evaluateLinuxChromeExtensionHostArtifact({
        fileType:
          "ELF 64-bit LSB pie executable, x86-64, dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2",
        mode: 0o755
      }),
    /must be statically linked/
  );
  assert.throws(
    () =>
      evaluateLinuxChromeExtensionHostArtifact({
        fileType:
          "ELF 64-bit LSB pie executable, x86-64, static-pie linked, stripped",
        mode: 0o644
      }),
    /must be executable/
  );
});

test("Chrome extension host smoke decodes and verifies the protocol-v2 hello", () => {
  const message = {
    jsonrpc: "2.0",
    id: "smoke-hello",
    result: {
      manifestSchemaVersion: 2,
      nativeHostProtocolVersion: 2,
      nativeHostVersion: "0.1.0",
      supportedProtocolVersions: [2],
      supportedMethods: ["codexRuntime/openLocalFile"]
    }
  };
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length);
  body.copy(frame, 4);

  assert.deepEqual(parseNativeMessageFrame(frame), message);
  assert.deepEqual(evaluateLinuxChromeExtensionHostHello(message), {
    protocolVersion: 2,
    version: "0.1.0"
  });
  assert.throws(
    () => evaluateLinuxChromeExtensionHostHello({ ...message, id: "wrong" }),
    /unexpected hello response ID/
  );
  assert.throws(() => parseNativeMessageFrame(frame.subarray(0, -1)), /truncated/);
});

test("Chrome extension host smoke verifies desktop-managed runtime selection", () => {
  const message = {
    jsonrpc: "2.0",
    id: "smoke-ensure",
    result: {
      entryId: "linux-managed-smoke",
      localAppServerUrl: "ws://127.0.0.1:4567/?token=secret",
      runtimeSessionId: "session",
      selected: {
        appServerProtocolVersion: 2,
        channel: "prod",
        nativeHostProtocolVersion: 2
      },
      runtimeConfig: {
        platform: "linux",
        codexCliPath: "/opt/codex/resources/codex",
        codexHome: "/tmp/codex-home",
        desktopAgentModeDefaults: {
          agentModesByHostId: {},
          preferredNonFullAccessModesByHostId: {}
        },
        nodePath: "/opt/codex/resources/node"
      }
    }
  };

  assert.deepEqual(
    evaluateLinuxChromeExtensionHostEnsure(message, {
      channelName: "prod",
      codexCliPath: "/opt/codex/resources/codex",
      codexHome: "/tmp/codex-home",
      nodePath: "/opt/codex/resources/node"
    }),
    {
      channel: "prod",
      entryId: "linux-managed-smoke",
      protocolVersion: 2
    }
  );
  assert.throws(
    () => evaluateLinuxChromeExtensionHostEnsure({ ...message, id: "wrong" }, {}),
    /unexpected ensure response ID/
  );
  assert.throws(
    () => evaluateLinuxChromeExtensionHostEnsure({
      ...message,
      result: {
        ...message.result,
        runtimeConfig: {
          ...message.result.runtimeConfig,
          desktopAgentModeDefaults: null
        }
      }
    }, {
      channelName: "prod",
      codexCliPath: "/opt/codex/resources/codex",
      codexHome: "/tmp/codex-home",
      nodePath: "/opt/codex/resources/node"
    }),
    /incompatible managed runtime/
  );
});
