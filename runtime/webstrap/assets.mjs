import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { safePathJoin, toErrorMessage } from "./util.mjs";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".mjs.map": "application/json; charset=utf-8",
  ".js.map": "application/json; charset=utf-8"
};

const LOCAL_ASSET_EXTENSIONS = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".ico"
]);

const STATSIG_BLOCKING_INIT_SNIPPET =
  "[a,o]=(0,t.useState)(i.loadingStatus!==`Ready`)";
const STATSIG_NON_BLOCKING_INIT_SNIPPET =
  "[a,o]=(0,t.useState)(!1)";

export function defaultCacheRoot() {
  return path.join(os.homedir(), ".cache", "codex-app-linux", "web-assets");
}

export function resolveCodexAppPaths(explicitCodexAppPath) {
  const resolved = path.resolve(explicitCodexAppPath);

  if (path.basename(resolved) === "app.asar") {
    const resourcesPath = path.dirname(resolved);
    return buildPathSet(path.dirname(resourcesPath), resourcesPath, resolved);
  }

  if (path.basename(resolved) === "resources") {
    return buildPathSet(path.dirname(resolved), resolved, path.join(resolved, "app.asar"));
  }

  if (looksLikeAppBinary(resolved)) {
    const appPath = path.dirname(resolved);
    const resourcesPath = path.join(appPath, "resources");
    return buildPathSet(appPath, resourcesPath, path.join(resourcesPath, "app.asar"));
  }

  const appPath = resolved;
  const resourcesPath = path.join(appPath, "resources");
  return buildPathSet(appPath, resourcesPath, path.join(resourcesPath, "app.asar"));
}

function buildPathSet(appPath, resourcesPath, asarPath) {
  return {
    appPath,
    resourcesPath,
    asarPath,
    packageMetadataPath: path.join(resourcesPath, "app-package.json"),
    codexCliPath: path.join(resourcesPath, "codex")
  };
}

function looksLikeAppBinary(candidatePath) {
  const base = path.basename(candidatePath);
  return base.startsWith("codex-app-linux");
}

export async function ensureCodexAppExists(paths) {
  const checks = [paths.appPath, paths.resourcesPath, paths.asarPath];
  for (const filePath of checks) {
    await fsp.access(filePath, fs.constants.R_OK);
  }
}

export async function readBuildMetadata(paths, fallback = {}) {
  let shortVersion = fallback.shortVersion || "unknown";
  let bundleVersion = fallback.bundleVersion || "unknown";
  let buildNumber = fallback.buildNumber || bundleVersion;
  let buildFlavor = fallback.buildFlavor || "prod";

  if (paths.packageMetadataPath) {
    try {
      const packageJson = JSON.parse(await fsp.readFile(paths.packageMetadataPath, "utf8"));
      shortVersion = packageJson.version || shortVersion;
      buildNumber = String(packageJson.codexBuildNumber || packageJson.buildNumber || buildNumber);
      bundleVersion = buildNumber || bundleVersion;
      buildFlavor = packageJson.codexBuildFlavor || packageJson.buildFlavor || buildFlavor;
    } catch {
      // optional
    }
  }

  const buildKeySource = fallback.buildKey || `${shortVersion}-${bundleVersion}`;
  const buildKey = buildKeySource.replace(/[^a-zA-Z0-9._-]/g, "_");

  return { bundleVersion, shortVersion, buildNumber, buildFlavor, buildKey };
}

export async function readExtractedBuildMetadata(outputDir, fallback = {}) {
  let shortVersion = fallback.shortVersion || "unknown";
  let buildNumber = fallback.buildNumber || "unknown";
  let buildFlavor = fallback.buildFlavor || "prod";

  try {
    const packageJson = JSON.parse(
      await fsp.readFile(path.join(outputDir, "package.json"), "utf8")
    );
    shortVersion = packageJson.version || shortVersion;
    buildNumber = String(packageJson.codexBuildNumber || packageJson.buildNumber || buildNumber);
    buildFlavor = packageJson.codexBuildFlavor || packageJson.buildFlavor || buildFlavor;
  } catch {
    // optional
  }

  const bundleVersion = fallback.bundleVersion || buildNumber;
  const buildKeySource = fallback.buildKey || `${shortVersion}-${buildNumber}`;
  const buildKey = buildKeySource.replace(/[^a-zA-Z0-9._-]/g, "_");

  return { shortVersion, buildNumber, buildFlavor, bundleVersion, buildKey };
}

