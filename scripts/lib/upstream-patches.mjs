import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";

const linuxOpenTargetDefinitions = ({ openCommandName, executableResolverName }) => [
  "var __codexLinuxOpenTargetGotoArgs=(e,t)=>t?[`--goto`,`${e}:${t.line}:${t.column}`]:[e]",
  "__codexLinuxOpenTargetColonArgs=(e,t)=>t?[`${e}:${t.line}:${t.column}`]:[e]",
  `__codexLinuxOpenTargetTerminal=()=>{let e=process.env.TERMINAL?.trim();if(e&&${executableResolverName}(e))return{command:${executableResolverName}(e),args:e=>[\`-e\`,process.env.SHELL?.trim()||\`/bin/sh\`,\`-lc\`,e]};for(let e of [[\`ghostty\`,e=>[\`-e\`,process.env.SHELL?.trim()||\`/bin/sh\`,\`-lc\`,e]],[\`kitty\`,e=>[\`-e\`,process.env.SHELL?.trim()||\`/bin/sh\`,\`-lc\`,e]],[\`alacritty\`,e=>[\`-e\`,process.env.SHELL?.trim()||\`/bin/sh\`,\`-lc\`,e]],[\`wezterm\`,e=>[\`start\`,\`--\`,process.env.SHELL?.trim()||\`/bin/sh\`,\`-lc\`,e]],[\`gnome-terminal\`,e=>[\`--\`,process.env.SHELL?.trim()||\`/bin/sh\`,\`-lc\`,e]],[\`konsole\`,e=>[\`-e\`,process.env.SHELL?.trim()||\`/bin/sh\`,\`-lc\`,e]],[\`xterm\`,e=>[\`-e\`,process.env.SHELL?.trim()||\`/bin/sh\`,\`-lc\`,e]]]){let t=${executableResolverName}(e[0]);if(t)return{command:t,args:e[1]}}return null}`,
  "__codexLinuxOpenTargetNvimArgs=(e,t)=>t?[`+call cursor(${t.line},${t.column})`,e]:[e]",
  "__codexLinuxShellQuote=e=>{e=String(e);return e.length===0?`''`:/^[A-Za-z0-9_/:=.-]+$/.test(e)?e:`'${e.replaceAll(`'`,`'\\\\''`)}'`}",
  "__codexLinuxOpenTargetNvimCommand=(e,n,r)=>[e,...__codexLinuxOpenTargetNvimArgs(n,r)].map(__codexLinuxShellQuote).join(` `)",
  `__codexLinuxOpenTargetRunNvim=async({command:e,path:t,location:n})=>{let r=__codexLinuxOpenTargetTerminal();if(!r)throw Error(\`No terminal emulator found for Neovim\`);await ${openCommandName}(r.command,r.args(__codexLinuxOpenTargetNvimCommand(e,t,n)))}`,
  `__codexLinuxVSCode={id:\`vscode\`,platforms:{linux:{label:\`VS Code\`,icon:\`apps/vscode.png\`,kind:\`editor\`,detect:()=>${executableResolverName}(\`code\`),args:__codexLinuxOpenTargetGotoArgs}}}`,
  `__codexLinuxVSCodeInsiders={id:\`vscodeInsiders\`,platforms:{linux:{label:\`VS Code Insiders\`,icon:\`apps/vscode-insiders.png\`,kind:\`editor\`,detect:()=>${executableResolverName}(\`code-insiders\`),args:__codexLinuxOpenTargetGotoArgs}}}`,
  `__codexLinuxCursor={id:\`cursor\`,platforms:{linux:{label:\`Cursor\`,icon:\`apps/cursor.png\`,kind:\`editor\`,detect:()=>${executableResolverName}(\`cursor\`),args:__codexLinuxOpenTargetGotoArgs}}}`,
  `__codexLinuxZed={id:\`zed\`,platforms:{linux:{label:\`Zed\`,icon:\`apps/zed.png\`,kind:\`editor\`,detect:()=>${executableResolverName}(\`zed\`),args:__codexLinuxOpenTargetColonArgs}}}`,
  `__codexLinuxNvim={id:\`nvim\`,platforms:{linux:{label:\`Neovim\`,icon:\`apps/terminal.png\`,kind:\`editor\`,detect:()=>${executableResolverName}(\`nvim\`),args:__codexLinuxOpenTargetNvimArgs,open:__codexLinuxOpenTargetRunNvim}}}`
].join(",");
const openTargetMapRegex =
  /targets:\[\.\.\.([A-Za-z_$][\w$]*)\.map\(\(\{id:([A-Za-z_$][\w$]*),label:([A-Za-z_$][\w$]*),icon:([A-Za-z_$][\w$]*),kind:([A-Za-z_$][\w$]*),hidden:([A-Za-z_$][\w$]*)\}\)=>\(\{id:\2,target:\2,label:\3,icon:\4,kind:\5,hidden:\6,available:([A-Za-z_$][\w$]*)\.has\(\2\),default:([A-Za-z_$][\w$]*)===\2\|\|void 0\}\)\),\.\.\.([A-Za-z_$][\w$]*)\]/;
