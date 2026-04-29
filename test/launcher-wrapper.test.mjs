import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import afterPack from "../scripts/electron-builder-after-pack.cjs";
import { ensureCodexCompatibilitySymlink } from "../runtime/lib/plusplus.mjs";

test("launcher wrapper resolves symlinked entrypoint to sibling binary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-wrapper-"));
  const appDir = path.join(root, "opt", "codex-app-linux-beta");
  const binDir = path.join(root, "usr", "bin");
  const launcherPath = path.join(appDir, "codex-app-linux-beta");
  const binaryPath = path.join(appDir, "codex-app-linux-beta-real");
  const symlinkPath = path.join(binDir, "codex-app-linux-beta");
  const markerPath = path.join(root, "ran-from-bin");

  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    launcherPath,
    afterPack.wrapperScript("codex-app-linux-beta-real"),
    { mode: 0o755 }
  );
  await fs.writeFile(
    binaryPath,
    `#!/bin/sh
set -eu
printf '%s\n' "$0" > ${JSON.stringify(markerPath)}
`,
    { mode: 0o755 }
  );
  await fs.symlink(launcherPath, symlinkPath);

  await new Promise((resolve, reject) => {
    const child = spawn(symlinkPath, [], {
      env: {
        ...process.env,
        CODEX_CLI_PATH: "/bin/true"
      },
      stdio: "ignore"
    });

    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`wrapper exited with ${code}`));
    });
  });

  const marker = await fs.readFile(markerPath, "utf8");
  assert.equal(marker.trim(), binaryPath);
});

test("afterPack extra resource copy preserves Linux app.asar.unpacked", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-after-pack-"));
  const appOutDir = path.join(root, "linux-unpacked");
  const resourcesDir = path.join(appOutDir, "resources");
  const extraResourcesDir = path.join(root, "extra-resources");

  await fs.mkdir(path.join(resourcesDir, "app.asar.unpacked"), { recursive: true });
  await fs.mkdir(path.join(extraResourcesDir, "app.asar.unpacked"), { recursive: true });
  await fs.mkdir(path.join(extraResourcesDir, "plugins", "openai-bundled"), { recursive: true });
  await fs.writeFile(path.join(resourcesDir, "app.asar.unpacked", "native.txt"), "linux-native");
  await fs.writeFile(path.join(extraResourcesDir, "app.asar.unpacked", "native.txt"), "darwin-native");
  await fs.writeFile(path.join(extraResourcesDir, "plugins", "openai-bundled", "marketplace.json"), "{}\n");

  const previous = process.env.CODEX_STAGE_RESOURCES_DIR;
  process.env.CODEX_STAGE_RESOURCES_DIR = extraResourcesDir;
  try {
    await afterPack.copyExtraResources(appOutDir);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_STAGE_RESOURCES_DIR;
    } else {
      process.env.CODEX_STAGE_RESOURCES_DIR = previous;
    }
  }

  assert.equal(
    await fs.readFile(path.join(resourcesDir, "app.asar.unpacked", "native.txt"), "utf8"),
    "linux-native"
  );
  assert.equal(
    await fs.readFile(path.join(resourcesDir, "plugins", "openai-bundled", "marketplace.json"), "utf8"),
    "{}\n"
  );
});

test("afterPack creates codex compatibility symlink to electron binary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-after-pack-symlink-"));
  const appOutDir = path.join(root, "linux-unpacked");
  const executableName = "codex-app-linux-beta";

  await fs.mkdir(appOutDir, { recursive: true });
  await fs.writeFile(path.join(appOutDir, executableName), "#!/bin/sh\n", { mode: 0o755 });

  await afterPack({
    electronPlatformName: "linux",
    appOutDir,
    packager: {
      executableName,
      appInfo: {
        productFilename: executableName
      }
    }
  });

  assert.equal(
    await fs.readlink(path.join(appOutDir, "codex")),
    `${executableName}-bin`
  );
});

