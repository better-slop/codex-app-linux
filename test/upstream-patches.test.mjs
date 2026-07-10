import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

import {
  hasUnguardedDynamicToolSchemaContractSource,
  hasUnguardedDynamicToolStartResponseSource,
  hasUnguardedDynamicToolThreadStartBridgeSource,
  hasUnguardedDynamicToolThreadStartRequestSource,
  hasLinuxWindowFocusableContractSource,
  hasUnguardedLinuxWindowFocusableSource,
  hasUnguardedOwlFeatureBindingSource,
  patchDynamicToolSchemaContractSource,
  patchDynamicToolStartResponseSource,
  patchDynamicToolThreadStartBridgeSource,
  patchDynamicToolThreadStartRequestSource,
  patchDisableTransparencySource,
  patchLinuxOwlFeatureBindingSource,
  patchLinuxWindowFocusableSource,
  patchLinuxOpenTargetsSource,
  dynamicToolThreadStartBridgeContract,
  dynamicToolStartResponseContract,
  upstreamPatchContracts,
  dynamicToolSchemaContract,
  dynamicToolThreadStartRequestContract
} from "../scripts/lib/upstream-patches.mjs";

const openTargetResolverSource =
  "function W(e){let t=which.default.sync(e,{nothrow:!0});return typeof t==`string`&&fs.existsSync(t)?t:null}";
const withOpenTargetResolver = parts => [openTargetResolverSource, ...parts].join(";");

function assertCanonicalDynamicTools(tools) {
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal("namespace" in tool, false);
    assert.equal("exposeToContext" in tool, false);
    assert.equal("input_schema" in tool, false);
    assert.equal("parameters" in tool, false);

    if (tool.type === "namespace") {
      assert.equal(Array.isArray(tool.tools), true);
      assertCanonicalDynamicTools(tool.tools);
      continue;
    }

    assert.equal(tool.type, "function");
    assert.equal(tool.inputSchema?.type, "object");
  }
}

