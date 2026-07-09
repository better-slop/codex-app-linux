import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  patchLinuxChromePluginResources,
  patchLinuxNativeHostManifestCheckSource
} from "../scripts/lib/chrome-plugin-patches.mjs";

const nativeHostManifestSource = `
function getNativeHostManifestLocation() {
  if (process.platform === "darwin") return { manifestPath: "mac", registryKey: null };
  if (process.platform === "win32") return { manifestPath: "win", registryKey: "key" };
  throw new Error(
    \`Unsupported platform for native host manifest check: \${process.platform}. This script supports macOS and Windows.\`,
  );
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

  await patchLinuxChromePluginResources(resourcesDir);

  assert.equal(await fs.readFile(browserClientPath, "utf8"), browserClientSource);
});
