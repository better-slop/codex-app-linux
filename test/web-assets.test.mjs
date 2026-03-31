import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readBuildMetadata, resolveCodexAppPaths } from "../runtime/webstrap/assets.mjs";

test("resolveCodexAppPaths supports linux-unpacked layout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-web-assets-"));
  const appRoot = path.join(root, "linux-unpacked");
  const resourcesPath = path.join(appRoot, "resources");

  await fs.mkdir(resourcesPath, { recursive: true });
  await fs.writeFile(path.join(resourcesPath, "app.asar"), "");
  await fs.writeFile(path.join(resourcesPath, "codex"), "", { mode: 0o755 });

  const resolved = resolveCodexAppPaths(appRoot);

  assert.equal(resolved.appPath, appRoot);
  assert.equal(resolved.resourcesPath, resourcesPath);
  assert.equal(resolved.asarPath, path.join(resourcesPath, "app.asar"));
  assert.equal(resolved.codexCliPath, path.join(resourcesPath, "codex"));
});

test("readBuildMetadata supports linux package metadata without Info.plist", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-linux-web-build-"));
  const appRoot = path.join(root, "linux-unpacked");
  const resourcesPath = path.join(appRoot, "resources");

  await fs.mkdir(resourcesPath, { recursive: true });
  await fs.writeFile(path.join(resourcesPath, "app.asar"), "");
  await fs.writeFile(
    path.join(resourcesPath, "app-package.json"),
    JSON.stringify({
      version: "26.313.41514",
      codexBuildNumber: "41514",
      codexBuildFlavor: "public-beta"
    })
  );

  const metadata = await readBuildMetadata({
    appPath: appRoot,
    resourcesPath,
    asarPath: path.join(resourcesPath, "app.asar"),
    packageMetadataPath: path.join(resourcesPath, "app-package.json")
  });

  assert.equal(metadata.shortVersion, "26.313.41514");
  assert.equal(metadata.bundleVersion, "41514");
  assert.equal(metadata.buildNumber, "41514");
  assert.equal(metadata.buildFlavor, "public-beta");
  assert.match(metadata.buildKey, /26\.313\.41514/);
});
