import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import * as asar from "@electron/asar";

import { channelPaths, getChannel, parseArgs, projectRoot } from "./lib/config.mjs";
import { assertLinuxChromeExtensionHost } from "./lib/chrome-extension-smoke.mjs";
import {
  hasLinuxWindowFocusableContractSource,
  hasUnguardedDynamicToolSchemaContractSource,
  hasUnguardedDynamicToolStartResponseSource,
  hasUnguardedDynamicToolThreadStartBridgeSource,
  hasUnguardedDynamicToolThreadStartRequestSource,
  hasUnguardedLinuxWindowFocusableSource,
  hasUnguardedOwlFeatureBindingSource
} from "./lib/upstream-patches.mjs";

const nativeExtensions = new Set([
  "",
  ".AppImage",
  ".bin",
  ".dll",
  ".dylib",
  ".node",
  ".so"
]);

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  const summary = await smokeLinuxArtifacts(await smokeOptionsFromArgs(args));

  if (args["json-output"]) {
    await writeJson(path.resolve(String(args["json-output"])), summary);
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

export async function smokeLinuxArtifacts({
  channelName,
  linuxDir,
  packageDir,
  webPort,
  browser = true
}) {
  const channel = channelName ? getChannel(channelName) : null;
  const executableName = channel?.executableName || await findDesktopExecutable(linuxDir);
  const executablePath = path.join(linuxDir, executableName);
  const resourcesDir = path.join(linuxDir, "resources");
  const summary = {
    channel: channelName || null,
    linuxDir,
    packageDir: packageDir || null,
    checks: []
  };

  await accessFile(executablePath, "desktop executable");
  await runCheck(summary, "linux-native-payloads", () =>
    assertNoForeignNativePayloads(linuxDir)
  );
  await runCheck(summary, "chrome-extension-host", () =>
    assertLinuxChromeExtensionHost(resourcesDir, channelName || "prod")
  );
  await runCheck(summary, "node-runtime", () =>
    assertCommandSuccess(path.join(resourcesDir, "node"), ["--version"], {
      expectStdout: /^v\d+\.\d+\.\d+/
    })
  );
  await runCheck(summary, "bundled-codex-launcher", () =>
    assertBundledCodexLauncher(linuxDir, executablePath, resourcesDir)
  );
  await runCheck(summary, "node_repl", () =>
    smokeNodeRepl(path.join(resourcesDir, "node_repl"))
  );
  await runCheck(summary, "cua_node_repl", () =>
    smokeNodeRepl(path.join(resourcesDir, "cua_node", "bin", "node_repl"))
  );
  await runCheck(summary, "owl-runtime-contract", () =>
    assertOwlRuntimeContract(resourcesDir)
  );
  await runCheck(summary, "linux-window-focusable-contract", () =>
    assertLinuxWindowFocusableContract(resourcesDir)
  );
  await runCheck(summary, "dynamic-tool-schema-contract", () =>
    assertDynamicToolSchemaContract(resourcesDir)
  );
  await runCheck(summary, "dynamic-tool-start-response-contract", () =>
    assertDynamicToolStartResponseContract(resourcesDir)
  );
  await runCheck(summary, "dynamic-tool-thread-start-bridge-contract", () =>
    assertDynamicToolThreadStartBridgeContract(resourcesDir)
  );
  await runCheck(summary, "dynamic-tool-thread-start-request-contract", () =>
    assertDynamicToolThreadStartRequestContract(resourcesDir)
  );

  if (packageDir) {
    await runCheck(summary, "desktop-launcher-version", () =>
      assertCommandSuccess(process.execPath, [path.join(packageDir, "runtime", "launcher.mjs"), "--version"], {
        env: {
          ...process.env,
          CODEX_APP_LINUX_PACKAGE_ROOT: packageDir
        },
        expectStdout: /\d+\.\d+\.\d+/
      })
    );
  }

  await runCheck(summary, "desktop-binary-boot", () =>
    smokeDesktopBinary(executablePath, resourcesDir)
  );

  if (browser) {
    await runCheck(summary, "web-browser-shell", () =>
      smokeWebShell({
        linuxDir,
        packageDir,
        port: webPort || 0
      })
    );
  }

  return {
    ...summary,
    ok: summary.checks.every(check => check.ok)
  };
}

async function smokeOptionsFromArgs(args) {
  const channelName = args.channel ? String(args.channel) : null;
  const releaseJsonPath = args["release-json"] ? path.resolve(String(args["release-json"])) : null;
  const release = releaseJsonPath
    ? JSON.parse(await fs.readFile(releaseJsonPath, "utf8"))
    : {};
  const paths = channelName ? channelPaths(channelName) : null;
  const linuxDir = path.resolve(
    String(args["linux-dir"] || release.linuxDir || (paths && path.join(paths.outputDir, "linux-unpacked")) || "")
  );

  if (!linuxDir || linuxDir === projectRoot) {
    throw new Error("--linux-dir, --release-json, or --channel is required");
  }

  return {
    channelName: channelName || release.channel || null,
    linuxDir,
    packageDir: args["package-dir"] || release.packageDir
      ? path.resolve(String(args["package-dir"] || release.packageDir))
      : null,
    webPort: args["web-port"] ? Number(args["web-port"]) : 0,
    browser: args["no-browser"] !== true
  };
}

async function runCheck(summary, name, fn) {
  const startedAt = Date.now();

  try {
    const detail = await fn();
    summary.checks.push({
      name,
      ok: true,
      durationMs: Date.now() - startedAt,
      detail: detail || {}
    });
  } catch (error) {
    summary.checks.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: toErrorMessage(error)
    });
    throw new Error(`${name} smoke failed: ${toErrorMessage(error)}`, {
      cause: error
    });
  }
}

