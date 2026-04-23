import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import afterPack from "../scripts/electron-builder-after-pack.cjs";

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
