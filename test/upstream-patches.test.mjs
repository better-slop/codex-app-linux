import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  hasLinuxWindowFocusableContractSource,
  hasUnguardedLinuxWindowFocusableSource,
  hasUnguardedOwlFeatureBindingSource,
  patchDisableTransparencySource,
  patchLinuxOwlFeatureBindingSource,
  patchLinuxChromeExtensionDetectionSource,
  patchLinuxWindowFocusableSource,
  upstreamPatchContracts
} from "../scripts/lib/upstream-patches.mjs";

test("patchLinuxChromeExtensionDetectionSource finds stable Chrome profiles", () => {
  const source =
    "function o({homeDir:e,localAppDataDir:t,platform:n}){return n===`darwin`?p.join(e,`Library`,`Application Support`,`Google`,`Chrome`):n===`win32`?p.join(t??p.join(e,`AppData`,`Local`),`Google`,`Chrome`,`User Data`):null};globalThis.resolveChromeRoot=o";
  const patched = patchLinuxChromeExtensionDetectionSource(source);
  const context = {
    globalThis: {},
    p: { join: (...parts) => parts.join("/") }
  };

  vm.runInNewContext(patched, context);

  assert.equal(
    context.globalThis.resolveChromeRoot({
      homeDir: "/home/zero",
      platform: "linux"
    }),
    "/home/zero/.config/google-chrome"
  );
  assert.equal(
    context.globalThis.resolveChromeRoot({
      homeDir: "/Users/zero",
      platform: "darwin"
    }),
    "/Users/zero/Library/Application Support/Google/Chrome"
  );
  assert.equal(patchLinuxChromeExtensionDetectionSource(patched), patched);
});

test("patchLinuxChromeExtensionDetectionSource accepts upstream native Linux profiles", () => {
  const source =
    "function Nu({platform:e,homeDirectory:t,localAppData:n}){return e===`darwin`?[p.join(t,`Library`,`Application Support`,`Google`,`Chrome`)]:e===`win32`?n==null?[]:[p.join(n,`Google`,`Chrome`,`User Data`)]:e===`linux`?[p.join(t,`.config`,`google-chrome`),p.join(t,`.config`,`google-chrome-beta`),p.join(t,`.config`,`google-chrome-canary`),p.join(t,`.config`,`chromium`)]:[]}globalThis.resolveChromeRoots=Nu";
  const patched = patchLinuxChromeExtensionDetectionSource(source);
  const context = {
    globalThis: {},
    p: { join: (...parts) => parts.join("/") }
  };

  vm.runInNewContext(patched, context);

  assert.equal(patched, source);
  assert.deepEqual(
    Array.from(context.globalThis.resolveChromeRoots({
      homeDirectory: "/home/zero",
      platform: "linux"
    })),
    [
      "/home/zero/.config/google-chrome",
      "/home/zero/.config/google-chrome-beta",
      "/home/zero/.config/google-chrome-canary",
      "/home/zero/.config/chromium"
    ]
  );
});

test("patchLinuxChromeExtensionDetectionSource accepts metadata-driven Linux profiles", () => {
  const source =
    "function Ts({extensionId:e,chromeConfigHome:t=process.env.CHROME_CONFIG_HOME,homeDir:n=h.homedir(),localAppDataDir:r=process.env.LOCALAPPDATA,platform:i=process.platform,xdgConfigHome:a=process.env.XDG_CONFIG_HOME}){let o=js(e);return Ns({homeDir:n,chromeConfigHome:t,localAppDataDir:r,platform:i,xdgConfigHome:a}).some(e=>Ms(e,o))}" +
    "function Ns({chromeConfigHome:e,homeDir:t,localAppDataDir:r,platform:i,xdgConfigHome:a}){if(i===`darwin`)return[p.join(t,...xs.macos.userDataDirectorySegments)];if(i===`win32`)return[p.join(r??p.join(t,`AppData`,`Local`),...xs.windows.userDataDirectorySegments)];if(i===`linux`){let r=n.On({chromeConfigHome:e,homeDir:t,xdgConfigHome:a});return n.Dn.map(e=>p.join(r,e.userDataDirName))}return[]}";

  assert.equal(patchLinuxChromeExtensionDetectionSource(source), source);
});

