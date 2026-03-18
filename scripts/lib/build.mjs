import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

import {
  assetBaseName,
  channelPaths,
  defaultLauncherCommand,
  defaultPackageName,
  defaultReleaseRepo,
  npmVersionFor,
  projectRoot,
  releaseTagForVersion
} from "./config.mjs";
import { writeAurPackage } from "./aur.mjs";

export async function buildChannel({
  channel,
  upstream,
  packageName = defaultPackageName,
  launcherCommand = defaultLauncherCommand,
  releaseRepo = defaultReleaseRepo,
  archiveOverride
}) {
  const paths = channelPaths(channel.name);
  const archivePath =
    archiveOverride || (await fetchArchive(upstream.archiveUrl, paths.cacheDir));

  await ensureEmptyDir(paths.stageDir);
  await ensureEmptyDir(paths.outputDir);
  await ensureEmptyDir(paths.npmDir);
  await ensureDir(paths.stageArchiveDir);

  await extractArchive(archivePath, paths.stageArchiveDir);

  const appBundlePath = await findAppBundle(paths.stageArchiveDir);
  const appResourcesDir = path.join(appBundlePath, "Contents", "Resources");
  const appAsarPath = path.join(appResourcesDir, "app.asar");

  await run([
    "npx",
    "--no-install",
    "asar",
    "extract",
    appAsarPath,
    paths.stageAppDir
  ]);

  const effectiveUpstream = await normalizeStagePackage(
    paths.stageAppDir,
    upstream,
    archiveOverride || null
  );
  const packageVersion = npmVersionFor(channel.name, effectiveUpstream);
  const releaseTag = releaseTagForVersion(packageVersion);
  const assetPrefix = assetBaseName(packageName, packageVersion);
  const linuxIconPath = await createLinuxIcon(paths.stageDir, paths.stageAppDir);

  await hydrateNativeModules(paths.stageDir, paths.stageAppDir);
  await buildLinuxArtifacts({
    stageAppDir: paths.stageAppDir,
    outputDir: paths.outputDir,
    executableName: channel.executableName,
    productName: channel.displayName,
    desktopName: channel.displayName,
    appId: channel.appId,
    linuxIconPath
  });

  const linuxDir = path.join(paths.outputDir, "linux-unpacked");
  const appImagePath = await renameAppImage(paths.outputDir, `${assetPrefix}.AppImage`);
  const unpackedTarballPath = path.join(
    paths.outputDir,
    `${assetPrefix}-linux-unpacked.tar.gz`
  );
  const iconAssetPath = path.join(paths.outputDir, `${assetPrefix}.png`);

  await packDirectory(linuxDir, unpackedTarballPath);
  await fs.copyFile(linuxIconPath, iconAssetPath);

  const appImageSha256 = await sha256File(appImagePath);
  const unpackedTarballSha256 = await sha256File(unpackedTarballPath);
  const iconSha256 = await sha256File(iconAssetPath);
  const checksumsPath = path.join(paths.outputDir, `${assetPrefix}.sha256`);

  await fs.writeFile(
    checksumsPath,
    [
      `${appImageSha256}  ${path.basename(appImagePath)}`,
      `${unpackedTarballSha256}  ${path.basename(unpackedTarballPath)}`,
      `${iconSha256}  ${path.basename(iconAssetPath)}`
    ].join("\n") + "\n"
  );

  const aurDir = path.join(paths.outputDir, "aur");
  const aurPackage = await writeAurPackage({
    channel,
    packageVersion,
    releaseRepo,
    releaseTag,
    executableName: channel.executableName,
    tarballAssetName: path.basename(unpackedTarballPath),
    tarballSha256: unpackedTarballSha256,
    iconAssetName: path.basename(iconAssetPath),
    iconSha256,
    targetDir: aurDir
  });

  const packageDir = await assembleNpmPackage({
    channel,
    upstream: effectiveUpstream,
    packageName,
    packageVersion,
    launcherCommand,
    releaseRepo,
    releaseTag,
    executableName: channel.executableName,
    unpackedTarballAssetName: path.basename(unpackedTarballPath),
    unpackedTarballSha256,
    targetDir: paths.npmDir
  });

  return {
    archivePath,
    npmVersion: packageVersion,
    packageDir,
    linuxDir,
    appImagePath,
    unpackedTarballPath,
    iconAssetPath,
    checksumsPath,
    aurDir,
    aurPackage,
    releaseRepo,
    releaseTag
  };
}

