import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import {
  ensurePersistentToken,
  SessionStore,
  createAuthController,
  defaultTokenFilePath
} from "./auth.mjs";
import {
  buildPatchedIndexHtml,
  readAllowedLocalAssetFile,
  ensureCodexAppExists,
  ensureExtractedAssets,
  readExtractedBuildMetadata,
  readBuildMetadata,
  readStaticFile,
  resolveCodexAppPaths
} from "./assets.mjs";
import { AppServerManager } from "./app-server.mjs";
import { UdsIpcClient } from "./ipc-uds.mjs";
import { MessageRouter } from "./message-router.mjs";
import { createLogger, safeJsonParse, toErrorMessage } from "./util.mjs";
import {
  findLatestCachedBinaryPath,
  isExecutable,
  resolveBinaryPath,
  resolveBundlePathsFromBinary,
  resolveCodexCliPath,
  tryReadInstalledPackage
} from "../lib/linux-desktop.mjs";

const logger = createLogger("web-server");

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

export function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const config = {
    port: Number(env.CODEX_APP_LINUX_WEB_PORT || 8080),
    bind: env.CODEX_APP_LINUX_WEB_BIND || "127.0.0.1",
    tokenFile: env.CODEX_APP_LINUX_WEB_TOKEN_FILE || defaultTokenFilePath(),
    codexAppPath: env.CODEX_APP_LINUX_WEB_APP_PATH || "",
    internalWsPort: Number(env.CODEX_APP_LINUX_WEB_INTERNAL_WS_PORT || 38080),
    autoOpen: env.CODEX_APP_LINUX_WEB_OPEN === "1",
    dangerouslyDisableAuth: parseBooleanFlag(env.CODEX_APP_LINUX_WEB_DANGEROUSLY_DISABLE_AUTH, false)
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        config.port = Number(argv[++i]);
        break;
      case "--bind":
        config.bind = argv[++i];
        break;
      case "--token-file":
        config.tokenFile = argv[++i];
        break;
      case "--codex-app":
        config.codexAppPath = argv[++i];
        break;
      case "--dangerously-disable-auth":
        config.dangerouslyDisableAuth = parseBooleanFlag(argv[++i], true);
        break;
      case "--open":
        config.autoOpen = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        break;
    }
  }

  return config;
}

function printUsage() {
  process.stdout.write(`Usage: codex-app-linux web [--port <n>] [--bind <ip>] [--open] [--token-file <path>] [--codex-app <path>] [--dangerously-disable-auth <true|false>]\n`);
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendNotFound(res) {
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("Not found");
}

function maybeOpenBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const exists = spawnSync("which", [opener], {
    stdio: "ignore"
  });

  if (exists.status !== 0) {
    return false;
  }

  const child = spawn(opener, [url], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true
  });
  child.unref();
  return true;
}

