import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeScriptContext, runInNode, scriptSource } from './support/flclash-runtime.mjs';
import { mihomoBinary, parseWithMihomo } from './support/mihomo.mjs';
import { PROFILES } from './fixtures/profiles.mjs';

// CI always builds the pinned core; locally the check runs when MIHOMO_BIN is set.
const unavailable = mihomoBinary ? false : 'set MIHOMO_BIN to the pinned Clash.Meta core to run';
if (process.env.CI && !mihomoBinary) {
  throw new Error('MIHOMO_BIN is required in CI');
}

function assertRejected(config, reason) {
  const result = parseWithMihomo(config);
  assert.equal(result.ok, false, 'the pinned core must reject this config');
  assert.match(result.log, reason);
}

function assertParses(config, label) {
  const result = parseWithMihomo(config);
  assert.ok(result.ok, `${label} must parse in the pinned core:\n${result.log}`);
}

test('every airport fixture parses in the pinned core before and after the script', { skip: unavailable }, () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    assertParses(profile(), `${name} airport profile`);
    assertParses(runInNode(profile()).output, `${name} script output`);
  }
});

test('the profile without ad blocking parses in the pinned core', { skip: unavailable }, () => {
  const source = scriptSource.replace('blockAds: true,', 'blockAds: false,');
  for (const [name, profile] of Object.entries(PROFILES)) {
    assertParses(runInNode(profile(), source).output, `${name} script output without ad blocking`);
  }
});

test('the degraded profile parses in the pinned core', { skip: unavailable }, () => {
  const { context } = createNodeScriptContext();
  for (const [name, profile] of Object.entries(PROFILES)) {
    assertParses(JSON.parse(JSON.stringify(context.degradedProfile(profile()))), `${name} degraded profile`);
  }
});

test('the core check rejects the failure modes the script guards against', { skip: unavailable }, () => {
  // Deleting the airport groups breaks an inline dialer-proxy at parse time.
  const chain = runInNode(PROFILES.chain()).output;
  // Keep only the script's own group and its GLOBAL.
  chain['proxy-groups'] = chain['proxy-groups'].slice(0, 2);
  assertRejected(chain, /dialer-proxy \[🔗 前置节点\] not found/);

  // Deleting a rule-provider that retained DNS names fails parsing too.
  const ruleSets = runInNode(PROFILES.ruleSetReference()).output;
  delete ruleSets['rule-providers']['airport-cn'];
  assertRejected(ruleSets, /not found rule-set: airport-cn/);

  // Reusing an airport group's name is a duplicate group name.
  const collision = runInNode(PROFILES.collision()).output;
  collision['proxy-groups'][0].name = '回国节点 2';
  assertRejected(collision, /duplicate group name/);
});
