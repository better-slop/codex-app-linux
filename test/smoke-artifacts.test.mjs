import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBundledCodexLauncherSource,
  evaluateDesktopBootResult,
  evaluateLinuxWindowFocusableContractSources
} from "../scripts/smoke-artifacts.mjs";

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