async function assertNoForeignNativePayloads(rootDir) {
  const files = await listFiles(rootDir);
  const checked = [];

  for (const filePath of files) {
    const stat = await fs.stat(filePath);

    if (!isNativeCandidate(filePath, stat)) {
      continue;
    }

    const fileType = (await runCommand("file", ["-b", filePath], { capture: true })).stdout.trim();

    if (isForeignNativeFileType(fileType)) {
      throw new Error(`${path.relative(rootDir, filePath)} is not Linux x64: ${fileType}`);
    }

    checked.push(path.relative(rootDir, filePath));
  }

  return {
    checked: checked.length
  };
}

function isNativeCandidate(filePath, stat) {
  const ext = path.extname(filePath);

  return nativeExtensions.has(ext) || Boolean(stat.mode & 0o111);
}

function isForeignNativeFileType(fileType) {
  if (/\bMach-O\b/i.test(fileType)) {
    return true;
  }

  if (/\b(arm64|aarch64|ARM aarch64)\b/i.test(fileType)) {
    return true;
  }

  if (/\bELF\b/i.test(fileType) && !/\bx86-64\b/i.test(fileType)) {
    return true;
  }

  return /\bPE32\b/i.test(fileType);
}

async function smokeNodeRepl(executablePath) {
  await accessFile(executablePath, "node_repl");

  const result = await runCommand(executablePath, [], {
    input: "",
    capture: true,
    timeoutMs: 5000
  });
  const combined = `${result.stdout}\n${result.stderr}`;

  if (
    result.code !== 1 ||
    !combined.includes("failed to start stdio MCP server") ||
    !combined.includes("initialize request")
  ) {
    throw new Error(`unexpected node_repl startup result: exit=${result.code} output=${combined.slice(0, 400)}`);
  }

  return {
    exitCode: result.code
  };
}

async function assertBundledCodexLauncher(linuxDir, executablePath, resourcesDir) {
  const bundledCodexPath = path.join(resourcesDir, "codex");
  await accessFile(bundledCodexPath, "bundled Codex CLI");

  const launcherSource = await fs.readFile(executablePath, "utf8");
  evaluateBundledCodexLauncherSource(launcherSource);

  return {
    launcher: path.relative(linuxDir, executablePath),
    bundledCodex: path.relative(linuxDir, bundledCodexPath)
  };
}