export async function npmVersionExists(packageName, version) {
  try {
    const output = await run(
      ["npm", "view", `${packageName}@${version}`, "version", "--json"],
      { capture: true }
    );

    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export async function publishPackage(packageDir, distTag) {
  await run(["npm", "publish", packageDir, "--access", "public", "--tag", distTag]);
}

async function fetchArchive(url, cacheDir) {
  await ensureDir(cacheDir);

  const fileName = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
  const archivePath = path.join(cacheDir, fileName);
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await pipeline(response.body, createWriteStream(archivePath));

  return archivePath;
}

async function extractArchive(archivePath, targetDir) {
  if (archivePath.endsWith(".zip")) {
    await run(["bsdtar", "-xf", archivePath, "-C", targetDir]);
    return;
  }

  await run(["7z", "x", "-y", archivePath, `-o${targetDir}`]);
}

async function findAppBundle(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      return fullPath;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const nested = await findAppBundle(fullPath).catch(() => null);

    if (nested) {
      return nested;
    }
  }

  throw new Error(`No .app bundle found under ${rootDir}`);
}

async function normalizeStagePackage(stageAppDir, upstream, archiveOverride) {
  const packageJsonPath = path.join(stageAppDir, "package.json");
  const original = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const normalized = {
    name: original.name,
    productName: original.productName,
    author: original.author,
    version: original.version,
    description: original.description,
    main: original.main,
    dependencies: {
      "better-sqlite3": original.dependencies["better-sqlite3"],
      "node-pty": original.dependencies["node-pty"],
      bindings: "^1.5.0",
      "file-uri-to-path": "^1.0.0",
      "node-addon-api": "^8.5.0",
      "prebuild-install": "^7.1.3",
      tslib: original.dependencies.tslib || "^2.8.1"
    },
    codexBuildFlavor: original.codexBuildFlavor,
    codexBuildNumber: original.codexBuildNumber,
    codexSparkleFeedUrl: original.codexSparkleFeedUrl
  };

  await fs.writeFile(packageJsonPath, `${JSON.stringify(normalized, null, 2)}\n`);

  return {
    ...upstream,
    archiveUrl: archiveOverride || upstream.archiveUrl,
    version: original.version,
    buildNumber: original.codexBuildNumber
  };
}

async function createLinuxIcon(stageDir, stageAppDir) {
  const iconDir = path.join(stageDir, "build-resources");
  const iconPath = path.join(iconDir, "icon.png");
  const webviewAssetsDir = path.join(stageAppDir, "webview", "assets");
  const assets = await fs.readdir(webviewAssetsDir);
  const appIcon = assets
    .filter(name => /^app-.*\.png$/i.test(name))
    .sort()
    .at(0);

  if (!appIcon) {
    throw new Error(`Unable to locate app icon under ${webviewAssetsDir}`);
  }

  await ensureDir(iconDir);
  await fs.copyFile(path.join(webviewAssetsDir, appIcon), iconPath);

  return iconPath;
}

async function hydrateNativeModules(stageDir, stageAppDir) {
  const nativeWorkspaceDir = path.join(stageDir, "native-workspace");
  const stagePackageJson = JSON.parse(
    await fs.readFile(path.join(stageAppDir, "package.json"), "utf8")
  );

  await ensureEmptyDir(nativeWorkspaceDir);
  await fs.writeFile(
    path.join(nativeWorkspaceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "codex-app-linux-native-workspace",
        private: true,
        dependencies: {
          "better-sqlite3": stagePackageJson.dependencies["better-sqlite3"],
          "node-pty": stagePackageJson.dependencies["node-pty"],
          bindings: "^1.5.0",
          "file-uri-to-path": "^1.0.0",
          "node-addon-api": "^8.5.0",
          "prebuild-install": "^7.1.3",
          tslib: "^2.8.1"
        }
      },
      null,
      2
    )}\n`
  );

  await run(["npm", "install", "--no-package-lock"], { cwd: nativeWorkspaceDir });
  await run(
    [
      "npx",
      "--no-install",
      "electron-rebuild",
      "--version",
      "40.0.0",
      "--arch",
      "x64",
      "--module-dir",
      nativeWorkspaceDir,
      "--force",
      "--only",
      "better-sqlite3,node-pty"
    ],
    { cwd: nativeWorkspaceDir }
  );

  for (const dependency of [
    "better-sqlite3",
    "node-pty",
    "bindings",
    "file-uri-to-path",
    "node-addon-api",
    "prebuild-install",
    "tslib"
  ]) {
    const source = path.join(nativeWorkspaceDir, "node_modules", dependency);
    const target = path.join(stageAppDir, "node_modules", dependency);

    await fs.rm(target, { recursive: true, force: true });
    await copyRecursive(source, target);
  }
}

async function buildLinuxArtifacts({
  stageAppDir,
  outputDir,
  executableName,
  productName,
  desktopName,
  appId,
  linuxIconPath
}) {
  await run(
    [
      "npx",
      "--no-install",
      "electron-builder",
      "--config",
      "electron-builder.config.mjs",
      "--publish",
      "never",
      "--linux",
      "dir",
      "AppImage"
    ],
    {
      env: {
        ...process.env,
        CODEX_STAGE_APP_DIR: stageAppDir,
        CODEX_OUTPUT_DIR: outputDir,
        CODEX_APP_EXECUTABLE_NAME: executableName,
        CODEX_PRODUCT_NAME: productName,
        CODEX_DESKTOP_NAME: desktopName,
        CODEX_APP_ID: appId,
        CODEX_LINUX_ICON_PATH: linuxIconPath
      }
    }
  );
}

async function renameAppImage(outputDir, targetName) {
  const entries = await fs.readdir(outputDir);
  const current = entries.find(name => name.endsWith(".AppImage"));

  if (!current) {
    throw new Error(`No AppImage produced in ${outputDir}`);
  }

  const source = path.join(outputDir, current);
  const target = path.join(outputDir, targetName);

  if (source !== target) {
    await fs.rm(target, { force: true });
    await fs.rename(source, target);
  }

  return target;
}

async function packDirectory(sourceDir, archivePath) {
  await run(["tar", "-C", path.dirname(sourceDir), "-czf", archivePath, path.basename(sourceDir)]);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const file = await fs.readFile(filePath);

  hash.update(file);

  return hash.digest("hex");
}

async function assembleNpmPackage({
  channel,
  upstream,
  packageName,
  packageVersion,
  launcherCommand,
  releaseRepo,
  releaseTag,
  executableName,
  unpackedTarballAssetName,
  unpackedTarballSha256,
  targetDir
}) {
  const packageDir = path.join(targetDir, "package");
  const binDir = path.join(packageDir, "bin");

  await ensureEmptyDir(packageDir);
  await ensureDir(binDir);

  const packageJson = {
    name: packageName,
    version: packageVersion,
    private: false,
    description: `${channel.displayName} launcher for the Codex Linux desktop app. Requires an existing codex CLI on PATH.`,
    license: "UNLICENSED",
    os: ["linux"],
    cpu: ["x64"],
    bin: {
      [launcherCommand]: "bin/codex-app-linux.cjs"
    },
    files: ["bin", "README.md", "package.json"],
    repository: {
      type: "git",
      url: `git+https://github.com/${releaseRepo}.git`
    },
    codexAppLinux: {
      channel: channel.name,
      releaseRepo,
      releaseTag,
      executableName,
      unpackedTarballAssetName,
      unpackedTarballSha256
    },
    publishConfig: {
      access: "public",
      tag: channel.distTag
    }
  };

  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );
  await fs.writeFile(
    path.join(binDir, "codex-app-linux.cjs"),
    launcherScript(launcherCommand),
    { mode: 0o755 }
  );
  await fs.writeFile(
    path.join(packageDir, "README.md"),
    launcherReadme({
      packageName,
      launcherCommand,
      channelName: channel.name,
      upstream,
      releaseRepo,
      releaseTag,
      executableName,
      unpackedTarballAssetName
    })
  );

  return packageDir;
}

