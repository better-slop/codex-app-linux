import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";

import {
  channelPaths,
  defaultAppCommand,
  defaultPackageName,
  npmVersionFor,
  projectRoot
} from "./config.mjs";

export async function buildChannel({
  channel,
  upstream,
  packageName = defaultPackageName,
  appCommand = defaultAppCommand,
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

  await hydrateNativeModules(paths.stageDir, paths.stageAppDir);
  await buildLinuxDirectory(paths.stageAppDir, paths.outputDir, appCommand);

  const linuxDir = path.join(paths.outputDir, "linux-unpacked");
  const npmVersion = npmVersionFor(channel.name, effectiveUpstream);
  const packageDir = await assembleNpmPackage({
    channel,
    upstream: effectiveUpstream,
    packageName,
    packageVersion: npmVersion,
    appCommand,
    linuxDir,
    targetDir: paths.npmDir
  });

  return {
    archivePath,
    linuxDir,
    npmVersion,
    packageDir
  };
}

export async function npmVersionExists(packageName, version) {
  const command = [
    "npm",
    "view",
    `${packageName}@${version}`,
    "version",
    "--json"
  ];

  try {
    const output = await run(command, { capture: true });

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

async function hydrateNativeModules(stageDir, stageAppDir) {
  const nativeWorkspaceDir = path.join(stageDir, "native-workspace");
  const stagePackageJson = JSON.parse(
    await fs.readFile(path.join(stageAppDir, "package.json"), "utf8")
  );
  const betterSqliteVersion = stagePackageJson.dependencies["better-sqlite3"];
  const nodePtyVersion = stagePackageJson.dependencies["node-pty"];

  await ensureEmptyDir(nativeWorkspaceDir);
  await fs.writeFile(
    path.join(nativeWorkspaceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "codex-app-linux-native-workspace",
        private: true,
        dependencies: {
          "better-sqlite3": betterSqliteVersion,
          "node-pty": nodePtyVersion,
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

  await run(["npm", "install", "--no-package-lock"], {
    cwd: nativeWorkspaceDir
  });

  await run([
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
  ]);

  for (const dependency of [
    "better-sqlite3",
    "node-pty",
    "bindings",
    "file-uri-to-path",
    "node-addon-api",
    "tslib"
  ]) {
    const source = path.join(nativeWorkspaceDir, "node_modules", dependency);
    const target = path.join(stageAppDir, "node_modules", dependency);

    await fs.rm(target, { recursive: true, force: true });
    await copyRecursive(source, target);
  }
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

async function buildLinuxDirectory(stageAppDir, outputDir, appCommand) {
  await run(
    [
      "npx",
      "--no-install",
      "electron-builder",
      "--config",
      "electron-builder.config.mjs",
      "--linux",
      "dir"
    ],
    {
    env: {
      ...process.env,
      CODEX_STAGE_APP_DIR: stageAppDir,
      CODEX_OUTPUT_DIR: outputDir,
      CODEX_APP_EXECUTABLE_NAME: appCommand
    }
    }
  );
}

async function assembleNpmPackage({
  channel,
  upstream,
  packageName,
  packageVersion,
  appCommand,
  linuxDir,
  targetDir
}) {
  const packageDir = path.join(targetDir, "package");
  const appDir = path.join(packageDir, "app");
  const binDir = path.join(packageDir, "bin");

  await ensureEmptyDir(packageDir);
  await copyRecursive(linuxDir, appDir);
  await ensureDir(binDir);

  const packageJson = {
    name: packageName,
    version: packageVersion,
    private: false,
    description: `${channel.displayName} desktop app for Linux. Requires an existing codex CLI on PATH.`,
    license: "UNLICENSED",
    os: ["linux"],
    cpu: ["x64"],
    bin: {
      [appCommand]: "bin/codex-desktop.cjs"
    },
    files: ["app", "bin", "README.md"],
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
    path.join(binDir, "codex-desktop.cjs"),
    wrapperScript(appCommand),
    { mode: 0o755 }
  );

  await fs.writeFile(
    path.join(packageDir, "README.md"),
    packageReadme({
      packageName,
      appCommand,
      channelName: channel.name,
      upstream
    })
  );

  return packageDir;
}

function wrapperScript(appCommand) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const appExecutable = path.join(__dirname, "..", "app", "${appCommand}");
const resolvedCodex = resolveCodexCliPath();

if (!resolvedCodex) {
  console.error("codex-app-linux: CODEX_CLI_PATH is not set and 'which codex' returned nothing.");
  console.error("Set CODEX_CLI_PATH explicitly or install 'codex' on PATH.");
  process.exit(1);
}

const child = spawn(appExecutable, process.argv.slice(2), {
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
`;
}

function packageReadme({ packageName, appCommand, channelName, upstream }) {
  return `# ${packageName}

Linux repack of the upstream Codex desktop app.

- Channel: \`${channelName}\`
- Upstream desktop version: \`${upstream.version}\`
- Upstream build number: \`${upstream.buildNumber}\`
- Upstream archive: \`${upstream.archiveUrl}\`

## Usage

This package does not install the Codex CLI for you.

Expected setup:

1. \`codex\` already installed on your machine.
2. \`codex\` available on \`PATH\`.

Then run:

\`\`\`bash
${appCommand}
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