async function main() {
  const config = parseConfig();
  const tokenResult = config.dangerouslyDisableAuth
    ? {
        token: null,
        tokenFilePath: null
      }
    : await ensurePersistentToken(config.tokenFile);
  const runtimeMetadataPath = `${path.resolve(config.tokenFile)}.runtime`;
  const sessionStore = new SessionStore({ ttlMs: 1000 * 60 * 60 * 12 });
  const auth = createAuthController({
    token: tokenResult.token,
    sessionStore,
    disabled: config.dangerouslyDisableAuth
  });
  const packageData = config.codexAppPath ? null : await tryReadInstalledPackage();

  let codexPaths;

  if (config.codexAppPath) {
    codexPaths = resolveCodexAppPaths(config.codexAppPath);
  } else if (packageData) {
    codexPaths = resolveBundlePathsFromBinary(
      await resolveBinaryPath({
        packageJson: packageData.packageJson
      })
    );
  } else if (isExecutable(process.env.CODEX_APP_LINUX_BINARY_PATH)) {
    codexPaths = resolveBundlePathsFromBinary(process.env.CODEX_APP_LINUX_BINARY_PATH);
  } else {
    const cachedBinaryPath = await findLatestCachedBinaryPath();

    if (!cachedBinaryPath) {
      throw new Error(
        "No packaged Codex Linux bundle found. Run `npx codex-app-linux` once to populate the cache, set CODEX_APP_LINUX_BINARY_PATH, or pass `--codex-app /path/to/linux-unpacked`."
      );
    }

    logger.warn("Using latest cached Linux bundle for repo-local web mode", {
      binaryPath: cachedBinaryPath
    });
    codexPaths = resolveBundlePathsFromBinary(cachedBinaryPath);
  }

  await ensureCodexAppExists(codexPaths);
  const initialBuild = await readBuildMetadata(codexPaths, {
    shortVersion: packageData?.packageJson?.version,
    bundleVersion: packageData?.metadata?.releaseTag,
    buildNumber: packageData?.metadata?.releaseTag,
    buildFlavor: packageData?.metadata?.executableName?.includes("beta") ? "public-beta" : "prod",
    buildKey: packageData
      ? `${packageData.metadata.executableName}-${packageData.packageJson.version}`
      : undefined
  });

  const udsClient = new UdsIpcClient({ logger: createLogger("uds") });
  try {
    await udsClient.start();
  } catch (error) {
    logger.warn("UDS client start failed; continuing with app-server fallback", {
      error: toErrorMessage(error)
    });
  }

  const assetBundle = await ensureExtractedAssets({
    asarPath: codexPaths.asarPath,
    buildKey: initialBuild.buildKey,
    logger
  });
  const build = await readExtractedBuildMetadata(assetBundle.outputDir, initialBuild);
  const patchedIndexHtml = await buildPatchedIndexHtml(assetBundle.indexPath);

  const codexCliPath = resolveCodexCliPath({
    preferredPath: codexPaths.codexCliPath
  });

  if (!codexCliPath) {
    throw new Error("Unable to locate Codex CLI. Set CODEX_CLI_PATH or install `codex` on PATH.");
  }

  const appServer = new AppServerManager({
    internalPort: config.internalWsPort,
    codexCliPath,
    logger: createLogger("app-server")
  });

  try {
    await appServer.start();
  } catch (error) {
    logger.warn("App-server startup failed; UI may be degraded", {
      error: toErrorMessage(error)
    });
  }

  const router = new MessageRouter({
    appServer,
    udsClient,
    hostConfig: {
      id: "local",
      display_name: "Codex",
      kind: "local"
    },
    extensionInfo: {
      name: "codex-webstrapper",
      version: build.shortVersion,
      platform: process.platform,
      uiKind: "desktop"
    },
    workerPath: assetBundle.workerPath,
    logger: createLogger("router")
  });

  const thisFilePath = fileURLToPath(import.meta.url);
  const shimPath = path.resolve(path.join(path.dirname(thisFilePath), "bridge-shim.js"));
  const shimBody = await fs.readFile(shimPath);
  const appHostBody = createAppHostModuleBody(assetBundle.rpcModulePath, assetBundle.webRoot);

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `${config.bind}:${config.port}`;
      const url = new URL(req.url || "/", `http://${host}`);

      if (url.pathname === "/__webstrapper/healthz") {
        sendJson(res, 200, {
          ok: true,
          appServer: appServer.getState(),
          udsReady: udsClient.isReady(),
          build: build.buildKey,
          authDisabled: config.dangerouslyDisableAuth
        });
        return;
      }

      if (url.pathname === "/favicon.ico") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (url.pathname === "/__webstrapper/auth") {
        auth.handleAuthRoute(req, res, url);
        return;
      }

      if (!auth.requireAuth(req, res, url)) {
        return;
      }

      if (url.pathname === "/__webstrapper/shim.js") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/javascript; charset=utf-8");
        res.end(
          `window.__codexWebstrapBuildInfo=${JSON.stringify({
            appVersion: build.shortVersion,
            buildNumber: build.buildNumber,
            buildFlavor: build.buildFlavor
          })};\n${shimBody}`
        );
        return;
      }

      if (url.pathname === "/__webstrapper/app-host.js") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/javascript; charset=utf-8");
        res.end(appHostBody);
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(patchedIndexHtml);
        return;
      }

      const staticFile = await readStaticFile(assetBundle.webRoot, url.pathname);
      const localAssetFile = staticFile
        ? null
        : await readAllowedLocalAssetFile(url.pathname);
      const responseFile = staticFile || localAssetFile;

      if (!responseFile) {
        sendNotFound(res);
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", responseFile.contentType);
      res.end(responseFile.body);
    } catch (error) {
      logger.error("HTTP handler failed", { error: toErrorMessage(error) });
      sendJson(res, 500, { error: "internal_server_error" });
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", ws => {
    router.registerClient(ws);

    ws.on("message", async raw => {
      const parsed = safeJsonParse(raw.toString("utf8"));
      if (!parsed) {
        router.sendBridgeError(ws, "invalid_json", "Failed to parse bridge JSON payload.");
        return;
      }

      await router.handleEnvelope(ws, parsed);
    });

    ws.on("close", () => {
      router.unregisterClient(ws);
    });

    ws.on("error", () => {
      router.unregisterClient(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const host = req.headers.host || `${config.bind}:${config.port}`;
    const url = new URL(req.url || "/", `http://${host}`);

    if (url.pathname !== "/__webstrapper/bridge") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!auth.isAuthorizedRequest(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, resolve);
  });

  try {
    await fs.writeFile(
      runtimeMetadataPath,
      JSON.stringify({
        bind: config.bind,
        port: config.port,
        tokenFile: tokenResult.tokenFilePath,
        authDisabled: config.dangerouslyDisableAuth,
        pid: process.pid,
        startedAt: Date.now()
      }) + "\n",
      { mode: 0o600 }
    );
  } catch (error) {
    logger.warn("Failed to write runtime metadata file", {
      path: runtimeMetadataPath,
      error: toErrorMessage(error)
    });
  }

  const publicUrl = `http://${config.bind}:${config.port}/`;
  const authUrl = config.dangerouslyDisableAuth
    ? publicUrl
    : `http://${config.bind}:${config.port}/__webstrapper/auth?token=${encodeURIComponent(tokenResult.token)}`;
  const authHint = config.dangerouslyDisableAuth
    ? "DISABLED"
    : `http://${config.bind}:${config.port}/__webstrapper/auth?token=<redacted>`;
  const loginCommand = config.dangerouslyDisableAuth
    ? "none"
    : `xdg-open "${authUrl}"`;

  logger.info("codex-app-linux web started", {
    bind: config.bind,
    port: config.port,
    buildKey: build.buildKey,
    authDisabled: config.dangerouslyDisableAuth,
    tokenFilePath: tokenResult.tokenFilePath,
    authHint
  });

  process.stdout.write(`\nCodex App Linux Web listening on ${publicUrl}\n`);
  if (config.dangerouslyDisableAuth) {
    process.stdout.write(`Authentication: DISABLED via --dangerously-disable-auth\n`);
  } else {
    process.stdout.write(`Token file: ${tokenResult.tokenFilePath}\n`);
    process.stdout.write(`Auth URL pattern: ${authHint}\n`);
    process.stdout.write(`Local login command: ${loginCommand}\n`);
  }
  process.stdout.write(`\n`);

  if (config.autoOpen && !maybeOpenBrowser(authUrl)) {
    process.stdout.write(`${authUrl}\n`);
  }

  const pruneInterval = setInterval(() => {
    sessionStore.pruneExpired();
  }, 60_000);
  pruneInterval.unref();

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info("Shutting down", { signal });
    clearInterval(pruneInterval);

    wss.clients.forEach(client => {
      try {
        client.close();
      } catch {
        // ignore
      }
    });

    router.dispose();
    appServer.stop();
    udsClient.stop();

    await new Promise(resolve => {
      server.close(() => resolve());
    });

    try {
      await fs.unlink(runtimeMetadataPath);
    } catch {
      // ignore
    }

    process.exit(0);
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

const isDirectRun = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch(error => {
    logger.error("Fatal startup error", { error: toErrorMessage(error) });
    process.exit(1);
  });
}

export function createAppHostModuleBody(rpcModulePath, webRoot) {
  if (!rpcModulePath) {
    return "console.warn('codex-webstrap app host RPC module not found');\n";
  }

  const rpcModuleUrl = `/${path.relative(webRoot, rpcModulePath).split(path.sep).join("/")}`;

  return `
// Importing the upstream bundle can patch Function.prototype.toString. Keep the
// browser's native method so semantic export discovery remains deterministic.
const functionToString = Function.prototype.toString;
const rpcModulePromise = import(${JSON.stringify(rpcModuleUrl)});

function resolveCreateRpcPeer(rpcModule) {
  return [rpcModule.tC, rpcModule.V, rpcModule.E, ...Object.values(rpcModule)].find((value) => {
  if (typeof value !== "function") {
    return false;
  }

  return functionToString.call(value).includes("getRemoteMain");
  });
}

async function connectAppHostPort(port) {
  const rpcModule = await rpcModulePromise;
  const createRpcPeer = resolveCreateRpcPeer(rpcModule);

  if (typeof createRpcPeer !== "function") {
    throw new Error("codex-webstrap app host RPC peer constructor not found");
  }

  createRpcPeer(port, appHostMain);
}

const appUpdateSubscribers = new Set();
const appUpdateState = {
  appUpdateLifecycleState: "idle"
};

const appHostMain = {
  services: {
    appUpdates: {
      installUpdate() {},
      stateChanged(callback) {
        appUpdateSubscribers.add(callback);
        try {
          callback(appUpdateState);
        } catch {}
        return () => {
          appUpdateSubscribers.delete(callback);
        };
      }
    }
  }
};

window.addEventListener("message", event => {
  if (event.source !== window || event.data?.type !== "connect-app-host") {
    return;
  }

  const port = event.ports?.[0];
  if (!port) {
    return;
  }

  connectAppHostPort(port).catch(error => {
    setTimeout(() => {
      throw error;
    });
  });
});
`;
}