async function runAsarCliExtract(asarPath, outputPath) {
  await new Promise((resolve, reject) => {
    const child = spawn("npx", ["-y", "@electron/asar", "extract", asarPath, outputPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`asar extract failed with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function extractAsarAll(asarPath, outputPath) {
  try {
    const module = await import("@electron/asar");
    const extractAll = module.extractAll || module.default?.extractAll;
    if (typeof extractAll === "function") {
      extractAll(asarPath, outputPath);
      return;
    }
    throw new Error("@electron/asar extractAll API unavailable");
  } catch {
    await runAsarCliExtract(asarPath, outputPath);
  }
}

export async function ensureExtractedAssets({
  asarPath,
  cacheRoot = defaultCacheRoot(),
  buildKey,
  logger
}) {
  const root = path.resolve(cacheRoot);
  const outputDir = path.join(root, buildKey);
  const doneFile = path.join(outputDir, ".extract-complete.json");

  await fsp.mkdir(root, { recursive: true, mode: 0o700 });

  const alreadyExtracted = await fsp
    .access(doneFile, fs.constants.R_OK)
    .then(() => true)
    .catch(() => false);

  if (!alreadyExtracted) {
    const tempDir = `${outputDir}.tmp-${Date.now()}`;
    await fsp.rm(tempDir, { recursive: true, force: true });
    await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 });

    logger.info("Extracting Codex assets", { outputDir });
    await extractAsarAll(asarPath, tempDir);

    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rename(tempDir, outputDir);

    await fsp.writeFile(
      doneFile,
      JSON.stringify(
        {
          extractedAt: new Date().toISOString(),
          asarPath,
          buildKey
        },
        null,
        2
      )
    );
  }

  const webRoot = path.join(outputDir, "webview");
  const workerPath = path.join(outputDir, ".vite", "build", "worker.js");
  const indexPath = path.join(webRoot, "index.html");

  await fsp.access(webRoot, fs.constants.R_OK);
  await fsp.access(indexPath, fs.constants.R_OK);

  return {
    outputDir,
    webRoot,
    indexPath,
    workerPath
  };
}

export async function buildPatchedIndexHtml(indexPath) {
  let html = await fsp.readFile(indexPath, "utf8");
  const shimTag = '<script src="/__webstrapper/shim.js"></script>';

  if (html.includes(shimTag)) {
    return html;
  }

  const viewportMeta =
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">';
  const existingViewport = html.match(/<meta\s+name=["']viewport["'][^>]*>/i);
  if (existingViewport) {
    html = html.replace(existingViewport[0], viewportMeta);
  } else if (html.includes("</head>")) {
    html = html.replace("</head>", `  ${viewportMeta}\n</head>`);
  }

  if (html.includes("</head>")) {
    return html.replace("</head>", `  ${shimTag}\n</head>`);
  }

  return `${shimTag}\n${html}`;
}

export function patchStatsigChunkSource(source) {
  if (typeof source !== "string") {
    return source;
  }

  if (!source.includes(STATSIG_BLOCKING_INIT_SNIPPET)) {
    return source;
  }

  return source.replace(STATSIG_BLOCKING_INIT_SNIPPET, STATSIG_NON_BLOCKING_INIT_SNIPPET);
}

export async function readStaticFile(webRoot, requestPath) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = safePathJoin(webRoot, normalized);
  if (!filePath) {
    return null;
  }

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return null;
  }

  const ext = path.extname(filePath);
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

  try {
    let body = await fsp.readFile(filePath);

    if (path.basename(filePath).startsWith("statsig-") && filePath.endsWith(".js")) {
      body = Buffer.from(patchStatsigChunkSource(body.toString("utf8")));
    }

    return { body, contentType };
  } catch (error) {
    throw new Error(`Failed reading asset ${filePath}: ${toErrorMessage(error)}`);
  }
}

export function defaultAllowedLocalAssetRoots(homeDir = os.homedir()) {
  return [path.join(homeDir, ".codex", ".tmp", "plugins")];
}

export async function readAllowedLocalAssetFile(
  requestPath,
  allowedRoots = defaultAllowedLocalAssetRoots()
) {
  if (typeof requestPath !== "string" || !path.isAbsolute(requestPath)) {
    return null;
  }

  let decodedPath = requestPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    // Keep raw path if it is not valid percent-encoding.
  }

  if (!decodedPath.includes("/assets/")) {
    return null;
  }

  const ext = path.extname(decodedPath).toLowerCase();
  if (!LOCAL_ASSET_EXTENSIONS.has(ext)) {
    return null;
  }

  const filePath = allowedRoots
    .map((root) => safePathJoin(root, path.relative(root, decodedPath)))
    .find(Boolean);

  if (!filePath) {
    return null;
  }

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return null;
  }

  try {
    const body = await fsp.readFile(filePath);
    return {
      body,
      contentType: CONTENT_TYPES[ext] || "application/octet-stream"
    };
  } catch (error) {
    throw new Error(`Failed reading local asset ${filePath}: ${toErrorMessage(error)}`);
  }
}