function launcherScript(launcherCommand) {
  return `#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");

const packageJson = require("../package.json");
const metadata = packageJson.codexAppLinux;

main().catch(error => {
  console.error("codex-app-linux:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const resolvedCodex = resolveCodexCliPath();

  if (!resolvedCodex) {
    console.error("codex-app-linux: CODEX_CLI_PATH is not set and 'which codex' returned nothing.");
    console.error("Set CODEX_CLI_PATH explicitly or install 'codex' on PATH.");
    process.exit(1);
  }

  const binaryPath = await resolveBinaryPath();
  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_CLI_PATH: resolvedCodex
    }
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

function resolveCodexCliPath() {
  if (isExecutable(process.env.CODEX_CLI_PATH)) {
    return process.env.CODEX_CLI_PATH;
  }

  const result = spawnSync("which", ["codex"], {
    encoding: "utf8"
  });
  const candidate = result.status === 0 ? result.stdout.trim() : "";

  if (isExecutable(candidate)) {
    return candidate;
  }

  return null;
}

async function resolveBinaryPath() {
  const overridePath = process.env.CODEX_APP_LINUX_BINARY_PATH;

  if (isExecutable(overridePath)) {
    return overridePath;
  }

  const cacheRoot =
    process.env.CODEX_APP_LINUX_CACHE_DIR ||
    process.env.XDG_CACHE_HOME ||
    path.join(os.homedir(), ".cache");
  const cacheDir = path.join(cacheRoot, packageJson.name, packageJson.version);
  const archivePath = path.join(cacheDir, metadata.unpackedTarballAssetName);
  const extractRoot = path.join(cacheDir, "linux-unpacked");
  const binaryPath = path.join(extractRoot, metadata.executableName);

  await fsp.mkdir(cacheDir, { recursive: true });

  if (
    isExecutable(binaryPath) &&
    (await matchesChecksum(archivePath, metadata.unpackedTarballSha256))
  ) {
    return binaryPath;
  }

  const downloadUrl = process.env.CODEX_APP_LINUX_RELEASE_BASE_URL
    ? joinUrl(process.env.CODEX_APP_LINUX_RELEASE_BASE_URL, metadata.unpackedTarballAssetName)
    : \`https://github.com/\${metadata.releaseRepo}/releases/download/\${metadata.releaseTag}/\${metadata.unpackedTarballAssetName}\`;

  console.error(\`codex-app-linux: downloading \${metadata.unpackedTarballAssetName}\`);

  const tempPath = \`\${archivePath}.download\`;
  const response = await fetch(downloadUrl);

  if (!response.ok || !response.body) {
    throw new Error(\`failed to download desktop binary archive: \${response.status} \${response.statusText}\`);
  }

  await pipeline(response.body, fs.createWriteStream(tempPath));

  if (!(await matchesChecksum(tempPath, metadata.unpackedTarballSha256))) {
    await fsp.rm(tempPath, { force: true });
    throw new Error("downloaded desktop binary archive checksum mismatch");
  }

  await fsp.rename(tempPath, archivePath);
  await fsp.rm(extractRoot, { recursive: true, force: true });
  await extractTarball(archivePath, cacheDir);

  if (!isExecutable(binaryPath)) {
    throw new Error(\`downloaded archive did not contain executable \${metadata.executableName}\`);
  }

  return binaryPath;
}

async function matchesChecksum(filePath, expected) {
  if (!expected) {
    return isExecutable(filePath);
  }

  try {
    const hash = crypto.createHash("sha256");
    const file = await fsp.readFile(filePath);
    hash.update(file);
    return hash.digest("hex") === expected;
  } catch {
    return false;
  }
}

function isExecutable(candidate) {
  if (!candidate) {
    return false;
  }

  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function joinUrl(base, assetName) {
  return \`\${String(base).replace(/\\/$/, "")}/\${assetName}\`;
}

async function extractTarball(archivePath, targetDir) {
  await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", targetDir], {
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(\`tar extraction failed: \${code}\`));
    });
  });
}
`;
}