export function evaluateBundledCodexLauncherSource(source) {
  const envOverrideIndex = source.indexOf("CODEX_CLI_PATH");
  const bundledIndex = source.indexOf('bundled_codex="$script_dir/resources/codex"');
  const pathFallbackIndex = source.indexOf("command -v codex");

  if (!source.startsWith("#!/bin/sh")) {
    throw new Error("desktop launcher is not the expected shell wrapper");
  }

  if (envOverrideIndex === -1) {
    throw new Error("desktop launcher does not honor CODEX_CLI_PATH");
  }

  if (bundledIndex === -1) {
    throw new Error("desktop launcher does not prefer bundled resources/codex");
  }

  if (pathFallbackIndex !== -1 && pathFallbackIndex < bundledIndex) {
    throw new Error("desktop launcher resolves PATH codex before bundled resources/codex");
  }
}

async function smokeDesktopBinary(executablePath, resourcesDir) {
  const result = await runCommand(executablePath, ["--no-sandbox"], {
    capture: true,
    timeoutMs: 8000,
    env: {
      ...process.env,
      CODEX_CLI_PATH: path.join(resourcesDir, "codex"),
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_ENABLE_LOGGING: "1"
    },
    allowTimeout: true,
    onTimeout: () => ({
      windowTree: readX11WindowTree()
    })
  });

  return evaluateDesktopBootResult(result);
}

export function evaluateDesktopBootResult(result) {
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  const windowTree = result.windowTree || "";
  const diagnosticText = `${combined}\n${windowTree}`;
  const reachedBootLog = combined.includes("Launching app") || combined.includes("Codex CLI initialized");
  const fatalOutput = /(Fatal|TypeError|ReferenceError|ErrorBoundary|segmentation fault|core dumped)/i.test(combined);
  const startupFailureDialog =
    /failed to start|No such binding was linked|electron_common_owl_features/i.test(windowTree);

  if (fatalOutput) {
    throw new Error(`desktop binary printed fatal output: exit=${result.code} output=${combined.slice(0, 600)}`);
  }

  if (startupFailureDialog) {
    throw new Error(`desktop binary showed startup failure dialog: exit=${result.code} output=${diagnosticText.slice(0, 1000)}`);
  }

  if (result.code && result.code !== 0 && !result.timedOut) {
    throw new Error(`desktop binary exited early: exit=${result.code} output=${combined.slice(0, 600)}`);
  }

  if (!reachedBootLog && !result.timedOut && result.code !== 0) {
    throw new Error(`desktop binary did not reach boot logs or exit cleanly: exit=${result.code} output=${combined.slice(0, 600)}`);
  }

  return {
    exitCode: result.code,
    timedOut: result.timedOut,
    bootSignal: reachedBootLog ? "log" : result.timedOut ? "alive-timeout" : "clean-exit",
    inspectedWindows: Boolean(windowTree)
  };
}

async function assertOwlRuntimeContract(resourcesDir) {
  const metadataPath = path.join(resourcesDir, "owl-electron-app.json");
  let metadata;

  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        runtimeName: null,
        skipped: true
      };
    }

    throw error;
  }

  if (metadata.runtimeName !== "owl") {
    return {
      runtimeName: metadata.runtimeName || null
    };
  }

  const appAsarPath = path.join(resourcesDir, "app.asar");
  const unsafeSources = await findUnguardedOwlBindingSources(appAsarPath);

  if (unsafeSources.length > 0) {
    throw new Error(
      `Owl runtime requires electron_common_owl_features, but ${unsafeSources.slice(0, 5).join(", ")} lacks the Linux fallback; stock Electron will show "No such binding was linked: electron_common_owl_features"`
    );
  }

  return {
    runtimeName: metadata.runtimeName,
    checked: true
  };
}

async function assertDynamicToolSchemaContract(resourcesDir) {
  const appAsarPath = path.join(resourcesDir, "app.asar");
  const unsafeSources = await findUnguardedDynamicToolSchemaSources(appAsarPath);

  if (unsafeSources.unsafe.length > 0) {
    throw new Error(
      `Thread-start dynamic tools must normalize inputSchema before startThread; ${unsafeSources.unsafe.slice(0, 5).join(", ")} still exposes an unguarded dynamic tool mapper and can fail with "Invalid request: missing field inputSchema"`
    );
  }

  if (unsafeSources.checked === 0) {
    throw new Error("Unable to find thread-start dynamic tool schema contract in app.asar");
  }

  return {
    checked: unsafeSources.checked
  };
}

