import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "acorn";

const linuxOpenTargetDefinitions = openCommandName => [
  "var __codexLinuxOpenTargetGotoArgs=(e,t)=>t?[`--goto`,`${e}:${t.line}:${t.column}`]:[e]",
  "__codexLinuxOpenTargetColonArgs=(e,t)=>t?[`${e}:${t.line}:${t.column}`]:[e]",
  "__codexLinuxOpenTargetTerminal=()=>{let e=process.env.TERMINAL?.trim();if(e&&W(e))return{command:W(e),args:e=>[`-e`,process.env.SHELL?.trim()||`/bin/sh`,`-lc`,e]};for(let e of [[`ghostty`,e=>[`-e`,process.env.SHELL?.trim()||`/bin/sh`,`-lc`,e]],[`kitty`,e=>[`-e`,process.env.SHELL?.trim()||`/bin/sh`,`-lc`,e]],[`alacritty`,e=>[`-e`,process.env.SHELL?.trim()||`/bin/sh`,`-lc`,e]],[`wezterm`,e=>[`start`,`--`,process.env.SHELL?.trim()||`/bin/sh`,`-lc`,e]],[`gnome-terminal`,e=>[`--`,process.env.SHELL?.trim()||`/bin/sh`,`-lc`,e]],[`konsole`,e=>[`-e`,process.env.SHELL?.trim()||`/bin/sh`,`-lc`,e]],[`xterm`,e=>[`-e`,process.env.SHELL?.trim()||`/bin/sh`,`-lc`,e]]]){let t=W(e[0]);if(t)return{command:t,args:e[1]}}return null}",
  "__codexLinuxOpenTargetNvimArgs=(e,t)=>t?[`+call cursor(${t.line},${t.column})`,e]:[e]",
  "__codexLinuxOpenTargetNvimCommand=(e,n,r)=>`${t.En(e)} ${t.Tn(__codexLinuxOpenTargetNvimArgs(n,r))}`",
  `__codexLinuxOpenTargetRunNvim=async({command:e,path:t,location:n})=>{let r=__codexLinuxOpenTargetTerminal();if(!r)throw Error(\`No terminal emulator found for Neovim\`);await ${openCommandName}(r.command,r.args(__codexLinuxOpenTargetNvimCommand(e,t,n)))}`,
  "__codexLinuxVSCode={id:`vscode`,platforms:{linux:{label:`VS Code`,icon:`apps/vscode.png`,kind:`editor`,detect:()=>W(`code`),args:__codexLinuxOpenTargetGotoArgs}}}",
  "__codexLinuxVSCodeInsiders={id:`vscodeInsiders`,platforms:{linux:{label:`VS Code Insiders`,icon:`apps/vscode-insiders.png`,kind:`editor`,detect:()=>W(`code-insiders`),args:__codexLinuxOpenTargetGotoArgs}}}",
  "__codexLinuxCursor={id:`cursor`,platforms:{linux:{label:`Cursor`,icon:`apps/cursor.png`,kind:`editor`,detect:()=>W(`cursor`),args:__codexLinuxOpenTargetGotoArgs}}}",
  "__codexLinuxZed={id:`zed`,platforms:{linux:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:()=>W(`zed`),args:__codexLinuxOpenTargetColonArgs}}}",
  "__codexLinuxNvim={id:`nvim`,platforms:{linux:{label:`Neovim`,icon:`apps/terminal.png`,kind:`editor`,detect:()=>W(`nvim`),args:__codexLinuxOpenTargetNvimArgs,open:__codexLinuxOpenTargetRunNvim}}}"
].join(",");
const openTargetMapRegex =
  /targets:\[\.\.\.([A-Za-z_$][\w$]*)\.map\(\(\{id:([A-Za-z_$][\w$]*),label:([A-Za-z_$][\w$]*),icon:([A-Za-z_$][\w$]*),kind:([A-Za-z_$][\w$]*),hidden:([A-Za-z_$][\w$]*)\}\)=>\(\{id:\2,target:\2,label:\3,icon:\4,kind:\5,hidden:\6,available:([A-Za-z_$][\w$]*)\.has\(\2\),default:([A-Za-z_$][\w$]*)===\2\|\|void 0\}\)\),\.\.\.([A-Za-z_$][\w$]*)\]/;
