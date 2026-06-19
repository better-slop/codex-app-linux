import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import afterPack from "../scripts/electron-builder-after-pack.cjs";
import {
  ensureCodexCompatibilitySymlink,
  patchCodexPlusPlusInstallerSource
} from "../runtime/lib/plusplus.mjs";

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

test("launcher wrapper prefers bundled Codex CLI over PATH Codex", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-wrapper-codex-"));
  const appDir = path.join(root, "opt", "codex-app-linux-beta");
  const resourcesDir = path.join(appDir, "resources");
  const binDir = path.join(root, "usr", "bin");
  const fakePathDir = path.join(root, "fake-path");
  const launcherPath = path.join(appDir, "codex-app-linux-beta");
  const binaryPath = path.join(appDir, "codex-app-linux-beta-real");
  const symlinkPath = path.join(binDir, "codex-app-linux-beta");
  const bundledCodexPath = path.join(resourcesDir, "codex");
  const stalePathCodex = path.join(fakePathDir, "codex");
  const markerPath = path.join(root, "resolved-codex");

  await fs.mkdir(resourcesDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(fakePathDir, { recursive: true });
  await fs.writeFile(
    launcherPath,
    afterPack.wrapperScript("codex-app-linux-beta-real"),
    { mode: 0o755 }
  );
  await fs.writeFile(
    binaryPath,
    `#!/bin/sh
set -eu
printf '%s\n' "$CODEX_CLI_PATH" > ${JSON.stringify(markerPath)}
`,
    { mode: 0o755 }
  );
  await fs.writeFile(bundledCodexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(stalePathCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.symlink(launcherPath, symlinkPath);

  await new Promise((resolve, reject) => {
    const child = spawn(symlinkPath, [], {
      env: {
        ...process.env,
        PATH: `${fakePathDir}:${process.env.PATH || ""}`,
        CODEX_CLI_PATH: ""
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
  assert.equal(marker.trim(), bundledCodexPath);
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
    child.on("close", code => {
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
    child.on("close", code => {
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
    child.on("close", code => {
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
    child.on("close", code => {
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

test("plusplus installer patch exposes current Codex window services shape", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-plusplus-patch-"));
  const sourceRoot = path.join(root, "source");
  const commandsDir = path.join(sourceRoot, "packages", "installer", "dist", "commands");
  const appDir = path.join(root, "app");
  const mainPath = path.join(appDir, "main.js");
  const installerPath = path.join(commandsDir, "install.js");

  await fs.mkdir(commandsDir, { recursive: true });
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "package.json"), "{\"type\":\"module\"}\n");
  await fs.writeFile(
    installerPath,
    `import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function patchCodexWindowServices(appDir, originalMain) {
  const marker = "__codexpp_window_services__";
  const candidates = findCodexMainCandidates(appDir, originalMain);

  for (const mainPath of candidates) {
    const source = readFileSync(mainPath, "utf8");
    if (source.includes(marker)) return;
    throw new Error("Codex window services hook point not found");
  }
}

function findCodexMainCandidates(appDir, originalMain) {
  return [resolve(appDir, originalMain)];
}
`
  );
  await fs.writeFile(
    mainPath,
    "let P=Cw({buildFlavor:a,allowDevtools:p});Ab({buildFlavor:a,getContextForWebContents:P.getContextForWebContents});P.setHostBindings({getContext:L.getWindowContextForHost});let R=Jb({buildFlavor:a,windowServices:P,ensureHostWindow:P.ensureHostWindow});\n"
  );

  assert.equal(await patchCodexPlusPlusInstallerSource(sourceRoot), true);

  const installer = await import(`${installerPath}?cacheBust=${Date.now()}`);
  installer.patchCodexWindowServices(appDir, "main.js");

  assert.match(
    await fs.readFile(mainPath, "utf8"),
    /\}\);globalThis\.__codexpp_window_services__=P;Ab/
  );
});