test("upstream patch contracts declare required contract surface", () => {
  assert.deepEqual(
    upstreamPatchContracts.map(contract => Object.keys(contract).sort()),
    upstreamPatchContracts.map(() => ["apply", "assertAfter", "assertBefore", "find", "name"])
  );
  assert.deepEqual(
    upstreamPatchContracts.map(contract => contract.name),
    [
      "linux-window-background",
      "linux-window-transparency",
      "linux-window-focusable-default",
      "linux-chrome-extension-host-content-variant",
      "linux-chrome-extension-detection"
    ]
  );
});

test("patchLinuxWindowFocusableSource defaults undefined BrowserWindow focusability", () => {
  const source = [
    "async function createWindow(e={}){",
    "let{show:l=!0,parent:p,focusable:m,lockTitle:h=!1}=e;",
    "return new a.BrowserWindow({title:`Codex`,show:l,parent:p,focusable:m,...process.platform===`linux`?{autoHideMenuBar:!0}:{}})",
    "}"
  ].join("");

  const patched = patchLinuxWindowFocusableSource(source);

  assert.match(patched, /show:l,parent:p,focusable:m\?\?!0,/);
  assert.doesNotMatch(patched, /show:l,parent:p,focusable:m,/);
  assert.equal(hasLinuxWindowFocusableContractSource(patched), true);
  assert.equal(hasUnguardedLinuxWindowFocusableSource(source), true);
  assert.equal(hasUnguardedLinuxWindowFocusableSource(patched), false);
});

test("patchLinuxWindowFocusableSource preserves explicit unfocusable overlay windows", () => {
  const source = [
    "function createWindow(e={}){",
    "let{focusable:m}=e;",
    "new a.BrowserWindow({title:`overlay`,focusable:!1});",
    "new a.BrowserWindow({title:`Codex`,focusable:m})",
    "}"
  ].join("");

  const patched = patchLinuxWindowFocusableSource(source);

  assert.match(patched, /title:`overlay`,focusable:!1/);
  assert.match(patched, /title:`Codex`,focusable:m\?\?!0/);
});

test("patchLinuxWindowFocusableSource accepts legacy conditional focusable spread", () => {
  const source = [
    "function createWindow(e={}){",
    "let{focusable:m}=e;",
    "new a.BrowserWindow({title:`Codex`,...(m==null?{}:{focusable:m})})",
    "}"
  ].join("");

  assert.equal(patchLinuxWindowFocusableSource(source), source);
  assert.equal(hasLinuxWindowFocusableContractSource(source), true);
  assert.equal(hasUnguardedLinuxWindowFocusableSource(source), false);
});

test("patchLinuxWindowFocusableSource is idempotent", () => {
  const source = [
    "function createWindow(e={}){",
    "let{focusable:m}=e;",
    "new a.BrowserWindow({title:`Codex`,focusable:m})",
    "}"
  ].join("");
  const patched = patchLinuxWindowFocusableSource(source);

  assert.equal(patchLinuxWindowFocusableSource(patched), patched);
});

