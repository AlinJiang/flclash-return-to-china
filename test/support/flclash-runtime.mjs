// Runs override.js the way FlClash 0.9.1 does (plugins/rust_api/rust/src/script/mod.rs):
// evaluate the file as a strict classic script (rquickjs 0.12.2 Ctx::eval
// defaults to JS_EVAL_FLAG_STRICT), look up `main`, call it with
// JSON.parse(config), JSON.stringify the result, and fall back to the original
// config when main returns undefined or null.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';
import quickjsNgVariant from '@jitl/quickjs-ng-wasmfile-release-sync';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const scriptPath = path.join(repositoryDirectory, 'override.js');
export const scriptSource = fs.readFileSync(scriptPath, 'utf8');

// Same limits FlClash sets on its QuickJS runtime.
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const DEADLINE_MS = 10_000;

const INVOKE = `(() => {
  const result = main(JSON.parse(__flclashInput));
  return result === undefined || result === null ? null : JSON.stringify(result);
})()`;

function decodeResult(resultJson, inputJson) {
  const output = JSON.parse(resultJson ?? inputJson);
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('script did not return a configuration object');
  }
  return output;
}

/** Node vm context with only what FlClash provides: no structuredClone, fetch or timers. */
export function createNodeScriptContext(source = scriptSource) {
  const logs = [];
  const record = (level) => (...values) => logs.push({ level, message: values.map(String).join(' ') });
  const context = vm.createContext({
    console: {
      log: record('log'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
    },
  });
  // Node's vm has no strict option; the directive goes on the first line so
  // line numbers stay the same.
  vm.runInContext(`'use strict';${source}`, context, { filename: scriptPath });
  return { context, logs };
}

export function runInNode(input, source = scriptSource) {
  const { context, logs } = createNodeScriptContext(source);
  const inputJson = JSON.stringify(input);
  context.__flclashInput = inputJson;
  const resultJson = vm.runInContext(INVOKE, context);
  return { output: decodeResult(resultJson, inputJson), logs };
}

/** Evaluates an expression against the script's top-level bindings. */
export function scriptValue(expression, source = scriptSource) {
  const { context } = createNodeScriptContext(source);
  return vm.runInContext(expression, context);
}

const quickjs = await newQuickJSWASMModuleFromVariant(quickjsNgVariant);

export function runInQuickJs(input, source = scriptSource) {
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + DEADLINE_MS));
  const context = runtime.newContext();
  const logs = [];
  try {
    const consoleHandle = context.newObject();
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const handle = context.newFunction(level, (...args) => {
        logs.push({ level, message: args.map((arg) => String(context.dump(arg))).join(' ') });
      });
      context.setProp(consoleHandle, level, handle);
      handle.dispose();
    }
    context.setProp(context.global, 'console', consoleHandle);
    consoleHandle.dispose();

    const inputJson = JSON.stringify(input);
    const inputHandle = context.newString(inputJson);
    context.setProp(context.global, '__flclashInput', inputHandle);
    inputHandle.dispose();

    const strict = { type: 'global', strict: true };
    context.unwrapResult(context.evalCode(source, 'override.js', strict)).dispose();
    const resultHandle = context.unwrapResult(context.evalCode(INVOKE, 'invoke.js', strict));
    const resultJson = context.dump(resultHandle);
    resultHandle.dispose();
    return { output: decodeResult(resultJson, inputJson), logs };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
