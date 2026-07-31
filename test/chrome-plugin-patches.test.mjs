import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  patchLinuxChromePluginResources,
  patchLinuxNativeHostManifestCheckSource
} from "../scripts/lib/chrome-plugin-patches.mjs";
import { CHROME_EXTENSION_HOST_CONTENT_VARIANT } from "../scripts/lib/chrome-extension-constants.mjs";

const nativeHostManifestSource = `
function getNativeHostManifestLocation() {
  if (process.platform === "darwin") return { manifestPath: "mac", registryKey: null };
  if (process.platform === "win32") return { manifestPath: "win", registryKey: "key" };
  throw new Error(
    \`Unsupported platform for native host manifest check: \${process.platform}. This script supports macOS and Windows.\`,
  );
}
`;

const upstreamLinuxNativeHostManifestSource = `
function getNativeHostManifestLocation(expectedBrowser) {
  if (process.platform === "linux") {
    return {
      manifestPath: resolveLinuxNativeMessagingManifestPath({
        browser: expectedBrowser,
        env: process.env,
        homedir: os.homedir(),
        hostName: expectedHostName,
        path,
      }),
      registryKey: null,
      registryManifestPath: null,
      registryKeyExists: null,
    };
  }
  throw new Error(\`Unsupported platform: \${process.platform}\`);
}
`;

test("native host diagnostics resolve Chrome's Linux manifest", () => {
  const patched = patchLinuxNativeHostManifestCheckSource(nativeHostManifestSource);

  assert.match(patched, /process\.platform === "linux"/);
  assert.match(patched, /"\.config",\s*"google-chrome",\s*"NativeMessagingHosts"/);
  assert.match(patched, /supports macOS, Linux, and Windows/);
  assert.equal(patchLinuxNativeHostManifestCheckSource(patched), patched);
});

test("native host diagnostics fail closed when the upstream contract drifts", () => {
  assert.throws(
    () => patchLinuxNativeHostManifestCheckSource("function unrelated() {}"),
    /Linux native-host manifest diagnostics contract changed/
  );
});

test("native host diagnostics preserve upstream Linux manifest resolution", () => {
  assert.equal(
    patchLinuxNativeHostManifestCheckSource(upstreamLinuxNativeHostManifestSource),
    upstreamLinuxNativeHostManifestSource
  );
});

test("resource patching preserves the trusted browser client bytes", async t => {
  const resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-chrome-plugin-"));
  t.after(() => fs.rm(resourcesDir, { recursive: true, force: true }));

  const scriptsDir = path.join(
    resourcesDir,
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome",
    "scripts"
  );
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.writeFile(
    path.join(scriptsDir, "check-native-host-manifest.js"),
    nativeHostManifestSource
  );
  const browserClientSource =
    'var Xd=dH(pH(),fH()==="win32"?"AppData\\\\Local\\\\Google\\\\Chrome\\\\User Data":"Library/Application Support/Google/Chrome");';
  const browserClientPath = path.join(scriptsDir, "browser-client.mjs");
  await fs.writeFile(browserClientPath, browserClientSource);
  const pluginManifestPath = path.join(
    resourcesDir,
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome",
    ".codex-plugin",
    "plugin.json"
  );
  await fs.mkdir(path.dirname(pluginManifestPath), { recursive: true });
  await fs.writeFile(
    pluginManifestPath,
    `${JSON.stringify({ name: "chrome", version: "26.727.40816" }, null, 2)}\n`
  );

  await patchLinuxChromePluginResources(resourcesDir);
  const patchedPluginManifestSource = await fs.readFile(pluginManifestPath, "utf8");
  await patchLinuxChromePluginResources(resourcesDir);

  assert.equal(await fs.readFile(browserClientPath, "utf8"), browserClientSource);
  assert.equal(await fs.readFile(pluginManifestPath, "utf8"), patchedPluginManifestSource);
  assert.deepEqual(JSON.parse(patchedPluginManifestSource), {
    name: "chrome",
    version: "26.727.40816",
    bundledContentVariant: CHROME_EXTENSION_HOST_CONTENT_VARIANT
  });
});