const linuxTransparencyPatchedRegex =
  /transparent:[A-Za-z_$][\w$]*===`linux`\?!1:[A-Za-z_$][\w$]*,hasShadow:/;
const linuxTransparencyPatchRegex =
  /function ([A-Za-z_$][\w$]*)\(\{alwaysOnTop:([A-Za-z_$][\w$]*),hasShadow:([A-Za-z_$][\w$]*)=!0,platform:([A-Za-z_$][\w$]*),resizable:([A-Za-z_$][\w$]*),thickFrame:([A-Za-z_$][\w$]*),transparent:([A-Za-z_$][\w$]*)=!0\}\)\{return\{frame:!1,transparent:\7,hasShadow:\3,/;
const owlFeatureBindingRegex =
  /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=process\._linkedBinding;if\(typeof \2!=`function`\)throw Error\(`Owl feature binding is unavailable`\);return ([A-Za-z_$][\w$]*)\.parse\(\2\.call\(process,`electron_common_owl_features`\)\)\}/;
const owlFeatureFallbackMarker = "__codexLinuxOwlFeatureFallback";
const dynamicToolSchemaContractMarker = "__codexLinuxDynamicToolSchemaContract";
const dynamicToolStartResponseMarker = "__codexLinuxNormalizeDynamicToolsForThreadStart";
const dynamicToolThreadStartRequestMarker = "__codexLinuxNormalizeThreadStartRequestParams";
const dynamicToolThreadStartBridgeMarker = "__codexLinuxNormalizeThreadStartBridgeRequest";

export class UpstreamPatchContractError extends Error {
  constructor(contractName, message, options = {}) {
    super(`${contractName} contract changed: ${message}`, {
      cause: options.cause
    });
    this.name = "UpstreamPatchContractError";
    this.contractName = contractName;
  }
}

export const dynamicToolStartResponseContract = {
  name: "dynamic-tool-start-response",
  find: findDynamicToolStartResponsePatch,
  assertBefore: assertDynamicToolStartResponseBefore,
  apply: patchDynamicToolStartResponse,
  assertAfter: assertDynamicToolStartResponseAfter
};

export const dynamicToolThreadStartBridgeContract = {
  name: "dynamic-tool-thread-start-bridge",
  find: findDynamicToolThreadStartBridgePatch,
  assertBefore: assertDynamicToolThreadStartBridgeBefore,
  apply: patchDynamicToolThreadStartBridge,
  assertAfter: assertDynamicToolThreadStartBridgeAfter
};

export const upstreamPatchContracts = [
  // Why: upstream can return runtime-built dynamic tools from the renderer
  // just before thread creation. App-server rejects any function tool without
  // inputSchema, so Linux normalizes the final Electron response boundary.
  // Contract: the main bundle still resolves dynamic-tools-for-thread-start
  // responses through handleDynamicToolsForThreadStartResponse.
  dynamicToolStartResponseContract,
  // Why: local desktop thread creation can bypass the renderer request client
  // and enter Electron through host-command handlers. App-server still rejects
  // malformed dynamic tool schemas there, so Linux normalizes the final bridge
  // request before stdio transport. Contract: the main bundle still forwards
  // mcp-request and thread-prewarm-start through handleClientRequest and
  // handlePrewarmThreadStart.
  dynamicToolThreadStartBridgeContract,
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
  }
];

export const owlFeatureBindingContract = {
  name: "owl-feature-binding",
  find: findOwlFeatureBindingPatch,
  assertBefore: assertOwlFeatureBindingBefore,
  apply: patchOwlFeatureBinding,
  assertAfter: assertOwlFeatureBindingAfter
};

export const dynamicToolSchemaContract = {
  name: "dynamic-tool-schema-contract",
  find: findDynamicToolSchemaContractPatch,
  assertBefore: assertDynamicToolSchemaContractBefore,
  apply: patchDynamicToolSchemaContract,
  assertAfter: assertDynamicToolSchemaContractAfter
};

