import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { projectRoot } from "./config.mjs";

const extensionId = "hehggadaopoacecdllhhajmbjkdcmajg";
const nativeHostName = "com.openai.codexextension";
const smokeEntryId = "linux-managed-smoke";

/** Verify the packaged ELF and execute a real protocol-v2 hello exchange. */
export async function assertLinuxChromeExtensionHost(resourcesDir, channelName) {
  resourcesDir = path.resolve(resourcesDir);
  const pluginRoot = path.join(
    resourcesDir,
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome"
  );
  const hostPath = path.join(
    pluginRoot,
    "extension-host",
    "linux",
    "x64",
    "extension-host"
  );

  await fs.access(hostPath).catch(error => {
    throw new Error(`Missing Chrome extension host: ${hostPath}`, { cause: error });
  });
  const [stat, fileType] = await Promise.all([
    fs.stat(hostPath),
    runFileType(hostPath)
  ]);
  const artifact = evaluateLinuxChromeExtensionHostArtifact({
    fileType,
    mode: stat.mode & 0o777
  });
  const protocol = await smokeLinuxChromeExtensionHostProtocol({
    channelName,
    hostPath,
    pluginRoot,
    resourcesDir
  });

  return {
    path: path.relative(resourcesDir, hostPath),
    ...artifact,
    ...protocol
  };
}

export function evaluateLinuxChromeExtensionHostArtifact({ fileType, mode }) {
  if ((mode & 0o111) === 0) {
    throw new Error(`Chrome extension host must be executable (mode ${mode.toString(8)})`);
  }
  if (!/\bELF\b/.test(fileType) || !/\bx86-64\b/.test(fileType)) {
    throw new Error(`Chrome extension host must be a Linux x86-64 ELF: ${fileType}`);
  }
  if (!/\b(?:static-pie|statically) linked\b/i.test(fileType)) {
    throw new Error(`Chrome extension host must be statically linked: ${fileType}`);
  }

  return {
    executable: true,
    static: true,
    architecture: "x86-64"
  };
}

async function smokeLinuxChromeExtensionHostProtocol({
  channelName,
  hostPath,
  pluginRoot,
  resourcesDir
}) {
  const temporaryDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-chrome-host-smoke-")
  );
  const temporaryHostPath = path.join(temporaryDir, "extension-host");
  const codexHome = path.join(temporaryDir, "codex-home");
  const stateHome = path.join(temporaryDir, "state");
  const socketDir = path.join(temporaryDir, "sockets");
  try {
    await fs.copyFile(hostPath, temporaryHostPath);
    await fs.chmod(temporaryHostPath, 0o755);
    await Promise.all([
      fs.mkdir(codexHome, { recursive: true }),
      fs.mkdir(stateHome, { recursive: true }),
      fs.mkdir(socketDir, { recursive: true })
    ]);
    const codexCliPath = path.join(resourcesDir, "codex");
    const nodePath = path.join(resourcesDir, "node");
    const registry = managedRegistry({
      channelName,
      codexCliPath,
      codexHome,
      hostPath: temporaryHostPath,
      nodePath,
      pluginRoot,
      resourcesDir
    });
    await Promise.all([
      writeRegistry(
        path.join(stateHome, "openai-codex", "chrome-native-hosts-v2.json"),
        registry
      ),
      writeRegistry(path.join(codexHome, "chrome-native-hosts-v2.json"), registry)
    ]);
    const environment = {
      ...process.env,
      CODEX_BROWSER_USE_SOCKET_DIR: socketDir,
      CODEX_HOME: codexHome,
      HOME: temporaryDir,
      XDG_STATE_HOME: stateHome
    };
    const constraints = {
      extensionBuildChannel: channelName,
      extensionId,
      extensionVersion: "smoke",
      nativeHostName,
      requiredAppServerProtocolVersion: 2,
      requiredNativeHostProtocolVersion: 2
    };
    const helloRequest = nativeMessageFrame({
      jsonrpc: "2.0",
      id: "smoke-hello",
      method: "codexRuntime/hello",
      params: { constraints }
    });
    const helloResult = await runNativeMessage(
      temporaryHostPath,
      [`chrome-extension://${extensionId}/`],
      helloRequest,
      environment
    );
    if (helloResult.code !== 0) {
      throw new Error(
        `Chrome extension host hello exited ${helloResult.code}: ${helloResult.stderr.slice(0, 1000)}`
      );
    }
    const ensureRequest = nativeMessageFrame({
      jsonrpc: "2.0",
      id: "smoke-ensure",
      method: "codexRuntime/ensure",
      params: { clientId: "artifact-smoke", constraints }
    });
    const ensureResult = await runNativeMessage(
      temporaryHostPath,
      [`chrome-extension://${extensionId}/`],
      ensureRequest,
      environment
    );
    if (ensureResult.code !== 0) {
      throw new Error(
        `Chrome extension host ensure exited ${ensureResult.code}: ${ensureResult.stderr.slice(0, 1000)}`
      );
    }
    return {
      hello: evaluateLinuxChromeExtensionHostHello(
        parseNativeMessageFrame(helloResult.stdout)
      ),
      runtime: evaluateLinuxChromeExtensionHostEnsure(
        parseNativeMessageFrame(ensureResult.stdout),
        { channelName, codexCliPath, codexHome, nodePath }
      )
    };
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

function managedRegistry({
  channelName,
  codexCliPath,
  codexHome,
  hostPath,
  nodePath,
  pluginRoot,
  resourcesDir
}) {
  return {
    schemaVersion: 2,
    entries: [{
      schemaVersion: 2,
      appServerProtocolVersion: 2,
      appVersion: "artifact-smoke",
      channel: channelName,
      cliVersion: "artifact-smoke",
      entryId: smokeEntryId,
      extensionBuildChannels: [channelName],
      extensionIds: [extensionId],
      installId: "linux-managed-smoke-install",
      nativeHostNames: [nativeHostName],
      nativeHostProtocolVersion: 2,
      nativeHostVersion: "artifact-smoke",
      paths: {
        browserClientPath: path.join(pluginRoot, "scripts", "browser-client.mjs"),
        codexCliPath,
        codexHome,
        extensionHostPath: hostPath,
        nodePath,
        nodeModuleDirs: [],
        nodeReplPath: path.join(resourcesDir, "node_repl"),
        resourcesPath: resourcesDir
      },
      presence: {
        lastSeenAt: new Date().toISOString(),
        pid: process.pid,
        startedAt: new Date().toISOString()
      },
      proxyHost: "127.0.0.1",
      proxyPort: 0,
      updatedAt: new Date().toISOString()
    }]
  };
}

async function writeRegistry(registryPath, registry) {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function nativeMessageFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function parseNativeMessageFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 4) {
    throw new Error("Chrome extension host returned a truncated native frame header");
  }
  const bodyLength = frame.readUInt32LE(0);
  if (frame.length !== bodyLength + 4) {
    throw new Error(
      `Chrome extension host returned a truncated or trailing native frame: expected ${bodyLength + 4} bytes, got ${frame.length}`
    );
  }
  try {
    return JSON.parse(frame.subarray(4).toString("utf8"));
  } catch (error) {
    throw new Error("Chrome extension host returned invalid JSON", { cause: error });
  }
}

