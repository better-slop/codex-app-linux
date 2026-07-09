import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CHROME_EXTENSION_HOST_CONTENT_VARIANT,
  stageLinuxChromeExtensionHost
} from "../scripts/lib/chrome-extension-host.mjs";

test("stageLinuxChromeExtensionHost installs the project host over an empty upstream directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-linux-chrome-host-"));
  const resourcesDir = path.join(root, "resources");
  const pluginDir = path.join(
    resourcesDir,
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome"
  );
  const sourcePath = path.join(root, "extension-host");

  await fs.mkdir(path.join(pluginDir, "extension-host"), { recursive: true });
  await fs.copyFile("/bin/true", sourcePath);

  const installedPath = await stageLinuxChromeExtensionHost(resourcesDir, {
    sourcePath
  });

  assert.equal(
    installedPath,
    path.join(pluginDir, "extension-host", "linux", "x64", "extension-host")
  );
  assert.deepEqual(await fs.readFile(installedPath), await fs.readFile(sourcePath));
  assert.equal((await fs.stat(installedPath)).mode & 0o777, 0o755);
  assert.match(
    await fs.readFile(
      path.join(pluginDir, "extension-host", "linux", "LICENSE.ilysenko-MIT.txt"),
      "utf8"
    ),
    /MIT License/
  );
});

test("stageLinuxChromeExtensionHost replaces an untrusted upstream Linux host", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-linux-chrome-host-"));
  const resourcesDir = path.join(root, "resources");
  const targetPath = path.join(
    resourcesDir,
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome",
    "extension-host",
    "linux",
    "x64",
    "extension-host"
  );
  const sourcePath = path.join(root, "extension-host");

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, "unknown-upstream-binary");
  await fs.copyFile("/bin/true", sourcePath);

  await stageLinuxChromeExtensionHost(resourcesDir, { sourcePath });

  assert.deepEqual(await fs.readFile(targetPath), await fs.readFile(sourcePath));
});

test("stageLinuxChromeExtensionHost fails closed when the Chrome plugin layout drifts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-linux-chrome-host-"));
  const resourcesDir = path.join(root, "resources");
  const sourcePath = path.join(root, "extension-host");

  await fs.mkdir(resourcesDir, { recursive: true });
  await fs.copyFile("/bin/true", sourcePath);

  await assert.rejects(
    stageLinuxChromeExtensionHost(resourcesDir, { sourcePath }),
    /Chrome plugin root is missing/
  );
});

test("Linux host cache revision is explicit and stable", () => {
  assert.equal(CHROME_EXTENSION_HOST_CONTENT_VARIANT, "linux-extension-host-v2");
});