test("patchLinuxOpenTargetsSource adds Linux editor targets and exposes app paths", () => {
  const source = withOpenTargetResolver([
    "prefix",
    "var wd=[nd,id,ed,ou,Ll,Wu,vd,sd,Fl,vu,qu,uu,zl,hu,iu,ld,bu,mu,od,pd,Eu,Du,Ou,ku,Au,ju,Mu,Nu,Xu],Td=t.kr(`open-in-targets`);function Ed(e){return wd.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function Fd(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await ol(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "middle",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...p]",
    "suffix"
  ]);

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(patched, /__codexLinuxVSCode=\{id:`vscode`,platforms:\{linux:/);
  assert.match(patched, /__codexLinuxCursor=\{id:`cursor`,platforms:\{linux:/);
  assert.match(patched, /__codexLinuxZed=\{id:`zed`,platforms:\{linux:/);
  assert.match(patched, /__codexLinuxNvim=\{id:`nvim`,platforms:\{linux:/);
  assert.match(
    patched,
    /var wd=\[__codexLinuxVSCode,__codexLinuxVSCodeInsiders,__codexLinuxCursor,__codexLinuxZed,__codexLinuxNvim,nd,id/
  );
  assert.match(
    patched,
    /await ol\(r\.command,r\.args\(__codexLinuxOpenTargetNvimCommand\(e,t,n\)\)\)/
  );
  assert.match(
    patched,
    /appPath:process\.platform===`linux`&&r===`editor`&&s\.has\(e\)\?Ld\(\)\.get\(e\)\?\?null:null/
  );
  assert.match(patched, /let n=t\.platforms\?\.\[e\];return n/);
  assert.doesNotMatch(patched, /let n=t\.platforms\[e\];return n/);
});

test("patchLinuxOpenTargetsSource is idempotent for target definitions", () => {
  const source = withOpenTargetResolver([
    "var wd=[nd,id,ed,ou,Ll,Wu,vd,sd,Fl,vu,qu,uu,zl,hu,iu,ld,bu,mu,od,pd,Eu,Du,Ou,ku,Au,ju,Mu,Nu,Xu],Td=t.kr(`open-in-targets`);function Ed(e){return wd.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function Fd(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await ol(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...p]"
  ]);

  const patched = patchLinuxOpenTargetsSource(source);
  const repatched = patchLinuxOpenTargetsSource(patched);

  assert.equal(repatched.match(/__codexLinuxVSCode=\{id:`vscode`,platforms:\{linux:/g).length, 1);
});

test("patchLinuxOpenTargetsSource accepts alternate minified logger names", () => {
  const source = withOpenTargetResolver([
    "var Cd=[td,rd,$u,au,Il,Uu,_d,od,Pl,_u,Ku,lu,Rl,mu,ru,cd,yu,pu,ad,fd,Tu,Eu,Du,Ou,ku,Au,ju,Mu,Yu],wd=t.Or(`open-in-targets`);function Td(e){return Cd.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function Pd(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await ol(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...p]"
  ]);

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(
    patched,
    /var Cd=\[__codexLinuxVSCode,__codexLinuxVSCodeInsiders,__codexLinuxCursor,__codexLinuxZed,__codexLinuxNvim,td,rd/
  );
});

test("patchLinuxOpenTargetsSource accepts upstream electron 42 registry shape", () => {
  const source = withOpenTargetResolver([
    "var Wk=[Tk,Dk,Ck,OO,aO,MO,pk,Vk,Ak,rO,VO,gk,NO,sO,RO,EO,Mk,UO,LO,kk,Ik,YO,XO,ZO,QO,$O,ek,tk,nk,yk],Gk=n.Rr(`open-in-targets`);function Kk(e){return Wk.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function tA(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await vo(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...s.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:c.has(e),default:l===e||void 0})),...g]"
  ]);

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(
    patched,
    /var Wk=\[__codexLinuxVSCode,__codexLinuxVSCodeInsiders,__codexLinuxCursor,__codexLinuxZed,__codexLinuxNvim,Tk,Dk/
  );
  assert.match(
    patched,
    /targets:\[\.\.\.s\.map\(\(\{id:e,label:t,icon:n,kind:r,hidden:i\}\)=>\(\{id:e,target:e,label:t,icon:n,kind:r,hidden:i,appPath:process\.platform===`linux`&&r===`editor`&&c\.has\(e\)\?Ld\(\)\.get\(e\)\?\?null:null,available:c\.has\(e\),default:l===e\|\|void 0\}\)\),\.\.\.g\]/
  );
});

test("patchLinuxOpenTargetsSource accepts upstream dispatcher runner shape", () => {
  const source = withOpenTargetResolver([
    "var kN=[cN,uN,oN,lM],AN=t.qr(`open-in-targets`);function jN(e){return kN.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function BN(e,t,{appPath:n,detectedCommand:r,hostConfig:i,location:a,remotePath:o,remoteWorkspaceRoot:s,targets:c=MN}={}){if(o!=null&&i?.kind===`remote-control`)throw Error(`Remote control does not support open in ${e} yet.`);let l=c.find(t=>t.id===e);if(!l)throw Error(`Unknown open target \"${e}\"`);let u=r??await l.detect(IN);if(!u)throw Error(`Open target \"${e}\" is not available`);if(l.open){await l.open({command:u,path:t,appPath:n,location:a,hostConfig:i,remoteWorkspaceRoot:s,remotePath:o});return}await no(u,l.args(t,a,i,s,o),{env:l.env?.()})}",
    "targets:[...s.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:c.has(e),default:l===e||void 0})),...g]"
  ]);

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(
    patched,
    /var kN=\[__codexLinuxVSCode,__codexLinuxVSCodeInsiders,__codexLinuxCursor,__codexLinuxZed,__codexLinuxNvim,cN,uN/
  );
  assert.match(
    patched,
    /await no\(r\.command,r\.args\(__codexLinuxOpenTargetNvimCommand\(e,t,n\)\)\)/
  );
});

test("patchLinuxOpenTargetsSource accepts bare open-target logger and discovered resolver", () => {
  const source = [
    "function os(e){let t=rs.default.sync(e,{nothrow:!0});return typeof t==`string`&&u.existsSync(t)?t:null}",
    "var GN=[wN,EN,SN,TM,nM,kM,fN,BN,kN,eM,RM,hN,AM,iM,FM,CM,jN,BM,PM,ON,FN,KM,qM,JM,YM,XM,ZM,QM,$M,vN];t.ri(`open-in-targets`);function KN(e){return GN.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function XN(e,t,{appPath:n,detectedCommand:r,hostConfig:i,location:a,remotePath:o,remoteWorkspaceRoot:s,targets:c=qN}={}){if(o!=null&&i?.kind===`remote-control`)throw Error(`Remote control does not support open in ${e} yet.`);let l=c.find(t=>t.id===e);if(!l)throw Error(`Unknown open target \"${e}\"`);let u=r??await l.detect(JN);if(!u)throw Error(`Open target \"${e}\" is not available`);if(l.open){await l.open({command:u,path:t,appPath:n,location:a,hostConfig:i,remoteWorkspaceRoot:s,remotePath:o});return}await us(u,l.args(t,a,i,s,o),{env:l.env?.()})}",
    "targets:[...l.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:m.has(e),default:h===e||void 0})),...y]"
  ].join(";");

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(
    patched,
    /var GN=\[__codexLinuxVSCode,__codexLinuxVSCodeInsiders,__codexLinuxCursor,__codexLinuxZed,__codexLinuxNvim,wN,EN/
  );
  assert.match(patched, /detect:\(\)=>os\(`code`\)/);
  assert.match(patched, /__codexLinuxShellQuote=/);
  assert.doesNotMatch(patched, /t\.En/);
  assert.match(
    patched,
    /appPath:process\.platform===`linux`&&r===`editor`&&m\.has\(e\)\?Ld\(\)\.get\(e\)\?\?null:null/
  );
});

test("patchLinuxOpenTargetsSource accepts latest real upstream dispatcher fixture slice", async () => {
  const source = await fs.readFile(
    "test/fixtures/upstream-main-26.616.30709-open-target.slice.txt",
    "utf8"
  );

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(
    patched,
    /var kN=\[__codexLinuxVSCode,__codexLinuxVSCodeInsiders,__codexLinuxCursor,__codexLinuxZed,__codexLinuxNvim,cN,uN/
  );
  assert.match(
    patched,
    /await no\(r\.command,r\.args\(__codexLinuxOpenTargetNvimCommand\(e,t,n\)\)\)/
  );
  assert.match(
    patched,
    /appPath:process\.platform===`linux`&&r===`editor`&&m\.has\(e\)\?Ld\(\)\.get\(e\)\?\?null:null/
  );
});

test("upstream patch contracts declare required contract surface", () => {
  assert.deepEqual(
    upstreamPatchContracts.map(contract => Object.keys(contract).sort()),
    upstreamPatchContracts.map(() => ["apply", "assertAfter", "assertBefore", "find", "name"])
  );
  assert.deepEqual(
    upstreamPatchContracts.map(contract => contract.name),
    [
      "dynamic-tool-start-response",
      "dynamic-tool-thread-start-bridge",
      "open-target-dispatcher",
      "linux-window-background",
      "linux-window-transparency",
      "linux-window-focusable-default"
    ]
  );
  assert.deepEqual(
    Object.keys(dynamicToolStartResponseContract).sort(),
    ["apply", "assertAfter", "assertBefore", "find", "name"]
  );
  assert.equal(dynamicToolStartResponseContract.name, "dynamic-tool-start-response");
  assert.deepEqual(
    Object.keys(dynamicToolThreadStartBridgeContract).sort(),
    ["apply", "assertAfter", "assertBefore", "find", "name"]
  );
  assert.equal(dynamicToolThreadStartBridgeContract.name, "dynamic-tool-thread-start-bridge");
  assert.deepEqual(
    Object.keys(dynamicToolSchemaContract).sort(),
    ["apply", "assertAfter", "assertBefore", "find", "name"]
  );
  assert.equal(dynamicToolSchemaContract.name, "dynamic-tool-schema-contract");
  assert.deepEqual(
    Object.keys(dynamicToolThreadStartRequestContract).sort(),
    ["apply", "assertAfter", "assertBefore", "find", "name"]
  );
  assert.equal(dynamicToolThreadStartRequestContract.name, "dynamic-tool-thread-start-request");
});

test("patchLinuxOpenTargetsSource reports contract name on upstream drift", () => {
  assert.throws(
    () => patchLinuxOpenTargetsSource("function nope(){}"),
    /open-target-dispatcher contract changed: Unable to apply upstream patch; missing open target registry/
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

test("patchLinuxOpenTargetsSource tolerates targets without platform maps", () => {
  const source = withOpenTargetResolver([
    "var wd=[nd,id],Td=t.kr(`open-in-targets`);function Ed(e){return wd.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function Fd(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await ol(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...p]"
  ]);

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(patched, /let n=t\.platforms\?\.\[e\];return n/);
});

test("patchLinuxOpenTargetsSource preserves native target spread variable", () => {
  const source = withOpenTargetResolver([
    "var uD=[HE,WE],dD=t.ti(`open-in-targets`);function fD(e){return uD.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function xD(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await zi(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...h]"
  ]);

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(
    patched,
    /appPath:process\.platform===`linux`&&r===`editor`&&s\.has\(e\)\?Ld\(\)\.get\(e\)\?\?null:null/
  );
  assert.match(patched, /\}\)\),\.\.\.h\]/);
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

test("patchDynamicToolStartResponseSource normalizes desktop thread-start dynamic tools", () => {
  const source = [
    "class Manager{constructor(){this.pendingDynamicToolsForThreadStartRequests=new Map}send(t){this.pendingDynamicToolsForThreadStartRequests.set(`req`,{originId:1,timeout:null,resolve:e=>{globalThis.result=e}});this.handleDynamicToolsForThreadStartResponse({id:1},{requestId:`req`,dynamicTools:t})}handleDynamicToolsForThreadStartResponse(e,t){let n=this.pendingDynamicToolsForThreadStartRequests.get(t.requestId);if(!n||n.originId!==e.id)return;this.pendingDynamicToolsForThreadStartRequests.delete(t.requestId),clearTimeout(n.timeout),n.resolve(t.dynamicTools)}}",
    "let manager=new Manager;",
    "manager.send([{type:`namespace`,name:`codex_app`,tools:[{type:`function`,name:`good`,inputSchema:{type:`object`}},{type:`function`,name:`snake`,input_schema:{type:`object`}},{type:`function`,name:`params`,parameters:{type:`object`}},{type:`function`,name:`bad`},{type:`other`,name:`untouched`}]}]);"
  ].join("");

  const patched = patchDynamicToolStartResponseSource(source);
  const context = {
    clearTimeout,
    globalThis: {}
  };

  vm.runInNewContext(patched, context);

  const dynamicTools = context.globalThis.result;
  const tools = dynamicTools[0].tools;

  assert.equal(hasUnguardedDynamicToolStartResponseSource(patched), false);
  assert.equal(dynamicTools[0].type, "namespace");
  assert.equal(dynamicTools[0].name, "codex_app");
  assert.equal(JSON.stringify(tools.map(tool => tool.name)), JSON.stringify(["good", "snake", "params"]));
  assert.equal(tools.filter(tool => tool.type === "function").every(tool => tool.inputSchema?.type === "object"), true);
  assertCanonicalDynamicTools(dynamicTools);
});

test("patchDynamicToolStartResponseSource is idempotent", () => {
  const source = "class Manager{handleDynamicToolsForThreadStartResponse(e,t){let n=this.pendingDynamicToolsForThreadStartRequests.get(t.requestId);if(!n||n.originId!==e.id)return;this.pendingDynamicToolsForThreadStartRequests.delete(t.requestId),clearTimeout(n.timeout),n.resolve(t.dynamicTools)}}";
  const patched = patchDynamicToolStartResponseSource(source);

  assert.equal(patchDynamicToolStartResponseSource(patched), patched);
});

test("hasUnguardedDynamicToolStartResponseSource detects unpatched desktop resolver", () => {
  const source = "class Manager{handleDynamicToolsForThreadStartResponse(e,t){let n=this.pendingDynamicToolsForThreadStartRequests.get(t.requestId);if(!n||n.originId!==e.id)return;this.pendingDynamicToolsForThreadStartRequests.delete(t.requestId),clearTimeout(n.timeout),n.resolve(t.dynamicTools)}}";

  assert.equal(hasUnguardedDynamicToolStartResponseSource(source), true);
});

test("patchDynamicToolThreadStartBridgeSource normalizes final Electron bridge requests", async () => {
  const source = [
    "class Bridge{constructor(){this.requests=[]}getAppServerConnection(){return{handleClientRequest:async(e,t)=>{this.requests.push(t)},handlePrewarmThreadStart:async(e,t)=>{this.requests.push(t)}}}",
    "async handleMessage(e,n){switch(n.type){case`mcp-request`:{let t=n.request;await this.getAppServerConnection(n.hostId).handleClientRequest({},t);break}case`thread-prewarm-start`:await this.getAppServerConnection(n.hostId).handlePrewarmThreadStart({},n.request);break}}}",
    "let dynamicTools=[{type:`namespace`,name:`codex_app`,tools:[{type:`function`,name:`good`,inputSchema:{type:`object`}},{name:`plainSnake`,input_schema:{type:`object`}},{name:`plainParams`,parameters:{type:`object`}},{type:`function`,name:`bad`},{type:`other`,id:`untouched`}]},{name:`top`,parameters:{type:`object`}},{name:`topBad`}];",
    "globalThis.bridge=new Bridge;await globalThis.bridge.handleMessage(null,{type:`mcp-request`,hostId:`local`,request:{id:`1`,method:`thread/start`,params:{dynamicTools}}});await globalThis.bridge.handleMessage(null,{type:`thread-prewarm-start`,hostId:`local`,request:{id:`2`,method:`thread/start`,params:{dynamicTools}}});"
  ].join("");

  const patched = patchDynamicToolThreadStartBridgeSource(source);
  const context = {
    globalThis: {}
  };

  await vm.runInNewContext(`(async()=>{${patched}})()`, context);

  const [normal, prewarm] = context.globalThis.bridge.requests;
  const dynamicTools = normal.params.dynamicTools;
  const tools = dynamicTools[0].tools;

  assert.equal(hasUnguardedDynamicToolThreadStartBridgeSource(patched), false);
  assert.equal(JSON.stringify(tools.map(tool => tool.name)), JSON.stringify(["good", "plainSnake", "plainParams", "bad"]));
  assert.equal(JSON.stringify(dynamicTools.slice(1).map(tool => tool.name)), JSON.stringify(["top", "topBad"]));
  assertCanonicalDynamicTools(dynamicTools);
  assert.deepEqual(prewarm.params.dynamicTools, dynamicTools);
});

test("patchDynamicToolThreadStartBridgeSource is idempotent", () => {
  const source = "class Bridge{getAppServerConnection(){return{handleClientRequest(){},handlePrewarmThreadStart(){}}}async handleMessage(e,n){switch(n.type){case`mcp-request`:{let t=n.request;await this.getAppServerConnection(n.hostId).handleClientRequest({},t);break}case`thread-prewarm-start`:await this.getAppServerConnection(n.hostId).handlePrewarmThreadStart({},n.request);break}}}";
  const patched = patchDynamicToolThreadStartBridgeSource(source);

  assert.equal(patchDynamicToolThreadStartBridgeSource(patched), patched);
});

test("hasUnguardedDynamicToolThreadStartBridgeSource detects raw Electron bridge requests", () => {
  const source = "class Bridge{getAppServerConnection(){return{handleClientRequest(){},handlePrewarmThreadStart(){}}}async handleMessage(e,n){switch(n.type){case`mcp-request`:{let t=n.request;await this.getAppServerConnection(n.hostId).handleClientRequest({},t);break}case`thread-prewarm-start`:await this.getAppServerConnection(n.hostId).handlePrewarmThreadStart({},n.request);break}}}";

  assert.equal(hasUnguardedDynamicToolThreadStartBridgeSource(source), true);
});

test("patchDynamicToolSchemaContractSource normalizes thread-start dynamic tool schemas", async () => {
  const source = [
    "var yr=`codex_app`,br=new Set;",
    "var good={name:`good`,inputSchema:{type:`object`,properties:{},additionalProperties:!1}};",
    "var snake={name:`snake`,input_schema:{type:`object`,properties:{value:{type:`string`}}}};",
    "var parameters={name:`parameters`,parameters:{type:`object`,properties:{count:{type:`number`}}}};",
    "var bad={name:`bad`};",
    "async function xr(){return[{type:`namespace`,name:yr,description:`Tools provided by the Codex app.`,tools:[good,snake,parameters,bad].map(e=>({type:`function`,...e,...br.has(e.name)?{}:{deferLoading:!0}}))}]}",
    "globalThis.result=await xr();"
  ].join("");

  const patched = patchDynamicToolSchemaContractSource(source);
  const context = {
    globalThis: {}
  };

  await vm.runInNewContext(`(async()=>{${patched}})()`, context);

  const dynamicTools = context.globalThis.result;
  const tools = dynamicTools[0].tools;

  assert.equal(hasUnguardedDynamicToolSchemaContractSource(patched), false);
  assert.equal(JSON.stringify(tools.map(tool => tool.name)), JSON.stringify(["good", "snake", "parameters"]));
  assert.equal(tools.every(tool => tool.inputSchema?.type === "object"), true);
  assert.equal(tools.every(tool => tool.deferLoading === true), true);
  assertCanonicalDynamicTools(dynamicTools);
});

test("patchDynamicToolThreadStartRequestSource normalizes final thread/start params", () => {
  const source = [
    "class Client{constructor(){this.requestPromises=new Map;this.hostId=`local`;this.dispatchMessage=(type,payload)=>{globalThis.sent={type,payload}};this.requestLifecycleListeners=[]}",
    "createRequest(e,t,n){let r=`req`,i=n?.timeoutMs??0,a=null,o=this.requestPromises.size,s=Date.now(),c=Promise.resolve();return console.debug(`mcp_request_enqueued`),{request:{id:r,method:e,params:t},promise:c}}",
    "sendRequest(e,t,n){let{request:r,promise:i}=this.createRequest(e,t,n);this.dispatchMessage(`mcp-request`,{request:r,hostId:this.hostId});return i}}",
    "new Client().sendRequest(`thread/start`,{dynamicTools:[{type:`namespace`,name:`codex_app`,tools:[{type:`function`,name:`good`,inputSchema:{type:`object`}},{type:`function`,name:`snake`,input_schema:{type:`object`}},{type:`function`,name:`params`,parameters:{type:`object`}},{type:`function`,name:`bad`},{type:`other`,name:`untouched`}]}]});"
  ].join("");

  const patched = patchDynamicToolThreadStartRequestSource(source);
  const context = {
    console: { debug() {} },
    globalThis: {}
  };

  vm.runInNewContext(patched, context);

  const dynamicTools = context.globalThis.sent.payload.request.params.dynamicTools;
  const tools = dynamicTools[0].tools;

  assert.equal(hasUnguardedDynamicToolThreadStartRequestSource(patched), false);
  assert.equal(JSON.stringify(tools.map(tool => tool.name)), JSON.stringify(["good", "snake", "params", "bad"]));
  assertCanonicalDynamicTools(dynamicTools);
});

test("patchDynamicToolThreadStartRequestSource is idempotent", () => {
  const source = "class Client{createRequest(e,t,n){let r=`req`,c=Promise.resolve();return console.debug(`mcp_request_enqueued`),{request:{id:r,method:e,params:t},promise:c}}}new Client().createRequest(`thread/start`,{},{});";
  const patched = patchDynamicToolThreadStartRequestSource(source);

  assert.equal(patchDynamicToolThreadStartRequestSource(patched), patched);
});

test("hasUnguardedDynamicToolThreadStartRequestSource detects raw thread/start params", () => {
  const source = "class Client{createRequest(e,t,n){let r=`req`,c=Promise.resolve();return console.debug(`mcp_request_enqueued`),{request:{id:r,method:e,params:t},promise:c}}}new Client().createRequest(`thread/start`,{},{});";

  assert.equal(hasUnguardedDynamicToolThreadStartRequestSource(source), true);
});

test("patchDynamicToolSchemaContractSource is idempotent", () => {
  const source = [
    "var yr=`codex_app`,br=new Set;",
    "var good={name:`good`,inputSchema:{type:`object`,properties:{},additionalProperties:!1}};",
    "async function xr(){return[{type:`namespace`,name:yr,description:`Tools provided by the Codex app.`,tools:[good].map(e=>({type:`function`,...e,...br.has(e.name)?{}:{deferLoading:!0}}))}]}"
  ].join("");
  const patched = patchDynamicToolSchemaContractSource(source);

  assert.equal(patchDynamicToolSchemaContractSource(patched), patched);
});

test("hasUnguardedDynamicToolSchemaContractSource detects unpatched schema mapper", () => {
  const source = [
    "var yr=`codex_app`,br=new Set;",
    "var good={name:`good`,inputSchema:{type:`object`,properties:{},additionalProperties:!1}};",
    "async function xr(){return[{type:`namespace`,name:yr,description:`Tools provided by the Codex app.`,tools:[good].map(e=>({type:`function`,...e,...br.has(e.name)?{}:{deferLoading:!0}}))}]}"
  ].join("");

  assert.equal(hasUnguardedDynamicToolSchemaContractSource(source), true);
});