function launcherReadme({
  packageName,
  launcherCommand,
  channelName,
  upstream,
  releaseRepo,
  releaseTag,
  executableName,
  unpackedTarballAssetName
}) {
  return `# ${packageName}

Thin launcher for the Codex Linux desktop app.

- Channel: \`${channelName}\`
- Upstream desktop version: \`${upstream.version}\`
- Upstream build number: \`${upstream.buildNumber}\`
- GitHub release: \`${releaseTag}\`
- Linux archive asset: \`${unpackedTarballAssetName}\`
- Executable: \`${executableName}\`
- Release repo: \`${releaseRepo}\`

## Behavior

1. uses existing \`CODEX_CLI_PATH\` if set
2. otherwise resolves \`which codex\`
3. downloads the Linux unpacked binary archive from GitHub Releases into cache on first run
4. extracts \`linux-unpacked\`
5. launches the packaged executable with \`CODEX_CLI_PATH\` exported

## Usage

\`\`\`bash
${launcherCommand}
\`\`\`
`;
}

async function copyRecursive(source, target) {
  await fs.cp(source, target, { recursive: true });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureEmptyDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function run(command, options = {}) {
  const { capture = false, env, cwd = projectRoot } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      const detail = capture ? `\n${stderr}` : "";
      reject(new Error(`Command failed (${command.join(" ")}): ${code}${detail}`));
    });
  });
}