const linuxTransparencyPatchedRegex =
  /transparent:[A-Za-z_$][\w$]*===`linux`\?!1:[A-Za-z_$][\w$]*,hasShadow:/;
const linuxTransparencyPatchRegex =
  /function ([A-Za-z_$][\w$]*)\(\{alwaysOnTop:([A-Za-z_$][\w$]*),hasShadow:([A-Za-z_$][\w$]*)=!0,platform:([A-Za-z_$][\w$]*),resizable:([A-Za-z_$][\w$]*),thickFrame:([A-Za-z_$][\w$]*),transparent:([A-Za-z_$][\w$]*)=!0\}\)\{return\{frame:!1,transparent:\7,hasShadow:\3,/;
const owlFeatureBindingRegex =
  /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=process\._linkedBinding;if\(typeof \2!=`function`\)throw Error\(`Owl feature binding is unavailable`\);return ([A-Za-z_$][\w$]*)\.parse\(\2\.call\(process,`electron_common_owl_features`\)\)\}/;
const owlNullableFeatureBindingRegex =
  /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=process\._linkedBinding;if\(typeof \2!=`function`\)return null;let ([A-Za-z_$][\w$]*);try\{\3=\2\.call\(process,([A-Za-z_$][\w$]*)\)\}catch\(([A-Za-z_$][\w$]*)\)\{if\(([A-Za-z_$][\w$]*)\(\5\)\)return null;throw \5\}return ([A-Za-z_$][\w$]*)\.parse\(\3\)\}/;
const owlFeatureFallbackMarker = "__codexLinuxOwlFeatureFallback";

export class UpstreamPatchContractError extends Error {
  constructor(contractName, message, options = {}) {
    super(`${contractName} contract changed: ${message}`, {
      cause: options.cause
    });
    this.name = "UpstreamPatchContractError";
    this.contractName = contractName;
  }
}

export const upstreamPatchContracts = [
  // Why: upstream desktop only registers macOS open-in-editor targets; Linux
  // needs locally installed editors and terminal-backed Neovim. Contract:
  // upstream still exposes an open-target registry, runner, and preferred-target
  // mapper. Repro: node scripts/canary.mjs --channel prod --no-smoke.
  {
    name: "open-target-dispatcher",
    find: findOpenTargetRegistry,
    assertBefore: assertOpenTargetsBefore,
    apply: applyLinuxOpenTargetsSource,
    assertAfter: assertOpenTargetsAfter
  },
  // Why: transparent frameless windows render poorly under Linux compositors.
  // Contract: the main bundle still builds BrowserWindow background options
  // from the parsed window-options object. Repro: node scripts/canary.mjs --channel prod --no-smoke.
  {
    name: "linux-window-background",
    find: findLinuxWindowBackgroundPatch,
    assertBefore: assertLinuxWindowBackgroundBefore,
    apply: patchLinuxWindowBackground,
    assertAfter: assertLinuxWindowBackgroundAfter
  },
  // Why: Linux needs forced opaque windows even when upstream defaults are
  // transparent. Contract: the minified BrowserWindow helper still returns the
  // transparent option beside hasShadow. Repro: node scripts/canary.mjs --channel prod --no-smoke.
  {
    name: "linux-window-transparency",
    find: findLinuxWindowTransparencyPatch,
    assertBefore: assertLinuxWindowTransparencyBefore,
    apply: patchLinuxWindowTransparency,
    assertAfter: assertLinuxWindowTransparencyAfter
  },
  // Why: Electron/Linux treats an explicitly undefined BrowserWindow focusable
  // option like false. Upstream 26.623 started passing focusable: undefined for
  // the primary window, which makes X11 WMs see an unmanaged override-redirect
  // surface. Contract: the main window still forwards the createWindow
  // focusable option into BrowserWindow.
  {
    name: "linux-window-focusable-default",
    find: findLinuxWindowFocusablePatch,
    assertBefore: assertLinuxWindowFocusableBefore,
    apply: patchLinuxWindowFocusable,
    assertAfter: assertLinuxWindowFocusableAfter
  }
];

export const owlFeatureBindingContract = {
  name: "owl-feature-binding",
  find: findOwlFeatureBindingPatch,
  assertBefore: assertOwlFeatureBindingBefore,
  apply: patchOwlFeatureBinding,
  assertAfter: assertOwlFeatureBindingAfter
};

