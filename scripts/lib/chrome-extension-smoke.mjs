import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { projectRoot } from "./config.mjs";

const extensionId = "hehggadaopoacecdllhhajmbjkdcmajg";

/** Verify the packaged ELF and execute a real protocol-v2 hello exchange. */
export async function assertLinuxChromeExtensionHost(resourcesDir, channelName) {
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
  const hello = await smokeLinuxChromeExtensionHostHello({
    channelName,
    hostPath,
    pluginRoot,
    resourcesDir
  });

  return {
    path: path.relative(resourcesDir, hostPath),
    ...artifact,
    hello
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

async function smokeLinuxChromeExtensionHostHello({
  channelName,
  hostPath,
  pluginRoot,
  resourcesDir
}) {
  const temporaryDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-chrome-host-smoke-")
  );
  const temporaryHostPath = path.join(temporaryDir, "extension-host");
  try {
    await fs.copyFile(hostPath, temporaryHostPath);
    await fs.chmod(temporaryHostPath, 0o755);
    await fs.writeFile(
      path.join(temporaryDir, "extension-host-config.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          browserClientPath: path.join(pluginRoot, "scripts", "browser-client.mjs"),
          channel: channelName,
          codexCliPath: path.join(resourcesDir, "codex"),
          extensionId,
          nodePath: path.join(resourcesDir, "node"),
          nodeReplPath: path.join(resourcesDir, "node_repl"),
          proxyHost: "127.0.0.1",
          proxyPort: 0
        },
        null,
        2
      )}\n`
    );

    const request = nativeMessageFrame({
      jsonrpc: "2.0",
      id: "smoke-hello",
      method: "codexRuntime/hello",
      params: {
        constraints: {
          extensionBuildChannel: channelName,
          extensionId,
          extensionVersion: "smoke",
          nativeHostName: "com.openai.codexextension",
          requiredAppServerProtocolVersion: 2,
          requiredNativeHostProtocolVersion: 2
        }
      }
    });
    const result = await runNativeMessage(
      temporaryHostPath,
      [`chrome-extension://${extensionId}/`],
      request
    );
    if (result.code !== 0) {
      throw new Error(
        `Chrome extension host hello exited ${result.code}: ${result.stderr.slice(0, 1000)}`
      );
    }
    return evaluateLinuxChromeExtensionHostHello(
      parseNativeMessageFrame(result.stdout)
    );
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
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

function runNativeMessage(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
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
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", fail);
    child.on(
      "exit",
      finish(code => {
        resolve({ code, stdout: Buffer.concat(stdout), stderr });
      })
    );
    child.stdin.end(input);
  });
}