async function assertLinuxWindowFocusableContract(resourcesDir) {
  const appAsarPath = path.join(resourcesDir, "app.asar");
  const unsafeSources = await findLinuxWindowFocusableContractSources(appAsarPath);

  if (unsafeSources.unsafe.length > 0) {
    throw new Error(
      `Linux primary BrowserWindow must default undefined focusable to true; ${unsafeSources.unsafe.slice(0, 5).join(", ")} still passes a destructured focusable value directly and can create an unmanageable, unfocusable X11 window`
    );
  }

  if (unsafeSources.checked === 0) {
    throw new Error("Unable to find Linux BrowserWindow focusable contract in app.asar");
  }

  return {
    checked: unsafeSources.checked
  };
}

async function assertDynamicToolStartResponseContract(resourcesDir) {
  const appAsarPath = path.join(resourcesDir, "app.asar");
  const unsafeSources = await findUnguardedDynamicToolStartResponseSources(appAsarPath);

  if (unsafeSources.unsafe.length > 0) {
    throw new Error(
      `Desktop thread-start dynamic tools must normalize inputSchema before app-server thread/start; ${unsafeSources.unsafe.slice(0, 5).join(", ")} still resolves raw dynamicTools and can fail with "Invalid request: missing field inputSchema"`
    );
  }

  if (unsafeSources.checked === 0) {
    throw new Error("Unable to find desktop dynamic tool start response contract in app.asar");
  }

  return {
    checked: unsafeSources.checked
  };
}

async function assertDynamicToolThreadStartBridgeContract(resourcesDir) {
  const appAsarPath = path.join(resourcesDir, "app.asar");
  const unsafeSources = await findUnguardedDynamicToolThreadStartBridgeSources(appAsarPath);

  if (unsafeSources.unsafe.length > 0) {
    throw new Error(
      `Electron bridge thread/start requests must normalize dynamicTools inputSchema before app-server; ${unsafeSources.unsafe.slice(0, 5).join(", ")} still forwards raw params and can fail with "Invalid request: missing field inputSchema"`
    );
  }

  if (unsafeSources.checked === 0) {
    throw new Error("Unable to find Electron bridge thread/start request contract in app.asar");
  }

  return {
    checked: unsafeSources.checked
  };
}

async function assertDynamicToolThreadStartRequestContract(resourcesDir) {
  const appAsarPath = path.join(resourcesDir, "app.asar");
  const unsafeSources = await findUnguardedDynamicToolThreadStartRequestSources(appAsarPath);

  if (unsafeSources.unsafe.length > 0) {
    throw new Error(
      `Renderer thread/start requests must normalize dynamicTools inputSchema at request creation; ${unsafeSources.unsafe.slice(0, 5).join(", ")} still forwards raw params and can fail with "Invalid request: missing field inputSchema"`
    );
  }

  if (unsafeSources.checked === 0) {
    throw new Error("Unable to find renderer thread/start request params contract in app.asar");
  }

  return {
    checked: unsafeSources.checked
  };
}