export async function patchUpstreamApp(stageAppDir) {
  const buildDir = path.join(stageAppDir, ".vite", "build");
  const entries = await fs.readdir(buildDir);
  const mainBundleName = entries.find((entry) => /^main-.*\.js$/.test(entry));

  if (!mainBundleName) {
    throw new Error(`Unable to locate upstream main bundle under ${buildDir}`);
  }

  const mainBundlePath = path.join(buildDir, mainBundleName);
  const source = await fs.readFile(mainBundlePath, "utf8");
  const patched = patchUpstreamMainSource(source);

  if (patched === source) {
    await patchOwlFeatureBindingChunks(buildDir, entries);
    return;
  }

  await fs.writeFile(mainBundlePath, patched);
  await patchOwlFeatureBindingChunks(buildDir, entries);
}

export function patchUpstreamMainSource(source) {
  return applyUpstreamPatchContracts(source, upstreamPatchContracts);
}

export function patchLinuxOpenTargetsSource(source) {
  return applyUpstreamPatchContract(source, upstreamPatchContracts[0]);
}

export function patchDisableTransparencySource(source) {
  return applyUpstreamPatchContracts(source, upstreamPatchContracts.slice(1, 3));
}

export function patchLinuxWindowFocusableSource(source) {
  return applyUpstreamPatchContract(source, upstreamPatchContracts[3]);
}

export function patchLinuxOwlFeatureBindingSource(source) {
  try {
    let patched = source;

    while (true) {
      const patch = findOwlFeatureBindingPatch(patched);

      if (patch.status === "patched") {
        break;
      }

      patched = patchOwlFeatureBinding(patched, patch);
    }

    assertOwlFeatureBindingAfter(patched);
    return patched;
  } catch (error) {
    if (error instanceof UpstreamPatchContractError) {
      throw error;
    }

    throw new UpstreamPatchContractError(owlFeatureBindingContract.name, error.message, {
      cause: error
    });
  }
}

export function hasUnguardedOwlFeatureBindingSource(source) {
  let index = -1;

  while ((index = source.indexOf("electron_common_owl_features", index + 1)) !== -1) {
    const functionStart = source.lastIndexOf("function ", index);
    const functionEnd = source.indexOf("function ", index + 1);
    const bindingScope = source.slice(
      functionStart === -1 ? Math.max(0, index - 500) : functionStart,
      functionEnd === -1 ? Math.min(source.length, index + 1000) : functionEnd
    );

    if (!bindingScope.includes("process._linkedBinding")) {
      continue;
    }

    if (!bindingScope.includes(owlFeatureFallbackMarker)) {
      return true;
    }
  }

  return false;
}

export function hasLinuxWindowFocusableContractSource(source) {
  return Boolean(findLinuxWindowFocusablePatch(source));
}

export function hasUnguardedLinuxWindowFocusableSource(source) {
  return findLinuxWindowFocusablePatch(source)?.status === "patch";
}

export function applyUpstreamPatchContracts(source, contracts) {
  return contracts.reduce(
    (patched, contract) => applyUpstreamPatchContract(patched, contract),
    source
  );
}

export function applyUpstreamPatchContract(source, contract) {
  try {
    contract.find(source);

    try {
      contract.assertAfter(source);
      return source;
    } catch {
      // Not already patched.
    }

    contract.assertBefore(source);
    const patched = contract.apply(source);
    contract.assertAfter(patched);
    return patched;
  } catch (error) {
    if (error instanceof UpstreamPatchContractError) {
      throw error;
    }

    throw new UpstreamPatchContractError(contract.name, error.message, {
      cause: error
    });
  }
}

function applyLinuxOpenTargetsSource(source) {
  let patched = source;

  if (!patched.includes("__codexLinuxVSCode=")) {
    const openTargets = findOpenTargetRegistry(patched);
    patched = replaceOnce(
      patched,
      openTargets.anchor,
      `${linuxOpenTargetDefinitions(openTargets)};${openTargets.anchor.replace("[", "[__codexLinuxVSCode,__codexLinuxVSCodeInsiders,__codexLinuxCursor,__codexLinuxZed,__codexLinuxNvim,")}`
    );
  }

  patched = patchOpenTargetMap(patched);

  patched = patchOpenTargetPlatformLookup(patched);

  return patched;
}

async function patchOwlFeatureBindingChunks(buildDir, entries) {
  for (const entry of entries) {
    if (!entry.endsWith(".js")) {
      continue;
    }

    const bundlePath = path.join(buildDir, entry);
    const source = await fs.readFile(bundlePath, "utf8");

    if (!source.includes("electron_common_owl_features")) {
      continue;
    }

    const patched = patchLinuxOwlFeatureBindingSource(source);

    if (patched !== source) {
      await fs.writeFile(bundlePath, patched);
    }
  }
}

