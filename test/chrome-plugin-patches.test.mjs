import test from "node:test";
import assert from "node:assert/strict";

import {
  patchLinuxBrowserClientProfileSource,
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

test("browser client reads Linux Chrome profile metadata from ~/.config", () => {
  const source =
    'var Xd=dH(pH(),fH()==="win32"?"AppData\\\\Local\\\\Google\\\\Chrome\\\\User Data":"Library/Application Support/Google/Chrome");';
  const patched = patchLinuxBrowserClientProfileSource(source);

  assert.match(
    patched,
    /fH\(\)==="linux"\?"\.config\/google-chrome":"Library\/Application Support\/Google\/Chrome"/
  );
  assert.equal(patchLinuxBrowserClientProfileSource(patched), patched);
});

test("browser profile patch fails closed when the upstream contract drifts", () => {
  assert.throws(
    () => patchLinuxBrowserClientProfileSource("var profileRoot = null;"),
    /Linux Chrome profile metadata contract changed/
  );
});