export const dynamicToolThreadStartRequestContract = {
  name: "dynamic-tool-thread-start-request",
  find: findDynamicToolThreadStartRequestPatch,
  assertBefore: assertDynamicToolThreadStartRequestBefore,
  apply: patchDynamicToolThreadStartRequest,
  assertAfter: assertDynamicToolThreadStartRequestAfter
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
    await patchDynamicToolSchemaContractChunks(stageAppDir);
    await patchDynamicToolThreadStartRequestChunks(stageAppDir);
    return;
  }

  await fs.writeFile(mainBundlePath, patched);
  await patchOwlFeatureBindingChunks(buildDir, entries);
  await patchDynamicToolSchemaContractChunks(stageAppDir);
  await patchDynamicToolThreadStartRequestChunks(stageAppDir);
}

export function patchUpstreamMainSource(source) {
  return applyUpstreamPatchContracts(source, upstreamPatchContracts);
}

export function patchDynamicToolStartResponseSource(source) {
  return applyUpstreamPatchContract(source, dynamicToolStartResponseContract);
}

export function patchLinuxOpenTargetsSource(source) {
  return applyUpstreamPatchContract(source, upstreamPatchContracts[2]);
}

export function patchDisableTransparencySource(source) {
  return applyUpstreamPatchContracts(source, upstreamPatchContracts.slice(3));
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

export function patchDynamicToolSchemaContractSource(source) {
  return applyUpstreamPatchContract(source, dynamicToolSchemaContract);
}

export function patchDynamicToolThreadStartRequestSource(source) {
  return applyUpstreamPatchContract(source, dynamicToolThreadStartRequestContract);
}

export function patchDynamicToolThreadStartBridgeSource(source) {
  return applyUpstreamPatchContract(source, dynamicToolThreadStartBridgeContract);
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

    if (!bindingScope.includes(owlFeatureFallbackMarker)) {
      return true;
    }
  }

  return false;
}

export function hasUnguardedDynamicToolSchemaContractSource(source) {
  const patch = findDynamicToolSchemaContractPatch(source);

  return patch.status === "patch";
}

export function hasUnguardedDynamicToolStartResponseSource(source) {
  const patch = findDynamicToolStartResponsePatch(source);

  return patch.status === "patch";
}

export function hasUnguardedDynamicToolThreadStartRequestSource(source) {
  const patch = findDynamicToolThreadStartRequestPatch(source);

  return patch.status === "patch";
}

export function hasUnguardedDynamicToolThreadStartBridgeSource(source) {
  const patch = findDynamicToolThreadStartBridgePatch(source);

  return patch.status === "patch";
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
      `${linuxOpenTargetDefinitions(openTargets.openCommandName)};${openTargets.anchor.replace("[", "[__codexLinuxVSCode,__codexLinuxVSCodeInsiders,__codexLinuxCursor,__codexLinuxZed,__codexLinuxNvim,")}`
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

async function patchDynamicToolSchemaContractChunks(stageAppDir) {
  const assetsDir = path.join(stageAppDir, "webview", "assets");
  let entries;

  try {
    entries = await fs.readdir(assetsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new UpstreamPatchContractError(
        dynamicToolSchemaContract.name,
        `missing webview assets directory: ${assetsDir}`,
        { cause: error }
      );
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".js")) {
      continue;
    }

    const bundlePath = path.join(assetsDir, entry);
    const source = await fs.readFile(bundlePath, "utf8");

    if (!source.includes("Tools provided by the Codex app.") || !source.includes("deferLoading")) {
      continue;
    }

    const patched = patchDynamicToolSchemaContractSource(source);

    if (patched !== source) {
      await fs.writeFile(bundlePath, patched);
    }
  }
}