function findOwlFeatureBindingPatch(source) {
  const match = source.match(owlFeatureBindingRegex);

  if (match) {
    return {
      status: "patch",
      patchKind: "throwing",
      anchor: match[0],
      functionName: match[1],
      bindingVar: match[2],
      parserVar: match[3]
    };
  }

  const nullableMatch = source.match(owlNullableFeatureBindingRegex);

  if (nullableMatch) {
    return {
      status: "patch",
      patchKind: "nullable",
      anchor: nullableMatch[0],
      functionName: nullableMatch[1],
      bindingVar: nullableMatch[2],
      resultVar: nullableMatch[3],
      featureTargetVar: nullableMatch[4],
      errorVar: nullableMatch[5],
      safeErrorFunctionName: nullableMatch[6],
      parserVar: nullableMatch[7]
    };
  }

  if (source.includes("electron_common_owl_features") && source.includes(owlFeatureFallbackMarker)) {
    return { status: "patched" };
  }

  if (source.includes("electron_common_owl_features")) {
    throw new Error("Unable to apply upstream patch; missing Owl feature binding helper");
  }

  throw new Error("Unable to apply upstream patch; missing Owl feature binding helper");
}

function assertOwlFeatureBindingBefore(source) {
  const patch = findOwlFeatureBindingPatch(source);

  if (!patch || patch.status !== "patch") {
    throw new Error("missing unguarded Owl feature binding helper");
  }
}

function assertOwlFeatureBindingAfter(source) {
  if (!source.includes(owlFeatureFallbackMarker)) {
    throw new Error("missing Linux Owl feature fallback");
  }

  if (!source.includes("electron_common_owl_features")) {
    throw new Error("missing Owl feature binding target");
  }

  if (hasUnguardedOwlFeatureBindingSource(source)) {
    throw new Error("unpatched Owl feature binding helper remains");
  }
}

function patchOwlFeatureBinding(source, patch = findOwlFeatureBindingPatch(source)) {

  if (patch?.status === "patched") {
    return source;
  }

  const fallback = source.includes(owlFeatureFallbackMarker)
    ? ""
    : `function ${owlFeatureFallbackMarker}(){return{isOwlFeatureEnabled:()=>!1}}`;
  if (patch.patchKind === "nullable") {
    const replacement = [
      `function ${patch.functionName}(){let ${patch.bindingVar}=process._linkedBinding;if(typeof ${patch.bindingVar}!=\`function\`){if(process.platform===\`linux\`)return ${owlFeatureFallbackMarker}();return null}let ${patch.resultVar};try{${patch.resultVar}=${patch.bindingVar}.call(process,${patch.featureTargetVar})}catch(${patch.errorVar}){if(process.platform===\`linux\`&&(${patch.safeErrorFunctionName}(${patch.errorVar})||/electron_common_owl_features|No such binding|Owl feature binding is unavailable/.test(String(${patch.errorVar}&&${patch.errorVar}.message||${patch.errorVar}))))return ${owlFeatureFallbackMarker}();if(${patch.safeErrorFunctionName}(${patch.errorVar}))return null;throw ${patch.errorVar}}try{return ${patch.parserVar}.parse(${patch.resultVar})}catch(${patch.errorVar}){if(process.platform===\`linux\`&&/electron_common_owl_features|No such binding|Owl feature binding is unavailable/.test(String(${patch.errorVar}&&${patch.errorVar}.message||${patch.errorVar})))return ${owlFeatureFallbackMarker}();throw ${patch.errorVar}}}`,
      fallback
    ].join("");

    return replaceOnce(source, patch.anchor, replacement);
  }

  const replacement = [
    `function ${patch.functionName}(){let ${patch.bindingVar}=process._linkedBinding;if(typeof ${patch.bindingVar}!=\`function\`){if(process.platform===\`linux\`)return ${owlFeatureFallbackMarker}();throw Error(\`Owl feature binding is unavailable\`)}try{return ${patch.parserVar}.parse(${patch.bindingVar}.call(process,\`electron_common_owl_features\`))}catch(e){if(process.platform===\`linux\`&&/electron_common_owl_features|No such binding|Owl feature binding is unavailable/.test(String(e&&e.message||e)))return ${owlFeatureFallbackMarker}();throw e}}`,
    fallback
  ].join("");

  return replaceOnce(source, patch.anchor, replacement);
}

function assertOpenTargetsBefore(source) {
  findOpenTargetRegistry(source);
  findOpenCommandName(source);

  if (!source.includes("appPath:process.platform===`linux`") && !openTargetMapRegex.test(source)) {
    throw new Error("missing open target map");
  }
}

function assertOpenTargetsAfter(source) {
  if (!source.includes("__codexLinuxVSCode=")) {
    throw new Error("missing Linux open target definitions");
  }

  if (!source.includes("appPath:process.platform===`linux`")) {
    throw new Error("missing Linux appPath target metadata");
  }

  if (source.includes("let n=t.platforms[e];return n")) {
    throw new Error("open target platform lookup is not null-safe");
  }
}