test("launcher reports package version without starting Electron", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-version-"));
  const packageRoot = path.join(root, "package");
  const runtimeDir = path.join(packageRoot, "runtime");
  const runtimeLibDir = path.join(runtimeDir, "lib");
  const packageJsonPath = path.join(packageRoot, "package.json");

  await fs.mkdir(runtimeLibDir, { recursive: true });
  await fs.copyFile(
    path.join(process.cwd(), "runtime", "launcher.mjs"),
    path.join(runtimeDir, "launcher.mjs")
  );
  await fs.copyFile(
    path.join(process.cwd(), "runtime", "lib", "linux-desktop.mjs"),
    path.join(runtimeLibDir, "linux-desktop.mjs")
  );
  await fs.copyFile(
    path.join(process.cwd(), "runtime", "lib", "plusplus.mjs"),
    path.join(runtimeLibDir, "plusplus.mjs")
  );
  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify(
      {
        name: "codex-app-linux",
        version: "1.2.3-launcher.12",
        type: "module",
        codexAppLinux: {
          executableName: "codex-app-linux"
        }
      },
      null,
      2
    )}\n`
  );

  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(runtimeDir, "launcher.mjs"), "--version"], {
      env: {
        ...process.env,
        CODEX_APP_LINUX_PACKAGE_ROOT: packageRoot
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
        return;
      }

      reject(
        new Error(
          `launcher exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`
        )
      );
    });
  });

  assert.equal(output.stderr, "");
  assert.equal(output.stdout.trim(), "1.2.3-launcher.12");
});

test("plusplus compatibility symlink points to sibling Electron binary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-plusplus-link-"));
  const binaryPath = path.join(root, "codex-app-linux-beta");
  const electronBinaryPath = path.join(root, "codex-app-linux-beta-bin");

  await fs.writeFile(binaryPath, "#!/bin/sh\n", { mode: 0o755 });
  await fs.writeFile(electronBinaryPath, "#!/bin/sh\n", { mode: 0o755 });

  await ensureCodexCompatibilitySymlink(root, binaryPath);

  assert.equal(await fs.readlink(path.join(root, "codex")), "codex-app-linux-beta-bin");
});

test("launcher help advertises plusplus command", async () => {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "runtime", "launcher.mjs"), "--help"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
        return;
      }

      reject(
        new Error(
          `launcher exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`
        )
      );
    });
  });

  assert.equal(output.stderr, "");
  assert.match(output.stdout, /codex-app-linux --plusplus <install\|status\|repair\|uninstall\|doctor>/);
});

test("launcher plusplus help does not resolve desktop package", async () => {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "runtime", "launcher.mjs"), "--plusplus", "--help"], {
      env: {
        ...process.env,
        CODEX_APP_LINUX_PACKAGE_ROOT: path.join(os.tmpdir(), "missing-codex-app-linux-package")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
        return;
      }

      reject(
        new Error(
          `launcher exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`
        )
      );
    });
  });

  assert.equal(output.stderr, "");
  assert.match(output.stdout, /codex-app-linux --plusplus install/);
});

test("launcher plusplus install forwards app root to codexplusplus", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-plusplus-run-"));
  const packageRoot = path.join(root, "package");
  const runtimeDir = path.join(packageRoot, "runtime");
  const runtimeLibDir = path.join(runtimeDir, "lib");
  const cacheRoot = path.join(root, "cache");
  const packageCacheDir = path.join(cacheRoot, "codex-app-linux", "1.2.3-launcher.23");
  const appDir = path.join(packageCacheDir, "linux-unpacked");
  const binDir = path.join(root, "bin");
  const argsPath = path.join(root, "plusplus-args.json");
  const packageJsonPath = path.join(packageRoot, "package.json");

  await fs.mkdir(runtimeLibDir, { recursive: true });
  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.copyFile(
    path.join(process.cwd(), "runtime", "launcher.mjs"),
    path.join(runtimeDir, "launcher.mjs")
  );
  await fs.copyFile(
    path.join(process.cwd(), "runtime", "lib", "linux-desktop.mjs"),
    path.join(runtimeLibDir, "linux-desktop.mjs")
  );
  await fs.copyFile(
    path.join(process.cwd(), "runtime", "lib", "plusplus.mjs"),
    path.join(runtimeLibDir, "plusplus.mjs")
  );
  await fs.writeFile(path.join(appDir, "codex-app-linux"), "#!/bin/sh\n", { mode: 0o755 });
  await fs.writeFile(path.join(appDir, "codex-app-linux-bin"), "#!/bin/sh\n", { mode: 0o755 });
  await fs.writeFile(path.join(packageCacheDir, "archive.tar.gz"), "#!/bin/sh\n", { mode: 0o755 });
  await fs.writeFile(
    path.join(binDir, "codexplusplus"),
    `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
`,
    { mode: 0o755 }
  );
  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify(
      {
        name: "codex-app-linux",
        version: "1.2.3-launcher.23",
        type: "module",
        codexAppLinux: {
          executableName: "codex-app-linux",
          unpackedTarballAssetName: "archive.tar.gz"
        }
      },
      null,
      2
    )}\n`
  );

  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(runtimeDir, "launcher.mjs"), "--plusplus", "install", "--no-default-tweaks"],
      {
        env: {
          ...process.env,
          CODEX_APP_LINUX_PACKAGE_ROOT: packageRoot,
          CODEX_APP_LINUX_CACHE_DIR: cacheRoot,
          PATH: `${binDir}:${process.env.PATH || ""}`
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
        return;
      }

      reject(
        new Error(
          `launcher exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`
        )
      );
    });
  });

  assert.equal(output.stderr, "");
  assert.equal(output.stdout, "");
  assert.deepEqual(
    JSON.parse(await fs.readFile(argsPath, "utf8")),
    ["install", "--no-default-tweaks", "--app", appDir]
  );
  assert.equal(await fs.readlink(path.join(appDir, "codex")), "codex-app-linux-bin");
});
