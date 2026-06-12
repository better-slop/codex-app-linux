import test from "node:test";
import assert from "node:assert/strict";

import {
  patchDisableTransparencySource,
  patchLinuxOpenTargetsSource
} from "../scripts/lib/upstream-patches.mjs";

test("patchLinuxOpenTargetsSource adds Linux editor targets and exposes app paths", () => {
  const source = [
    "prefix",
    "var wd=[nd,id,ed,ou,Ll,Wu,vd,sd,Fl,vu,qu,uu,zl,hu,iu,ld,bu,mu,od,pd,Eu,Du,Ou,ku,Au,ju,Mu,Nu,Xu],Td=t.kr(`open-in-targets`);function Ed(e){return wd.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function Fd(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await ol(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "middle",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...p]",
    "suffix"
  ].join(";");

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
  const source = [
    "var wd=[nd,id,ed,ou,Ll,Wu,vd,sd,Fl,vu,qu,uu,zl,hu,iu,ld,bu,mu,od,pd,Eu,Du,Ou,ku,Au,ju,Mu,Nu,Xu],Td=t.kr(`open-in-targets`);function Ed(e){return wd.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function Fd(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await ol(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...p]"
  ].join(";");

  const patched = patchLinuxOpenTargetsSource(source);
  const repatched = patchLinuxOpenTargetsSource(patched);

  assert.equal(repatched.match(/__codexLinuxVSCode=\{id:`vscode`,platforms:\{linux:/g).length, 1);
});

test("patchLinuxOpenTargetsSource accepts alternate minified logger names", () => {
  const source = [
    "var Cd=[td,rd,$u,au,Il,Uu,_d,od,Pl,_u,Ku,lu,Rl,mu,ru,cd,yu,pu,ad,fd,Tu,Eu,Du,Ou,ku,Au,ju,Mu,Yu],wd=t.Or(`open-in-targets`);function Td(e){return Cd.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function Pd(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await ol(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...p]"
  ].join(";");

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(
    patched,
    /var Cd=\[__codexLinuxVSCode,__codexLinuxVSCodeInsiders,__codexLinuxCursor,__codexLinuxZed,__codexLinuxNvim,td,rd/
  );
});

test("patchLinuxOpenTargetsSource accepts upstream electron 42 registry shape", () => {
  const source = [
    "var Wk=[Tk,Dk,Ck,OO,aO,MO,pk,Vk,Ak,rO,VO,gk,NO,sO,RO,EO,Mk,UO,LO,kk,Ik,YO,XO,ZO,QO,$O,ek,tk,nk,yk],Gk=n.Rr(`open-in-targets`);function Kk(e){return Wk.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function tA(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await vo(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...s.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:c.has(e),default:l===e||void 0})),...g]"
  ].join(";");

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

test("patchLinuxOpenTargetsSource tolerates targets without platform maps", () => {
  const source = [
    "var wd=[nd,id],Td=t.kr(`open-in-targets`);function Ed(e){return wd.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function Fd(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await ol(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...p]"
  ].join(";");

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(patched, /let n=t\.platforms\?\.\[e\];return n/);
});

test("patchLinuxOpenTargetsSource preserves native target spread variable", () => {
  const source = [
    "var uD=[HE,WE],dD=t.ti(`open-in-targets`);function fD(e){return uD.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function xD(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await zi(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...h]"
  ].join(";");

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