function patchLinuxWindowBackground(source) {
  const patch = findLinuxWindowBackgroundPatch(source);

  if (patch?.status === "patched") {
    return source;
  }

  if (!patch) {
    throw new Error("Unable to apply upstream patch; missing window background helper");
  }

  return `${source.slice(0, patch.start)}${patch.replacement}${source.slice(patch.end)}`;
}

function findLinuxWindowBackgroundPatch(source) {
  const ast = parseJavaScript(source);
  const candidates = [];
  let patchedCandidates = 0;

  walkAst(ast, node => {
    if (!isFunctionNode(node)) {
      return;
    }

    const patch = linuxWindowBackgroundPatchForFunction(source, node);

    if (patch?.status === "patched") {
      patchedCandidates++;
      return;
    }

    if (patch) {
      candidates.push(patch);
    }
  });

  if (candidates.length > 1) {
    throw new Error("Unable to apply upstream patch; ambiguous window background helper");
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (patchedCandidates > 0) {
    return { status: "patched" };
  }

  return null;
}

function assertLinuxWindowBackgroundBefore(source) {
  const patch = findLinuxWindowBackgroundPatch(source);

  if (!patch || patch.status !== "patch") {
    throw new Error("missing window background helper");
  }
}

function assertLinuxWindowBackgroundAfter(source) {
  const patch = findLinuxWindowBackgroundPatch(source);

  if (!patch || patch.status !== "patched") {
    throw new Error("Linux window background assertion failed");
  }
}

function linuxWindowBackgroundPatchForFunction(source, node) {
  const bindings = objectPatternBindings(node.params[0]);
  const platformVar = bindings.platform;
  const prefersDarkVar = bindings.prefersDarkColors;

  if (
    !platformVar ||
    !bindings.appearance ||
    !prefersDarkVar ||
    !(bindings.opaqueWindowsEnabled || bindings.opaqueWindowSurfaceEnabled)
  ) {
    return null;
  }

  const returnExpression = returnExpressionForFunction(node);

  if (!returnExpression) {
    return null;
  }

  const objects = [];
  walkAst(returnExpression, child => {
    if (child.type === "ObjectExpression") {
      objects.push(child);
    }
  });

  const palette = objects.map(object => backgroundPaletteForObject(object, platformVar, prefersDarkVar)).find(Boolean);

  if (!palette) {
    return null;
  }

  for (const object of objects) {
    const backgroundColor = getObjectProperty(object, "backgroundColor");
    const backgroundMaterial = getObjectProperty(object, "backgroundMaterial");

    if (!backgroundColor || !backgroundMaterial || !isNullLiteral(backgroundMaterial.value)) {
      continue;
    }

    if (isLinuxConditional(backgroundColor.value, platformVar)) {
      return { status: "patched" };
    }

    const fallbackSource = source.slice(backgroundColor.value.start, backgroundColor.value.end);
    const darkSource = source.slice(palette.dark.start, palette.dark.end);
    const lightSource = source.slice(palette.light.start, palette.light.end);

    return {
      status: "patch",
      start: backgroundColor.value.start,
      end: backgroundColor.value.end,
      replacement: `${platformVar}===\`linux\`?(${prefersDarkVar}?${darkSource}:${lightSource}):${fallbackSource}`
    };
  }

  return null;
}

function backgroundPaletteForObject(object, platformVar, prefersDarkVar) {
  const backgroundColor = getObjectProperty(object, "backgroundColor");
  const backgroundMaterial = getObjectProperty(object, "backgroundMaterial");

  if (
    !backgroundColor ||
    !backgroundMaterial ||
    backgroundColor.value.type !== "ConditionalExpression" ||
    !isIdentifierNamed(backgroundColor.value.test, prefersDarkVar) ||
    !isWin32BackgroundMaterial(backgroundMaterial.value, platformVar)
  ) {
    return null;
  }

  return {
    dark: backgroundColor.value.consequent,
    light: backgroundColor.value.alternate
  };
}

function patchLinuxWindowFocusable(source) {
  const patch = findLinuxWindowFocusablePatch(source);

  if (patch?.status === "patched") {
    return source;
  }

  if (!patch) {
    throw new Error("Unable to apply upstream patch; missing BrowserWindow focusable option");
  }

  return `${source.slice(0, patch.start)}${patch.replacement}${source.slice(patch.end)}`;
}

function findLinuxWindowFocusablePatch(source) {
  const ast = parseJavaScript(source);
  const candidates = [];
  let patchedCandidates = 0;

  walkAst(ast, node => {
    if (!isFunctionNode(node)) {
      return;
    }

    const bindings = focusableBindingsForFunction(node);

    if (bindings.size === 0 || !node.body) {
      return;
    }

    walkAstSkippingNested(node.body, child => {
      if (child.type !== "NewExpression" || !isMemberPropertyNamed(child.callee, "BrowserWindow")) {
        return;
      }

      const options = child.arguments[0];

      if (options?.type !== "ObjectExpression") {
        return;
      }

      for (const bindingName of bindings) {
        const patch = linuxWindowFocusablePatchForObject(options, bindingName);

        if (patch?.status === "patched") {
          patchedCandidates++;
          return;
        }

        if (patch) {
          candidates.push(patch);
          return;
        }
      }
    });
  });

  if (candidates.length > 1) {
    throw new Error("Unable to apply upstream patch; ambiguous BrowserWindow focusable option");
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (patchedCandidates > 0) {
    return { status: "patched" };
  }

  return null;
}

function assertLinuxWindowFocusableBefore(source) {
  const patch = findLinuxWindowFocusablePatch(source);

  if (!patch || patch.status !== "patch") {
    throw new Error("missing unguarded BrowserWindow focusable option");
  }
}

function assertLinuxWindowFocusableAfter(source) {
  const patch = findLinuxWindowFocusablePatch(source);

  if (!patch || patch.status !== "patched") {
    throw new Error("Linux BrowserWindow focusable assertion failed");
  }
}

function focusableBindingsForFunction(node) {
  const bindings = new Set();

  for (const param of node.params || []) {
    const binding = objectPatternBindings(param).focusable;

    if (binding) {
      bindings.add(binding);
    }
  }

  if (!node.body) {
    return bindings;
  }

  walkAstSkippingNested(node.body, child => {
    if (child.type !== "VariableDeclarator") {
      return;
    }

    const binding = objectPatternBindings(child.id).focusable;

    if (binding) {
      bindings.add(binding);
    }
  });

  return bindings;
}

function linuxWindowFocusablePatchForObject(object, bindingName) {
  const property = getObjectProperty(object, "focusable");

  if (property) {
    if (isFocusableDefaultPatched(property.value, bindingName)) {
      return { status: "patched" };
    }

    if (isIdentifierNamed(property.value, bindingName)) {
      return {
        status: "patch",
        start: property.value.start,
        end: property.value.end,
        replacement: `${bindingName}??!0`
      };
    }

    return null;
  }

  if (hasSafeFocusableSpread(object, bindingName)) {
    return { status: "patched" };
  }

  return null;
}

function hasSafeFocusableSpread(object, bindingName) {
  return object.properties.some(property =>
    property.type === "SpreadElement" &&
    isSafeFocusableConditional(property.argument, bindingName)
  );
}

function isSafeFocusableConditional(node, bindingName) {
  if (node?.type !== "ConditionalExpression") {
    return false;
  }

  if (isNullishCheck(node.test, bindingName)) {
    return isEmptyObjectExpression(node.consequent) &&
      isFocusableObjectForBinding(node.alternate, bindingName);
  }

  if (isNotNullishCheck(node.test, bindingName)) {
    return isFocusableObjectForBinding(node.consequent, bindingName) &&
      isEmptyObjectExpression(node.alternate);
  }

  return false;
}

function isFocusableObjectForBinding(node, bindingName) {
  if (node?.type !== "ObjectExpression") {
    return false;
  }

  const property = getObjectProperty(node, "focusable");

  return Boolean(property && isIdentifierNamed(property.value, bindingName));
}

function isFocusableDefaultPatched(node, bindingName) {
  return (
    node?.type === "LogicalExpression" &&
    node.operator === "??" &&
    isIdentifierNamed(node.left, bindingName) &&
    isTrueExpression(node.right)
  );
}

function isNullishCheck(node, bindingName) {
  return isNullishBinaryExpression(node, bindingName, ["==", "==="]);
}

function isNotNullishCheck(node, bindingName) {
  return isNullishBinaryExpression(node, bindingName, ["!=", "!=="]);
}

function isNullishBinaryExpression(node, bindingName, operators) {
  if (node?.type !== "BinaryExpression" || !operators.includes(node.operator)) {
    return false;
  }

  return (
    (isIdentifierNamed(node.left, bindingName) && isNullishExpression(node.right)) ||
    (isNullishExpression(node.left) && isIdentifierNamed(node.right, bindingName))
  );
}

function isNullishExpression(node) {
  return isNullLiteral(node) || isVoidZeroExpression(node);
}

function isVoidZeroExpression(node) {
  return (
    node?.type === "UnaryExpression" &&
    node.operator === "void" &&
    node.argument.type === "Literal" &&
    node.argument.value === 0
  );
}

function isEmptyObjectExpression(node) {
  return node?.type === "ObjectExpression" && node.properties.length === 0;
}

function isTrueExpression(node) {
  return (
    node?.type === "Literal" && node.value === true
  ) || (
    node?.type === "UnaryExpression" &&
    node.operator === "!" &&
    node.argument.type === "Literal" &&
    (node.argument.value === 0 || node.argument.value === false)
  );
}

function parseJavaScript(source) {
  try {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowHashBang: true
    });
  } catch {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true
    });
  }
}