async function patchDynamicToolThreadStartRequestChunks(stageAppDir) {
  const assetsDir = path.join(stageAppDir, "webview", "assets");
  let entries;

  try {
    entries = await fs.readdir(assetsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new UpstreamPatchContractError(
        dynamicToolThreadStartRequestContract.name,
        `missing webview assets directory: ${assetsDir}`,
        { cause: error }
      );
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".js")) {
      continue;
    }

    const bundlePath = path.join(assetsDir, entry);
    const source = await fs.readFile(bundlePath, "utf8");

    if (!source.includes("mcp_request_enqueued") || !source.includes("thread/start")) {
      continue;
    }

    const patched = patchDynamicToolThreadStartRequestSource(source);

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
      anchor: match[0],
      functionName: match[1],
      bindingVar: match[2],
      parserVar: match[3]
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

function findDynamicToolStartResponsePatch(source) {
  const patches = findDynamicToolStartResponsePatches(source);

  if (patches.length > 0) {
    return {
      status: "patch",
      patches
    };
  }

  if (
    source.includes(dynamicToolStartResponseMarker) &&
    source.includes("handleDynamicToolsForThreadStartResponse")
  ) {
    return { status: "patched" };
  }

  if (source.includes("handleDynamicToolsForThreadStartResponse")) {
    throw new Error("Unable to apply upstream patch; missing dynamic tool start response resolver");
  }

  throw new Error("Unable to apply upstream patch; missing dynamic tool start response resolver");
}

function findDynamicToolStartResponsePatches(source) {
  const ast = parseJavaScript(source);
  const patches = [];

  walkAst(ast, node => {
    if (
      node.type !== "MethodDefinition" ||
      propertyName(node.key) !== "handleDynamicToolsForThreadStartResponse"
    ) {
      return;
    }

    const responseParam = node.value?.params?.[1];

    if (responseParam?.type !== "Identifier") {
      return;
    }

    walkAst(node.value.body, child => {
      if (
        child.type !== "CallExpression" ||
        !isMemberPropertyNamed(child.callee, "resolve") ||
        child.arguments.length !== 1 ||
        !isMemberExpressionNamed(child.arguments[0], responseParam.name, "dynamicTools")
      ) {
        return;
      }

      patches.push({
        argumentStart: child.arguments[0].start,
        argumentEnd: child.arguments[0].end
      });
    });
  });

  if (patches.length > 1) {
    throw new Error("Unable to apply upstream patch; ambiguous dynamic tool start response resolver");
  }

  return patches;
}

function assertDynamicToolStartResponseBefore(source) {
  const patch = findDynamicToolStartResponsePatch(source);

  if (!patch || patch.status !== "patch") {
    throw new Error("missing unguarded dynamic tool start response resolver");
  }
}

function assertDynamicToolStartResponseAfter(source) {
  if (!source.includes(dynamicToolStartResponseMarker)) {
    throw new Error("missing dynamic tool start response normalizer");
  }

  if (!source.includes("handleDynamicToolsForThreadStartResponse")) {
    throw new Error("missing dynamic tool start response handler");
  }

  if (hasUnguardedDynamicToolStartResponseSource(source)) {
    throw new Error("unguarded dynamic tool start response resolver remains");
  }
}

function patchDynamicToolStartResponse(source, patch = findDynamicToolStartResponsePatch(source)) {
  if (patch?.status === "patched") {
    return source;
  }

  const helper = source.includes(dynamicToolStartResponseMarker)
    ? ""
    : [
        `function ${dynamicToolStartResponseMarker}(e){if(!Array.isArray(e))return[];return e.map(e=>{if(e?.type!==\`namespace\`||!Array.isArray(e.tools))return e;let t=e.tools.flatMap(e=>{if(e?.type!==\`function\`)return[e];if(e.inputSchema!=null)return[e];if(e.input_schema!=null)return[{...e,inputSchema:e.input_schema}];if(e.parameters!=null)return[{...e,inputSchema:e.parameters}];return[]});return{...e,tools:t}})}`
      ].join("");
  const replacements = patch.patches.map(target => {
    const argumentSource = source.slice(target.argumentStart, target.argumentEnd);

    return {
      start: target.argumentStart,
      end: target.argumentEnd,
      replacement: `${dynamicToolStartResponseMarker}(${argumentSource})`
    };
  });

  replacements.sort((left, right) => right.start - left.start);

  let patched = source;
  for (const replacement of replacements) {
    patched = `${patched.slice(0, replacement.start)}${replacement.replacement}${patched.slice(replacement.end)}`;
  }

  return helper ? `${patched}\n${helper}` : patched;
}

function findDynamicToolThreadStartBridgePatch(source) {
  const patches = findDynamicToolThreadStartBridgePatches(source);

  if (patches.length > 0) {
    return {
      status: "patch",
      patches
    };
  }

  if (
    source.includes(dynamicToolThreadStartBridgeMarker) &&
    source.includes("handleClientRequest") &&
    source.includes("handlePrewarmThreadStart")
  ) {
    return { status: "patched" };
  }

  if (source.includes("handleClientRequest") || source.includes("handlePrewarmThreadStart")) {
    throw new Error("Unable to apply upstream patch; missing thread/start bridge request forwarding");
  }

  throw new Error("Unable to apply upstream patch; missing thread/start bridge request forwarding");
}

function findDynamicToolThreadStartBridgePatches(source) {
  const ast = parseJavaScript(source);
  const patches = [];

  walkAst(ast, node => {
    if (
      node.type !== "CallExpression" ||
      (
        !isMemberPropertyNamed(node.callee, "handleClientRequest") &&
        !isMemberPropertyNamed(node.callee, "handlePrewarmThreadStart")
      )
    ) {
      return;
    }

    const requestArg = node.arguments[1];

    if (!requestArg || isCallToIdentifier(requestArg, dynamicToolThreadStartBridgeMarker)) {
      return;
    }

    patches.push({
      requestStart: requestArg.start,
      requestEnd: requestArg.end
    });
  });

  return patches;
}

function assertDynamicToolThreadStartBridgeBefore(source) {
  const patch = findDynamicToolThreadStartBridgePatch(source);

  if (!patch || patch.status !== "patch") {
    throw new Error("missing unguarded thread/start bridge request");
  }
}

function assertDynamicToolThreadStartBridgeAfter(source) {
  if (!source.includes(dynamicToolThreadStartBridgeMarker)) {
    throw new Error("missing thread/start bridge request normalizer");
  }

  if (!source.includes("handleClientRequest") || !source.includes("handlePrewarmThreadStart")) {
    throw new Error("missing app-server bridge request forwarding");
  }

  if (hasUnguardedDynamicToolThreadStartBridgeSource(source)) {
    throw new Error("unguarded thread/start bridge request forwarding remains");
  }
}

function patchDynamicToolThreadStartBridge(source, patch = findDynamicToolThreadStartBridgePatch(source)) {
  if (patch?.status === "patched") {
    return source;
  }

  const helper = source.includes(dynamicToolThreadStartBridgeMarker)
    ? ""
    : [
        `function ${dynamicToolThreadStartBridgeMarker}(e){if(e?.method!==\`thread/start\`||e.params==null)return e;let t=__codexLinuxNormalizeThreadStartBridgeValue(e.params);return{...e,params:{...t,...Array.isArray(t.dynamicTools)?{dynamicTools:t.dynamicTools.flatMap(e=>__codexLinuxNormalizeThreadStartBridgeDynamicTool(e))}:{}}}}`,
        `function __codexLinuxNormalizeThreadStartBridgeValue(e){if(Array.isArray(e))return e.map(__codexLinuxNormalizeThreadStartBridgeValue);if(e==null||typeof e!==\`object\`)return e;let t={...e};for(let n of Object.keys(t))t[n]=__codexLinuxNormalizeThreadStartBridgeValue(t[n]);if(t.inputSchema==null){if(t.input_schema!=null)t.inputSchema=t.input_schema;else if(t.parameters!=null)t.inputSchema=t.parameters;else if(t.type===\`function\`)t.inputSchema={type:\`object\`,properties:{},additionalProperties:!1}}return t}`,
        `function __codexLinuxNormalizeThreadStartBridgeDynamicTool(e,t=null){e=__codexLinuxNormalizeThreadStartBridgeValue(e);if(e==null||typeof e!==\`object\`)return[];if(e.type===\`namespace\`&&Array.isArray(e.tools)){let n=typeof e.name===\`string\`?e.name:t;return e.tools.flatMap(e=>__codexLinuxNormalizeThreadStartBridgeDynamicTool(e,n))}let n=t==null?e:{...e,namespace:e.namespace??t};if(n.type==null&&typeof n.name===\`string\`)return[{...n,type:\`function\`,inputSchema:n.inputSchema??{type:\`object\`,properties:{},additionalProperties:!1}}];return n.type===\`function\`?[n]:[]}`
      ].join("");
  const replacements = patch.patches.map(target => {
    const requestSource = source.slice(target.requestStart, target.requestEnd);

    return {
      start: target.requestStart,
      end: target.requestEnd,
      replacement: `${dynamicToolThreadStartBridgeMarker}(${requestSource})`
    };
  });

  replacements.sort((left, right) => right.start - left.start);

  let patched = source;
  for (const replacement of replacements) {
    patched = `${patched.slice(0, replacement.start)}${replacement.replacement}${patched.slice(replacement.end)}`;
  }

  return helper ? `${patched}\n${helper}` : patched;
}

function findDynamicToolThreadStartRequestPatch(source) {
  const patches = findDynamicToolThreadStartRequestPatches(source);

  if (patches.length > 0) {
    return {
      status: "patch",
      patches
    };
  }

  if (
    source.includes(dynamicToolThreadStartRequestMarker) &&
    source.includes("mcp_request_enqueued") &&
    source.includes("thread/start")
  ) {
    return { status: "patched" };
  }

  if (source.includes("mcp_request_enqueued") && source.includes("thread/start")) {
    throw new Error("Unable to apply upstream patch; missing thread/start request params");
  }

  throw new Error("Unable to apply upstream patch; missing thread/start request params");
}

function findDynamicToolThreadStartRequestPatches(source) {
  const ast = parseJavaScript(source);
  const patches = [];

  walkAst(ast, node => {
    if (
      node.type !== "MethodDefinition" ||
      propertyName(node.key) !== "createRequest"
    ) {
      return;
    }

    const methodParam = node.value?.params?.[0];
    const paramsParam = node.value?.params?.[1];

    if (methodParam?.type !== "Identifier" || paramsParam?.type !== "Identifier") {
      return;
    }

    walkAst(node.value.body, child => {
      if (child.type !== "ObjectExpression") {
        return;
      }

      const requestProperty = child.properties.find(property =>
        property.type === "Property" &&
        propertyName(property.key) === "request" &&
        property.value?.type === "ObjectExpression"
      );
      const promiseProperty = child.properties.find(property =>
        property.type === "Property" &&
        propertyName(property.key) === "promise"
      );

      if (!requestProperty || !promiseProperty) {
        return;
      }

      const requestObject = requestProperty.value;
      const methodProperty = requestObject.properties.find(property =>
        property.type === "Property" &&
        propertyName(property.key) === "method" &&
        isIdentifierNamed(property.value, methodParam.name)
      );
      const paramsProperty = requestObject.properties.find(property =>
        property.type === "Property" &&
        propertyName(property.key) === "params" &&
        isIdentifierNamed(property.value, paramsParam.name)
      );

      if (!methodProperty || !paramsProperty) {
        return;
      }

      patches.push({
        methodParamName: methodParam.name,
        paramsParamName: paramsParam.name,
        paramsStart: paramsProperty.value.start,
        paramsEnd: paramsProperty.value.end
      });
    });
  });

  if (patches.length > 1) {
    throw new Error("Unable to apply upstream patch; ambiguous thread/start request params");
  }

  return patches;
}

function assertDynamicToolThreadStartRequestBefore(source) {
  const patch = findDynamicToolThreadStartRequestPatch(source);

  if (!patch || patch.status !== "patch") {
    throw new Error("missing unguarded thread/start request params");
  }
}

function assertDynamicToolThreadStartRequestAfter(source) {
  if (!source.includes(dynamicToolThreadStartRequestMarker)) {
    throw new Error("missing thread/start request params normalizer");
  }

  if (!source.includes("mcp_request_enqueued") || !source.includes("thread/start")) {
    throw new Error("missing app-server request client");
  }

  if (hasUnguardedDynamicToolThreadStartRequestSource(source)) {
    throw new Error("unguarded thread/start request params remain");
  }
}

function patchDynamicToolThreadStartRequest(source, patch = findDynamicToolThreadStartRequestPatch(source)) {
  if (patch?.status === "patched") {
    return source;
  }

  const helper = source.includes(dynamicToolThreadStartRequestMarker)
    ? ""
    : [
        `function ${dynamicToolThreadStartRequestMarker}(e){if(e==null||!Array.isArray(e.dynamicTools))return e;return{...e,dynamicTools:e.dynamicTools.flatMap(e=>__codexLinuxNormalizeThreadStartRequestDynamicTool(e))}}function __codexLinuxNormalizeThreadStartRequestDynamicTool(e,t=null){if(e==null||typeof e!==\`object\`)return[];if(e.type===\`namespace\`&&Array.isArray(e.tools)){let n=typeof e.name===\`string\`?e.name:t;return e.tools.flatMap(e=>__codexLinuxNormalizeThreadStartRequestDynamicTool(e,n))}let n=t==null?e:{...e,namespace:e.namespace??t};if(n.type==null&&typeof n.name===\`string\`)return[{...n,type:\`function\`,inputSchema:n.inputSchema??n.input_schema??n.parameters??{type:\`object\`,properties:{},additionalProperties:!1}}];if(n.type!==\`function\`)return[];if(n.inputSchema!=null)return[n];if(n.input_schema!=null)return[{...n,inputSchema:n.input_schema}];if(n.parameters!=null)return[{...n,inputSchema:n.parameters}];return[{...n,inputSchema:{type:\`object\`,properties:{},additionalProperties:!1}}]}`
      ].join("");
  const replacements = patch.patches.map(target => {
    const paramsSource = source.slice(target.paramsStart, target.paramsEnd);

    return {
      start: target.paramsStart,
      end: target.paramsEnd,
      replacement: `${target.methodParamName}===\`thread/start\`?${dynamicToolThreadStartRequestMarker}(${paramsSource}):${paramsSource}`
    };
  });

  replacements.sort((left, right) => right.start - left.start);

  let patched = source;
  for (const replacement of replacements) {
    patched = `${patched.slice(0, replacement.start)}${replacement.replacement}${patched.slice(replacement.end)}`;
  }

  return helper ? `${patched}\n${helper}` : patched;
}

function findDynamicToolSchemaContractPatch(source) {
  const patches = findDynamicToolSchemaContractPatches(source);

  if (patches.length > 0) {
    return {
      status: "patch",
      patches
    };
  }

  if (
    source.includes(dynamicToolSchemaContractMarker) &&
    source.includes("Tools provided by the Codex app.")
  ) {
    return { status: "patched" };
  }

  if (source.includes("Tools provided by the Codex app.") && source.includes("deferLoading")) {
    throw new Error("Unable to apply upstream patch; missing dynamic tool schema mapper");
  }

  throw new Error("Unable to apply upstream patch; missing dynamic tool schema mapper");
}

function findDynamicToolSchemaContractPatches(source) {
  const ast = parseJavaScript(source);
  const patches = [];

  walkAst(ast, node => {
    if (node.type !== "CallExpression" || !isMemberPropertyNamed(node.callee, "map")) {
      return;
    }

    const callback = node.arguments[0];
    const callbackParam = callback?.params?.[0];
    const body = callback?.body;

    if (
      callback?.type !== "ArrowFunctionExpression" ||
      callbackParam?.type !== "Identifier" ||
      body?.type !== "ObjectExpression" ||
      !isDynamicToolFunctionObject(body, callbackParam.name)
    ) {
      return;
    }

    const context = source.slice(Math.max(0, node.start - 1500), Math.min(source.length, node.end + 1500));

    if (!context.includes("Tools provided by the Codex app.") || !context.includes("deferLoading")) {
      return;
    }

    patches.push({
      callEnd: node.end,
      objectStart: body.start,
      objectEnd: body.end
    });
  });

  if (patches.length > 1) {
    throw new Error("Unable to apply upstream patch; ambiguous dynamic tool schema mapper");
  }

  return patches;
}

function isDynamicToolFunctionObject(object, toolVarName) {
  let hasFunctionType = false;
  let spreadsTool = false;
  let hasDeferLoading = false;

  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      if (isIdentifierNamed(property.argument, toolVarName)) {
        spreadsTool = true;
      }

      const sourceName = property.argument?.type === "ConditionalExpression"
        ? objectPropertyNames(property.argument.consequent).concat(objectPropertyNames(property.argument.alternate))
        : [];

      if (sourceName.includes("deferLoading")) {
        hasDeferLoading = true;
      }

      continue;
    }

    if (property.type !== "Property") {
      continue;
    }

    const key = propertyName(property.key);

    if (key === "type" && isStringLiteral(property.value, "function")) {
      hasFunctionType = true;
    }

    if (key === "deferLoading") {
      hasDeferLoading = true;
    }
  }

  return hasFunctionType && spreadsTool && hasDeferLoading;
}