export function evaluateLinuxChromeExtensionHostHello(message) {
  if (message?.jsonrpc !== "2.0" || message?.id !== "smoke-hello") {
    throw new Error("Chrome extension host returned an unexpected hello response ID");
  }
  if (message.error) {
    throw new Error(`Chrome extension host hello failed: ${JSON.stringify(message.error)}`);
  }
  const result = message.result;
  if (
    result?.manifestSchemaVersion !== 2 ||
    result?.nativeHostProtocolVersion !== 2 ||
    !Array.isArray(result?.supportedProtocolVersions) ||
    !result.supportedProtocolVersions.includes(2) ||
    !Array.isArray(result?.supportedMethods) ||
    !result.supportedMethods.includes("codexRuntime/openLocalFile") ||
    typeof result?.nativeHostVersion !== "string" ||
    result.nativeHostVersion.length === 0
  ) {
    throw new Error(
      `Chrome extension host returned an incompatible hello: ${JSON.stringify(result)}`
    );
  }
  return {
    protocolVersion: result.nativeHostProtocolVersion,
    version: result.nativeHostVersion
  };
}

export function evaluateLinuxChromeExtensionHostEnsure(message, {
  channelName,
  codexCliPath,
  codexHome,
  nodePath
}) {
  if (message?.jsonrpc !== "2.0" || message?.id !== "smoke-ensure") {
    throw new Error("Chrome extension host returned an unexpected ensure response ID");
  }
  if (message.error) {
    throw new Error(`Chrome extension host ensure failed: ${JSON.stringify(message.error)}`);
  }
  const result = message.result;
  let runtimeUrl;
  try {
    runtimeUrl = new URL(result?.localAppServerUrl);
  } catch {
    throw new Error("Chrome extension host returned an invalid app-server URL");
  }
  if (
    result?.entryId !== smokeEntryId ||
    typeof result?.runtimeSessionId !== "string" ||
    result.runtimeSessionId.length === 0 ||
    runtimeUrl.protocol !== "ws:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(runtimeUrl.hostname) ||
    !runtimeUrl.searchParams.has("token") ||
    result?.selected?.appServerProtocolVersion !== 2 ||
    result?.selected?.nativeHostProtocolVersion !== 2 ||
    result?.selected?.channel !== channelName ||
    result?.runtimeConfig?.platform !== "linux" ||
    result?.runtimeConfig?.codexCliPath !== codexCliPath ||
    result?.runtimeConfig?.codexHome !== codexHome ||
    result?.runtimeConfig?.nodePath !== nodePath
  ) {
    throw new Error(
      `Chrome extension host returned an incompatible managed runtime: ${JSON.stringify(result)}`
    );
  }
  return {
    channel: result.selected.channel,
    entryId: result.entryId,
    protocolVersion: result.selected.nativeHostProtocolVersion
  };
}

function runFileType(hostPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("file", ["-b", hostPath], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`file exited ${code}: ${stderr}`));
    });
  });
}

function runNativeMessage(command, args, input, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = finish(reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${command} native hello timed out after 5000ms`));
    }, 5000);

    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        fail(new Error(`${command} native hello exceeded 2MiB`));
        return;
      }
      stdout.push(chunk);
      const output = Buffer.concat(stdout);
      if (output.length >= 4 && output.length >= output.readUInt32LE(0) + 4) {
        child.stdin.end();
      }
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", fail);
    child.stdin.on("error", error => {
      if (error?.code !== "EPIPE") fail(error);
    });
    child.on(
      "exit",
      finish(code => {
        resolve({ code, stdout: Buffer.concat(stdout), stderr });
      })
    );
    child.stdin.write(input);
  });
}