function walkAst(root, visit) {
  const stack = [root];

  while (stack.length > 0) {
    const node = stack.pop();

    if (!isNode(node)) {
      continue;
    }

    visit(node);

    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range") {
        continue;
      }

      const value = node[key];

      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
          if (isNode(value[index])) {
            stack.push(value[index]);
          }
        }
      } else if (isNode(value)) {
        stack.push(value);
      }
    }
  }
}

function walkAstSkippingNested(root, visit) {
  const stack = [root];

  while (stack.length > 0) {
    const node = stack.pop();

    if (!isNode(node) || (node !== root && isFunctionNode(node))) {
      continue;
    }

    visit(node);

    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc" || key === "range") {
        continue;
      }

      const value = node[key];

      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
          if (isNode(value[index])) {
            stack.push(value[index]);
          }
        }
      } else if (isNode(value)) {
        stack.push(value);
      }
    }
  }
}

function isNode(value) {
  return Boolean(value && typeof value.type === "string");
}

function isFunctionNode(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function objectPatternBindings(pattern) {
  if (pattern?.type !== "ObjectPattern") {
    return {};
  }

  const bindings = {};

  for (const property of pattern.properties) {
    if (property.type !== "Property" || property.computed) {
      continue;
    }

    const key = propertyName(property.key);
    const local = patternLocalName(property.value);

    if (key && local) {
      bindings[key] = local;
    }
  }

  return bindings;
}

function patternLocalName(value) {
  if (value.type === "Identifier") {
    return value.name;
  }

  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }

  return null;
}