test("patchDisableTransparencySource disables Linux BrowserWindow transparency and background", () => {
  const source = [
    "function A2(e){return e===`avatarOverlay`||e===`browserCommentPopup`}",
    "function I2({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A2(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?a2:o2,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!A2(t)?{backgroundColor:i2,backgroundMaterial:`mica`}:{backgroundColor:i2,backgroundMaterial:null}}",
    "function R2({alwaysOnTop:e,hasShadow:t=!0,platform:n,resizable:r,thickFrame:i,transparent:a=!0}){return{frame:!1,transparent:a,hasShadow:t,resizable:r,minimizable:!1,maximizable:!1,fullscreenable:!1,skipTaskbar:!0,...e?{alwaysOnTop:!0}:{},...n===`win32`?{accentColor:!1,roundedCorners:!1,...i==null?{}:{thickFrame:i}}:{},...n===`darwin`?{type:`panel`}:{}}}",
    "function z2({appearance:e,platform:n}){switch(e){case`browserCommentPopup`:return R2({hasShadow:!1,platform:n,resizable:!1,thickFrame:!1,transparent:!0});case`avatarOverlay`:return R2({platform:n,resizable:!1})}}"
  ].join(";");

  const patched = patchDisableTransparencySource(source);

  assert.match(patched, /backgroundColor:e===`linux`\?\(r\?a2:o2\):i2,backgroundMaterial:null/);
  assert.doesNotMatch(patched, /\{backgroundColor:i2,backgroundMaterial:null\}/);
  assert.match(patched, /transparent:n===`linux`\?!1:a,hasShadow:t/);
  assert.doesNotMatch(patched, /return\{frame:!1,transparent:a,hasShadow:t/);
});

test("patchDisableTransparencySource accepts opaque window surface helper name", () => {
  const source = [
    "function C6(e){return e===`avatarOverlay`||e===`browserCommentPopup`}",
    "function k6({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return n?{backgroundColor:r?Q3:$3,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!C6(t)?{backgroundColor:Z3,backgroundMaterial:`mica`}:{backgroundColor:Z3,backgroundMaterial:null}}",
    "function j6({alwaysOnTop:e,hasShadow:t=!0,platform:n,resizable:r,thickFrame:i,transparent:a=!0}){return{frame:!1,transparent:a,hasShadow:t,resizable:r,minimizable:!1,maximizable:!1,fullscreenable:!1,skipTaskbar:!0,...e?{alwaysOnTop:!0}:{},...n===`win32`?{accentColor:!1,roundedCorners:!1,...i==null?{}:{thickFrame:i}}:{},...n===`darwin`?{type:`panel`}:{}}}"
  ].join(";");

  const patched = patchDisableTransparencySource(source);

  assert.match(patched, /backgroundColor:e===`linux`\?\(r\?Q3:\$3\):Z3,backgroundMaterial:null/);
  assert.match(patched, /transparent:n===`linux`\?!1:a,hasShadow:t/);
});

test("patchDisableTransparencySource patches background helper by AST shape", () => {
  const source = [
    "function skip(kind) { return kind === `avatarOverlay`; }",
    "function backdrop({ appearance: kind, prefersDarkColors: dark, platform: os, opaqueWindowSurfaceEnabled: opaque }) {",
    "  return opaque ? { backgroundMaterial: os === `win32` ? `none` : null, backgroundColor: dark ? DARK : LIGHT }",
    "    : os === `win32` && !skip(kind) ? { backgroundMaterial: `mica`, backgroundColor: WIN }",
    "    : { backgroundMaterial: null, backgroundColor: FALLBACK };",
    "}",
    "function frame({alwaysOnTop:e,hasShadow:t=!0,platform:n,resizable:r,thickFrame:i,transparent:a=!0}){return{frame:!1,transparent:a,hasShadow:t,resizable:r,minimizable:!1,maximizable:!1,fullscreenable:!1,skipTaskbar:!0}}"
  ].join("\n");

  const patched = patchDisableTransparencySource(source);

  assert.match(patched, /backgroundMaterial: null, backgroundColor: os===`linux`\?\(dark\?DARK:LIGHT\):FALLBACK/);
  assert.match(patched, /transparent:n===`linux`\?!1:a,hasShadow:t/);
});

test("patchDisableTransparencySource is idempotent", () => {
  const source = [
    "function A2(e){return e===`avatarOverlay`||e===`browserCommentPopup`}",
    "function I2({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A2(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?a2:o2,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!A2(t)?{backgroundColor:i2,backgroundMaterial:`mica`}:{backgroundColor:i2,backgroundMaterial:null}}",
    "function R2({alwaysOnTop:e,hasShadow:t=!0,platform:n,resizable:r,thickFrame:i,transparent:a=!0}){return{frame:!1,transparent:a,hasShadow:t,resizable:r,minimizable:!1,maximizable:!1,fullscreenable:!1,skipTaskbar:!0,...e?{alwaysOnTop:!0}:{},...n===`win32`?{accentColor:!1,roundedCorners:!1,...i==null?{}:{thickFrame:i}}:{},...n===`darwin`?{type:`panel`}:{}}}",
    "function z2({appearance:e,platform:n}){switch(e){case`browserCommentPopup`:return R2({hasShadow:!1,platform:n,resizable:!1,thickFrame:!1,transparent:!0});case`avatarOverlay`:return R2({platform:n,resizable:!1})}}"
  ].join(";");

  const patched = patchDisableTransparencySource(source);
  const repatched = patchDisableTransparencySource(patched);

  assert.equal(repatched, patched);
});

test("patchLinuxOwlFeatureBindingSource falls back when stock Linux Electron lacks Owl bindings", () => {
  const source = [
    "let Ge={parse:e=>e};",
    "function Ze(e){return Qe().isOwlFeatureEnabled(e)}",
    "function Qe(){let e=process._linkedBinding;if(typeof e!=`function`)throw Error(`Owl feature binding is unavailable`);return Ge.parse(e.call(process,`electron_common_owl_features`))}",
    "globalThis.result=Ze(`WorkspaceRootDrop`)"
  ].join(";");

  const patched = patchLinuxOwlFeatureBindingSource(source);
  const context = {
    process: {
      platform: "linux",
      _linkedBinding(name) {
        throw new Error(`No such binding was linked: ${name}`);
      }
    },
    globalThis: {}
  };

  vm.runInNewContext(patched, context);

  assert.equal(context.globalThis.result, false);
  assert.match(patched, /__codexLinuxOwlFeatureFallback/);
});

test("patchLinuxOwlFeatureBindingSource accepts nullable Owl helper shape", () => {
  const source = [
    "let Ve=`electron_common_owl_features`,Ge={parse:e=>e};",
    "function st(e){return e instanceof Error?e.message.includes(Ve)&&e.message.includes(`No such binding was linked:`):!1}",
    "function Ze(e){let t=Qe();return t==null?!1:t.isOwlFeatureEnabled(e)}",
    "function Qe(){let e=process._linkedBinding;if(typeof e!=`function`)return null;let t;try{t=e.call(process,Ve)}catch(e){if(st(e))return null;throw e}return Ge.parse(t)}",
    "globalThis.result=Ze(`WorkspaceRootDrop`)"
  ].join(";");

  const patched = patchLinuxOwlFeatureBindingSource(source);
  const context = {
    process: {
      platform: "linux"
    },
    globalThis: {}
  };

  vm.runInNewContext(patched, context);

  assert.equal(context.globalThis.result, false);
  assert.equal(hasUnguardedOwlFeatureBindingSource(patched), false);
  assert.match(patched, /__codexLinuxOwlFeatureFallback/);
});

test("patchLinuxOwlFeatureBindingSource is idempotent", () => {
  const source = [
    "let Ge={parse:e=>e};",
    "function Qe(){let e=process._linkedBinding;if(typeof e!=`function`)throw Error(`Owl feature binding is unavailable`);return Ge.parse(e.call(process,`electron_common_owl_features`))}"
  ].join(";");
  const patched = patchLinuxOwlFeatureBindingSource(source);

  assert.equal(patchLinuxOwlFeatureBindingSource(patched), patched);
});

test("patchLinuxOwlFeatureBindingSource patches every Owl binding helper in one bundle", () => {
  const source = [
    "let Ge={parse:e=>e},Je={parse:e=>e};",
    "function Qe(){let e=process._linkedBinding;if(typeof e!=`function`)throw Error(`Owl feature binding is unavailable`);return Ge.parse(e.call(process,`electron_common_owl_features`))}",
    "function Re(){let t=process._linkedBinding;if(typeof t!=`function`)throw Error(`Owl feature binding is unavailable`);return Je.parse(t.call(process,`electron_common_owl_features`))}"
  ].join(";");

  const patched = patchLinuxOwlFeatureBindingSource(source);

  assert.equal(hasUnguardedOwlFeatureBindingSource(patched), false);
  assert.equal(patched.match(/function __codexLinuxOwlFeatureFallback/g).length, 1);
  assert.equal(patched.match(/return __codexLinuxOwlFeatureFallback\(\)/g).length, 4);
});

test("hasUnguardedOwlFeatureBindingSource detects mixed patched and unpatched helpers", () => {
  const mixedSource = [
    "let Ge={parse:e=>e},Je={parse:e=>e};",
    "function Qe(){let e=process._linkedBinding;if(typeof e!=`function`){if(process.platform===`linux`)return __codexLinuxOwlFeatureFallback();throw Error(`Owl feature binding is unavailable`)}try{return Ge.parse(e.call(process,`electron_common_owl_features`))}catch(e){if(process.platform===`linux`&&/electron_common_owl_features|No such binding|Owl feature binding is unavailable/.test(String(e&&e.message||e)))return __codexLinuxOwlFeatureFallback();throw e}}function __codexLinuxOwlFeatureFallback(){return{isOwlFeatureEnabled:()=>!1}}",
    "function Re(){let t=process._linkedBinding;if(typeof t!=`function`)throw Error(`Owl feature binding is unavailable`);return Je.parse(t.call(process,`electron_common_owl_features`))}"
  ].join(";");

  assert.equal(hasUnguardedOwlFeatureBindingSource(mixedSource), true);
});
