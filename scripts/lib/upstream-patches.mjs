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
    return;
  }

  await fs.writeFile(mainBundlePath, patched);
}

export function patchUpstreamMainSource(source) {
  let patched = source;

  patched = patchLinuxOpenTargetsSource(patched);
  patched = patchDisableTransparencySource(patched);

  return patched;
}

export function patchLinuxOpenTargetsSource(source) {
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

export function patchDisableTransparencySource(source) {
  let patched = source;

  patched = patchLinuxWindowBackground(patched);
  patched = patchLinuxWindowTransparency(patched);

  return patched;
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
  if (/transparent:[A-Za-z_$][\w$]*===`linux`\?!1:[A-Za-z_$][\w$]*,hasShadow:/.test(source)) {
    return source;
  }

  const match = source.match(
    /function ([A-Za-z_$][\w$]*)\(\{alwaysOnTop:([A-Za-z_$][\w$]*),hasShadow:([A-Za-z_$][\w$]*)=!0,platform:([A-Za-z_$][\w$]*),resizable:([A-Za-z_$][\w$]*),thickFrame:([A-Za-z_$][\w$]*),transparent:([A-Za-z_$][\w$]*)=!0\}\)\{return\{frame:!1,transparent:\7,hasShadow:\3,/
  );

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

function patchOpenTargetMap(source) {
  if (source.includes("appPath:process.platform===`linux`")) {
    return source;
  }

  const match = source.match(
    /targets:\[\.\.\.([A-Za-z_$][\w$]*)\.map\(\(\{id:([A-Za-z_$][\w$]*),label:([A-Za-z_$][\w$]*),icon:([A-Za-z_$][\w$]*),kind:([A-Za-z_$][\w$]*),hidden:([A-Za-z_$][\w$]*)\}\)=>\(\{id:\2,target:\2,label:\3,icon:\4,kind:\5,hidden:\6,available:([A-Za-z_$][\w$]*)\.has\(\2\),default:([A-Za-z_$][\w$]*)===\2\|\|void 0\}\)\),\.\.\.([A-Za-z_$][\w$]*)\]/
  );

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
    /var ([A-Za-z_$][\w$]*)=\[[^\]]+\],[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(`open-in-targets`\);function [A-Za-z_$][\w$]*\(e\)\{return \1\.flatMap/
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
  const match = source.match(
    /await ([A-Za-z_$][\w$]*)\(c,s\.args\(t,r,i,a,o\),\{env:s\.env\?\.\(\)\}\)/
  );

  if (!match) {
    throw new Error("Unable to apply upstream patch; missing open command runner");
  }

  return match[1];
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