function returnExpressionForFunction(node) {
  if (node.type === "ArrowFunctionExpression" && node.expression) {
    return node.body;
  }

  if (node.body?.type !== "BlockStatement") {
    return null;
  }

  return node.body.body.find(statement => statement.type === "ReturnStatement")?.argument ?? null;
}

function getObjectProperty(object, name) {
  return object.properties.find(property => {
    if (property.type !== "Property" || property.computed) {
      return false;
    }

    return propertyName(property.key) === name;
  });
}

function isMemberPropertyNamed(node, name) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    propertyName(node.property) === name
  );
}

function propertyName(key) {
  if (key.type === "Identifier") {
    return key.name;
  }

  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }

  return null;
}

function isNullLiteral(node) {
  return node.type === "Literal" && node.value === null;
}

function isIdentifierNamed(node, name) {
  return node.type === "Identifier" && node.name === name;
}

function isWin32BackgroundMaterial(node, platformVar) {
  return (
    node.type === "ConditionalExpression" &&
    isPlatformEquals(node.test, platformVar, "win32") &&
    isStringLiteral(node.consequent, "none") &&
    isNullLiteral(node.alternate)
  );
}

function isLinuxConditional(node, platformVar) {
  return node.type === "ConditionalExpression" && isPlatformEquals(node.test, platformVar, "linux");
}

function isPlatformEquals(node, platformVar, platform) {
  return (
    node.type === "BinaryExpression" &&
    node.operator === "===" &&
    ((isIdentifierNamed(node.left, platformVar) && isStringLiteral(node.right, platform)) ||
      (isStringLiteral(node.left, platform) && isIdentifierNamed(node.right, platformVar)))
  );
}

function isStringLiteral(node, value) {
  if (node.type === "Literal") {
    return node.value === value;
  }

  return (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1 &&
    node.quasis[0].value.cooked === value
  );
}

function patchLinuxWindowTransparency(source) {
  if (linuxTransparencyPatchedRegex.test(source)) {
    return source;
  }

  const match = source.match(linuxTransparencyPatchRegex);

  if (!match) {
    throw new Error("Unable to apply upstream patch; missing window transparency helper");
  }

  const [anchor, , , shadowVar, platformVar, , , transparentVar] = match;
  const replacement = anchor.replace(
    `transparent:${transparentVar},hasShadow:${shadowVar},`,
    `transparent:${platformVar}===\`linux\`?!1:${transparentVar},hasShadow:${shadowVar},`
  );

  return replaceOnce(source, anchor, replacement);
}

function findLinuxWindowTransparencyPatch(source) {
  if (linuxTransparencyPatchedRegex.test(source)) {
    return { status: "patched" };
  }

  const match = source.match(linuxTransparencyPatchRegex);

  if (!match) {
    return null;
  }

  return { status: "patch", match };
}

