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
  const binaryPath = path.join(appDir, "codex-app-linux-beta-bin");
  const symlinkPath = path.join(binDir, "codex-app-linux-beta");
  const markerPath = path.join(root, "ran-from-bin");

  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    launcherPath,
    afterPack.wrapperScript("codex-app-linux-beta-bin"),
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
