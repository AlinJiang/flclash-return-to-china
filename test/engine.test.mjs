import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNode, runInQuickJs, scriptSource } from './support/flclash-runtime.mjs';
import { PROFILES } from './fixtures/profiles.mjs';

// FlClash runs scripts in QuickJS-ng, not V8. Any language or library feature
// the engine lacks would fail every device at once, so every fixture must
// produce byte-identical output in both engines.
for (const [name, profile] of Object.entries(PROFILES)) {
  test(`QuickJS-ng output matches Node for the ${name} profile`, () => {
    const node = runInNode(profile());
    const quickjs = runInQuickJs(profile());

    assert.deepEqual(quickjs.output, node.output);
    assert.deepEqual(quickjs.logs, node.logs);
  });
}

test('QuickJS-ng without ad blocking matches Node', () => {
  const source = scriptSource.replace('blockAds: true,', 'blockAds: false,');
  assert.notEqual(source, scriptSource);
  assert.deepEqual(
    runInQuickJs(PROFILES.subconverter(), source).output,
    runInNode(PROFILES.subconverter(), source).output,
  );
});

test('QuickJS-ng handles a referenced rule-provider with 70,000 entries within FlClash limits', () => {
  // QuickJS-ng caps call arguments at 65535, so a spread over this array would throw.
  const input = PROFILES.ruleSetReference();
  input['rule-providers']['airport-cn'].payload = Array.from({ length: 70_000 }, (_, index) => `+.d${index}.cn.invalid`);
  const { output } = runInQuickJs(input);

  assert.equal(output['proxy-groups'][0].name, '回国节点');
  assert.equal(output['rule-providers']['airport-cn'].payload.length, 70_000);
});

test('both engines evaluate the script in strict mode, as FlClash does', () => {
  // rquickjs Ctx::eval sets JS_EVAL_FLAG_STRICT, so a slip that sloppy mode
  // forgives would break every device while passing here.
  const source = `${scriptSource}\nundeclaredBinding = 1;\n`;
  for (const run of [runInNode, runInQuickJs]) {
    assert.throws(() => run(PROFILES.subconverter(), source), /undeclaredBinding/, run.name);
  }
});

test('the script uses nothing FlClash does not provide', () => {
  // Absent from FlClash's QuickJS-ng runtime (no Web or Node APIs, no modules).
  const code = scriptSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [/\bstructuredClone\b/, /\bimport\b/, /\bexport\b/, /\brequire\(/, /\bfetch\(/, /\bset(Timeout|Interval)\(/]) {
    assert.doesNotMatch(code, forbidden);
  }
});