function assertLinuxWindowTransparencyBefore(source) {
  const patch = findLinuxWindowTransparencyPatch(source);

  if (!patch || patch.status !== "patch") {
    throw new Error("missing window transparency helper");
  }
}

function assertLinuxWindowTransparencyAfter(source) {
  const patch = findLinuxWindowTransparencyPatch(source);

  if (!patch || patch.status !== "patched") {
    throw new Error("Linux window transparency assertion failed");
  }
}

function patchOpenTargetMap(source) {
  if (source.includes("appPath:process.platform===`linux`")) {
    return source;
  }

  const match = source.match(openTargetMapRegex);

  if (!match) {
    throw new Error("Unable to apply upstream patch; missing open target map");
  }

  const [
    anchor,
    targetsVar,
    idVar,
    labelVar,
    iconVar,
    kindVar,
    hiddenVar,
    availableSetVar,
    defaultTargetVar,
    extraTargetsVar
  ] = match;

  const patchedMap =
    `targets:[...${targetsVar}.map(({id:${idVar},label:${labelVar},icon:${iconVar},kind:${kindVar},hidden:${hiddenVar}})=>({` +
    `id:${idVar},target:${idVar},label:${labelVar},icon:${iconVar},kind:${kindVar},hidden:${hiddenVar},` +
    `appPath:process.platform===\`linux\`&&${kindVar}===\`editor\`&&${availableSetVar}.has(${idVar})?Ld().get(${idVar})??null:null,` +
    `available:${availableSetVar}.has(${idVar}),default:${defaultTargetVar}===${idVar}||void 0})),...${extraTargetsVar}]`;

  return replaceOnce(source, anchor, patchedMap);
}

function patchOpenTargetPlatformLookup(source) {
  return source.replaceAll(
    "let n=t.platforms[e];return n",
    "let n=t.platforms?.[e];return n"
  );
}

function findOpenTargetRegistry(source) {
  const match = source.match(
    /var ([A-Za-z_$][\w$]*)=\[[^\]]+\](?:,[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(`open-in-targets`\)|\s*;[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(`open-in-targets`\));\s*function [A-Za-z_$][\w$]*\(e\)\{return \1\.flatMap/
  );

  if (!match) {
    throw new Error("Unable to apply upstream patch; missing open target registry");
  }

  const anchor = source.slice(match.index, source.indexOf("]", match.index) + 1);

  return {
    anchor,
    openCommandName: findOpenCommandName(source),
    executableResolverName: findOpenExecutableResolverName(source)
  };
}

function findOpenExecutableResolverName(source) {
  const resolverMatch = source.match(
    /function ([A-Za-z_$][\w$]*)\(e\)\{let [A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.default\.sync\(e,\{nothrow:!0\}\);return typeof [A-Za-z_$][\w$]*==`string`&&/
  );

  if (resolverMatch) {
    return resolverMatch[1];
  }

  const targetDetectMatch = source.match(
    /([A-Za-z_$][\w$]*)\(`(?:code|code-insiders|cursor|zed|nvim)`\)/
  );

  if (targetDetectMatch) {
    return targetDetectMatch[1];
  }

  throw new Error("Unable to apply upstream patch; missing open target executable resolver");
}

function findOpenCommandName(source) {
  const openDispatcherName = findOpenCommandNameFromDispatcher(source);

  if (openDispatcherName) {
    return openDispatcherName;
  }

  const match = source.match(
    /await ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\.args\([^)]*\),\{env:[A-Za-z_$][\w$]*\.env\?\.\(\)\}\)/
  );

  if (!match) {
    throw new Error("Unable to apply upstream patch; missing open command runner");
  }

  return match[1];
}

function findOpenCommandNameFromDispatcher(source) {
  const ast = parseJavaScript(source);
  const names = new Set();

  walkAst(ast, node => {
    if (!isFunctionNode(node)) {
      return;
    }

    const body = source.slice(node.start, node.end);

    if (
      !body.includes("Unknown open target") ||
      !body.includes("Open target") ||
      !body.includes(".args(")
    ) {
      return;
    }

    const match = body.match(
      /await ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\.args\([^)]*\)(?:,\{env:[A-Za-z_$][\w$]*\.env\?\.\(\)\})?\)/
    );

    if (match) {
      names.add(match[1]);
    }
  });

  if (names.size > 1) {
    throw new Error("Unable to apply upstream patch; ambiguous open command runner");
  }

  return names.values().next().value ?? null;
}

function replaceOnce(source, search, replacement) {
  const index = source.indexOf(search);

  if (index === -1) {
    throw new Error(`Unable to apply upstream patch; missing anchor: ${search.slice(0, 80)}`);
  }

  if (source.indexOf(search, index + search.length) !== -1) {
    throw new Error(`Unable to apply upstream patch; ambiguous anchor: ${search.slice(0, 80)}`);
  }

  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}