function objectPropertyNames(node) {
  if (node?.type !== "ObjectExpression") {
    return [];
  }

  return node.properties
    .filter(property => property.type === "Property")
    .map(property => propertyName(property.key))
    .filter(Boolean);
}

function assertDynamicToolSchemaContractBefore(source) {
  const patch = findDynamicToolSchemaContractPatch(source);

  if (!patch || patch.status !== "patch") {
    throw new Error("missing unguarded dynamic tool schema mapper");
  }
}

function assertDynamicToolSchemaContractAfter(source) {
  if (!source.includes(dynamicToolSchemaContractMarker)) {
    throw new Error("missing dynamic tool schema contract helper");
  }

  if (!source.includes("Tools provided by the Codex app.")) {
    throw new Error("missing dynamic tool namespace builder");
  }

  if (hasUnguardedDynamicToolSchemaContractSource(source)) {
    throw new Error("unguarded dynamic tool schema mapper remains");
  }
}

function patchDynamicToolSchemaContract(source, patch = findDynamicToolSchemaContractPatch(source)) {
  if (patch?.status === "patched") {
    return source;
  }

  const helper = source.includes(dynamicToolSchemaContractMarker)
    ? ""
    : [
        `function ${dynamicToolSchemaContractMarker}(e){if(e==null||e.type!==\`function\`)return e;if(e.inputSchema!=null)return e;if(e.input_schema!=null)return{...e,inputSchema:e.input_schema};if(e.parameters!=null)return{...e,inputSchema:e.parameters};return null}`
      ].join("");
  const replacements = [];

  for (const target of patch.patches) {
    const objectSource = source.slice(target.objectStart, target.objectEnd);

    replacements.push({
      start: target.objectStart,
      end: target.objectEnd,
      replacement: `${dynamicToolSchemaContractMarker}(${objectSource})`
    });
    replacements.push({
      start: target.callEnd,
      end: target.callEnd,
      replacement: ".filter(Boolean)"
    });
  }

  replacements.sort((left, right) => right.start - left.start);

  let patched = source;
  for (const replacement of replacements) {
    patched = `${patched.slice(0, replacement.start)}${replacement.replacement}${patched.slice(replacement.end)}`;
  }

  return helper ? `${patched}\n${helper}` : patched;
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

function isMemberExpressionNamed(node, objectName, property) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    isIdentifierNamed(node.object, objectName) &&
    propertyName(node.property) === property
  );
}

function isCallToIdentifier(node, name) {
  return (
    node?.type === "CallExpression" &&
    isIdentifierNamed(node.callee, name)
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
    /var ([A-Za-z_$][\w$]*)=\[[^\]]+\],[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(`open-in-targets`\);\s*function [A-Za-z_$][\w$]*\(e\)\{return \1\.flatMap/
  );

  if (!match) {
    throw new Error("Unable to apply upstream patch; missing open target registry");
  }

  const anchor = source.slice(match.index, source.indexOf("]", match.index) + 1);

  return {
    anchor,
    openCommandName: findOpenCommandName(source)
  };
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
