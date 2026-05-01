import test from "node:test";
import assert from "node:assert/strict";

import { patchLinuxOpenTargetsSource } from "../scripts/lib/upstream-patches.mjs";

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

test("patchLinuxOpenTargetsSource tolerates targets without platform maps", () => {
  const source = [
    "var wd=[nd,id],Td=t.kr(`open-in-targets`);function Ed(e){return wd.flatMap(t=>{let n=t.platforms[e];return n?[{id:t.id,...n}]:[]})}",
    "async function Fd(e,t,n,r,i,a,o){let s={args:()=>[],env:()=>({})},c=`open`;await ol(c,s.args(t,r,i,a,o),{env:s.env?.()})}",
    "targets:[...o.map(({id:e,label:t,icon:n,kind:r,hidden:i})=>({id:e,target:e,label:t,icon:n,kind:r,hidden:i,available:s.has(e),default:c===e||void 0})),...p]"
  ].join(";");

  const patched = patchLinuxOpenTargetsSource(source);

  assert.match(patched, /let n=t\.platforms\?\.\[e\];return n/);
});