async function findLinuxWindowFocusableContractSources(appAsarPath) {
  const files = await asar.listPackage(appAsarPath);
  const sources = [];

  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/i.test(file)) {
      continue;
    }

    let source;

    try {
      source = asar.extractFile(appAsarPath, file.replace(/^\//, "")).toString("utf8");
    } catch {
      continue;
    }

    if (!source.includes("BrowserWindow") || !source.includes("focusable")) {
      continue;
    }

    sources.push({
      file: file.replace(/^\//, ""),
      source
    });
  }

  return evaluateLinuxWindowFocusableContractSources(sources);
}

export function evaluateLinuxWindowFocusableContractSources(sources) {
  const unsafe = [];
  let checked = 0;

  for (const { file, source } of sources) {
    if (!hasLinuxWindowFocusableContractSource(source)) {
      continue;
    }

    checked++;

    if (hasUnguardedLinuxWindowFocusableSource(source)) {
      unsafe.push(file);
    }
  }

  return {
    checked,
    unsafe
  };
}

async function findUnguardedDynamicToolThreadStartBridgeSources(appAsarPath) {
  const files = await asar.listPackage(appAsarPath);
  const unsafe = [];
  let checked = 0;

  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/i.test(file)) {
      continue;
    }

    let source;

    try {
      source = asar.extractFile(appAsarPath, file.replace(/^\//, "")).toString("utf8");
    } catch {
      continue;
    }

    if (
      !source.includes("app_server.bridge_received") ||
      !source.includes("handleClientRequest") ||
      !source.includes("handlePrewarmThreadStart")
    ) {
      continue;
    }

    checked++;

    if (hasUnguardedDynamicToolThreadStartBridgeSource(source)) {
      unsafe.push(file.replace(/^\//, ""));
    }
  }

  return {
    checked,
    unsafe
  };
}

async function findUnguardedOwlBindingSources(appAsarPath) {
  const files = await asar.listPackage(appAsarPath);
  const unsafe = [];

  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/i.test(file)) {
      continue;
    }

    let source;

    try {
      source = asar.extractFile(appAsarPath, file.replace(/^\//, "")).toString("utf8");
    } catch {
      continue;
    }

    if (hasUnguardedOwlFeatureBindingSource(source)) {
      unsafe.push(file.replace(/^\//, ""));
    }
  }

  return unsafe;
}

async function findUnguardedDynamicToolStartResponseSources(appAsarPath) {
  const files = await asar.listPackage(appAsarPath);
  const unsafe = [];
  let checked = 0;

  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/i.test(file)) {
      continue;
    }

    let source;

    try {
      source = asar.extractFile(appAsarPath, file.replace(/^\//, "")).toString("utf8");
    } catch {
      continue;
    }

    if (
      !source.includes("handleDynamicToolsForThreadStartResponse") ||
      !source.includes("pendingDynamicToolsForThreadStartRequests")
    ) {
      continue;
    }

    checked++;

    if (hasUnguardedDynamicToolStartResponseSource(source)) {
      unsafe.push(file.replace(/^\//, ""));
    }
  }

  return {
    checked,
    unsafe
  };
}

async function findUnguardedDynamicToolSchemaSources(appAsarPath) {
  const files = await asar.listPackage(appAsarPath);
  const unsafe = [];
  let checked = 0;

  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/i.test(file)) {
      continue;
    }

    let source;

    try {
      source = asar.extractFile(appAsarPath, file.replace(/^\//, "")).toString("utf8");
    } catch {
      continue;
    }

    if (!source.includes("Tools provided by the Codex app.") || !source.includes("deferLoading")) {
      continue;
    }

    checked++;

    if (hasUnguardedDynamicToolSchemaContractSource(source)) {
      unsafe.push(file.replace(/^\//, ""));
    }
  }

  return {
    checked,
    unsafe
  };
}

async function findUnguardedDynamicToolThreadStartRequestSources(appAsarPath) {
  const files = await asar.listPackage(appAsarPath);
  const unsafe = [];
  let checked = 0;

  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/i.test(file)) {
      continue;
    }

    let source;

    try {
      source = asar.extractFile(appAsarPath, file.replace(/^\//, "")).toString("utf8");
    } catch {
      continue;
    }

    if (!source.includes("mcp_request_enqueued") || !source.includes("thread/start")) {
      continue;
    }

    checked++;

    if (hasUnguardedDynamicToolThreadStartRequestSource(source)) {
      unsafe.push(file.replace(/^\//, ""));
    }
  }

  return {
    checked,
    unsafe
  };
}

async function smokeWebShell({ linuxDir, packageDir, port }) {
  const actualPort = port || await allocatePort();
  const serverPath = path.join(packageDir || projectRoot, "runtime", "webstrap", "server.mjs");
  const server = spawn(process.execPath, [
    serverPath,
    "--codex-app",
    linuxDir,
    "--bind",
    "127.0.0.1",
    "--port",
    String(actualPort),
    "--dangerously-disable-auth",
    "true"
  ], {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = collectProcessOutput(server);

  try {
    await waitForHttpOk(`http://127.0.0.1:${actualPort}/__webstrapper/healthz`, 30_000);
    await smokeBrowserPage(`http://127.0.0.1:${actualPort}/`);
    return {
      url: `http://127.0.0.1:${actualPort}/`
    };
  } finally {
    await terminateProcess(server);

    if (server.exitCode && server.exitCode !== 0) {
      throw new Error(`web server exited with ${server.exitCode}: ${output().slice(0, 1000)}`);
    }
  }
}

async function smokeBrowserPage(url) {
  let chromium;

  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    throw new Error("Playwright is required for browser smoke. Run `npm install` and `npx playwright install chromium`.", {
      cause: error
    });
  }

  const browser = await chromium.launch({
    headless: true
  });
  const page = await browser.newPage();
  const fatalConsole = [];

  page.on("console", message => {
    const text = message.text();

    if (
      message.type() === "error" &&
      /(Cannot read|TypeError|ReferenceError|ErrorBoundary|Update required|no longer supported|Fatal)/i.test(text)
    ) {
      fatalConsole.push(text);
    }
  });
  page.on("pageerror", error => {
    fatalConsole.push(toErrorMessage(error));
  });

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    await page.waitForFunction(() => {
      const body = document.body;
      const text = body?.innerText || "";

      if (/Update required|no longer supported/i.test(text)) {
        return false;
      }

      const interactive = document.querySelector(
        'textarea,input,[contenteditable="true"],button,[role="button"],[role="textbox"],[aria-label*="New"],[aria-label*="chat" i]'
      );
      const splashOnly = body?.children.length <= 2 && document.querySelector("svg") && text.trim().length < 20;

      return Boolean(interactive) || (text.trim().length > 20 && !splashOnly);
    }, undefined, {
      timeout: 45_000
    });

    if (fatalConsole.length > 0) {
      throw new Error(`fatal browser console output: ${fatalConsole.slice(0, 5).join("\n")}`);
    }
  } finally {
    await browser.close();
  }
}

async function assertCommandSuccess(command, args, options = {}) {
  const result = await runCommand(command, args, {
    capture: true,
    timeoutMs: options.timeoutMs || 5000,
    env: options.env
  });

  if (result.code !== 0) {
    throw new Error(`${command} exited ${result.code}: ${result.stderr || result.stdout}`);
  }

  if (options.expectStdout && !options.expectStdout.test(result.stdout.trim())) {
    throw new Error(`${command} stdout did not match ${options.expectStdout}: ${result.stdout.trim()}`);
  }

  return {
    stdout: result.stdout.trim()
  };
}

async function listFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function findDesktopExecutable(linuxDir) {
  const entries = await fs.readdir(linuxDir, { withFileTypes: true });
  const executable = entries.find(entry => entry.isFile() && entry.name.startsWith("codex-app-linux"));

  if (!executable) {
    throw new Error(`Unable to find desktop executable under ${linuxDir}`);
  }

  return executable.name;
}

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      // server still starting
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function allocatePort() {
  const server = net.createServer();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  await new Promise(resolve => server.close(resolve));

  if (!port) {
    throw new Error("Failed to allocate web smoke port");
  }

  return port;
}

function runCommand(command, args, options = {}) {
  const {
    allowTimeout = false,
    capture = false,
    env = process.env,
    input,
    onTimeout,
    timeoutMs = 30_000
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env,
      stdio: capture ? ["pipe", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutMetadata = {};
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutMetadata = onTimeout?.() || {};
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", code => {
      clearTimeout(timer);

      if (timedOut && !allowTimeout) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }

      resolve({
        code,
        timedOut,
        stdout,
        stderr,
        ...timeoutMetadata
      });
    });

    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

function readX11WindowTree() {
  if (!process.env.DISPLAY) {
    return "";
  }

  const result = spawnSync("xwininfo", ["-root", "-tree"], {
    env: process.env,
    encoding: "utf8",
    timeout: 2000
  });

  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function collectProcessOutput(child) {
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", chunk => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", chunk => {
    stderr += chunk.toString();
  });

  return () => `${stdout}\n${stderr}`;
}

async function terminateProcess(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    sleep(3000).then(() => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    })
  ]);
}

async function accessFile(filePath, label) {
  try {
    await fs.access(filePath);
  } catch (error) {
    throw new Error(`Missing ${label}: ${filePath}`, {
      cause: error
    });
  }
}

async function writeJson(filePath, body) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
}
