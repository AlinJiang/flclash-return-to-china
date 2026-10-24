// The Shadowrocket config for iOS: it must be what the generator makes from the
// current override.js, follow the same routing plan in the same order, and
// select nodes and check them the way the FlClash groups do. Shadowrocket itself
// cannot run in CI; tools/fetch-upstream.mjs checks that every list it names
// downloads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_GROUP, FALLBACK_GROUP, LISTS_BASE, RETURN_GROUP, buildShadowrocketConfig, remoteLists, shadowrocketConfigPath, shadowrocketList,
} from '../tools/build-shadowrocket.mjs';
import { geositeFiles, toRuleSet } from '../tools/build-shadowrocket-lists.mjs';
import { runInNode, scriptValue } from './support/flclash-runtime.mjs';
import { subconverterProfile } from './fixtures/profiles.mjs';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = fs.readFileSync(shadowrocketConfigPath, 'utf8');
const section = (name) => text.split(`[${name}]\n`)[1].split('\n\n')[0].split('\n').filter(Boolean);
const output = runInNode(subconverterProfile()).output;

test('shadowrocket/return-to-china.conf is up to date with override.js', () => {
  assert.equal(text, buildShadowrocketConfig(), 'run node tools/build-shadowrocket.mjs');
});

test('the rules follow override.js\'s plan, in order, on the Surge-format copies of the same lists', () => {
  const rules = section('Rule');
  const providers = output['rule-providers'];
  const target = (rule) => rule.replace(/,no-resolve$/, '').split(',').at(-1);
  // FlClash's rules after the unblock exemptions, as [list URL, target], dropping its QUIC guards.
  const expected = output.rules
    .filter((rule) => !rule.startsWith('AND,((NETWORK,UDP)') && rule !== 'MATCH,DIRECT')
    .map((rule) => {
      const name = rule.match(/RULE-SET,([^,)]+)/)[1];
      return [shadowrocketList(providers[name].url).url, target(rule) === RETURN_GROUP ? FALLBACK_GROUP : target(rule)];
    });
  const remote = rules.filter((rule) => /^(RULE-SET|DOMAIN-SET),/.test(rule)).map((rule) => [rule.split(',')[1], target(rule)]);
  assert.deepEqual(remote, expected);
  assert.equal(rules.at(-1), 'FINAL,DIRECT');
  // Every list type matches its content: Sukka's domain sets hold bare names, the rest typed rules.
  for (const { type, url } of remoteLists(text)) {
    assert.equal(type, url.includes('/domainset/') ? 'DOMAIN-SET' : 'RULE-SET', url);
  }
});

test('unblock.txt lines come first, where return.txt or DIRECT would send them', () => {
  const lines = (file) => fs.readFileSync(path.join(repositoryDirectory, 'rules', file), 'utf8')
    .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const unblock = lines('unblock.txt');
  const returning = new Set(lines('return.txt'));
  assert.deepEqual(
    section('Rule').slice(0, unblock.length),
    unblock.map((line) => `${line},${returning.has(line) ? FALLBACK_GROUP : 'DIRECT'}`),
  );
  assert.match(section('Rule')[unblock.length], /^RULE-SET,https:\/\/ruleset\.skk\.moe\/List\/non_ip\/reject-drop\.conf,/);
});

test('the groups pick mainland nodes and check them as 回国节点 does, then fall back to DIRECT', () => {
  const [ret] = output['proxy-groups'];
  const filter = scriptValue('MAINLAND_NODE.source');
  const check = `url=${ret.url},interval=${ret.interval},timeout=5`;
  assert.deepEqual(section('Proxy Group'), [
    `${RETURN_GROUP} = url-test,policy-regex-filter=${filter},${check},tolerance=${ret.tolerance}`,
    `${BACKUP_GROUP} = fallback,policy-regex-filter=${filter},${check},hidden=1`,
    `${FALLBACK_GROUP} = fallback,${RETURN_GROUP},${BACKUP_GROUP},DIRECT,${check},hidden=1`,
  ]);
});

test('geosite lists become Shadowrocket rule sets, and a line the converter cannot place fails it', () => {
  assert.equal(toRuleSet('# comment\n+.bilibili.com\nbilibili.tv\n\n'), 'DOMAIN-SUFFIX,bilibili.com\nDOMAIN,bilibili.tv\n');
  assert.throws(() => toRuleSet('regexp:^ad\\.'), /no Shadowrocket rule/);
  assert.throws(() => toRuleSet('# only a comment\n'), /empty/);
  // Every geosite list in the plan is converted and served from the lists branch.
  const served = remoteLists(text).filter(({ url }) => url.startsWith(LISTS_BASE)).map(({ url }) => url.slice(`${LISTS_BASE}geosite/`.length));
  assert.deepEqual(served, geositeFiles().map((file) => `${file}.list`));
});
