// The NAS side router: router/config.yaml must be what the generator makes
// from the current override.js, and router/compose.yaml must fill in every
// placeholder the config carries. test/router-e2e.test.mjs runs both for real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { PLACEHOLDERS, buildRouterConfig, routerConfigPath } from '../tools/build-router-config.mjs';
import { scriptValue } from './support/flclash-runtime.mjs';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configText = fs.readFileSync(routerConfigPath, 'utf8');
const config = YAML.parse(configText);
const compose = YAML.parse(fs.readFileSync(path.join(repositoryDirectory, 'router/compose.yaml'), 'utf8'));
const service = compose.services.mihomo;
const script = service.command[0];

test('router/config.yaml is up to date with override.js', () => {
  assert.equal(configText, buildRouterConfig(), 'run node tools/build-router-config.mjs');
});

test('the router config routes like FlClash devices, with the airport as a provider', () => {
  const [returnGroup, fallback, global] = config['proxy-groups'];
  assert.equal(returnGroup.name, '回国节点');
  assert.deepEqual(returnGroup.use, ['airport']);
  assert.equal(returnGroup.proxies, undefined);
  assert.deepEqual([fallback.name, fallback.type, fallback.proxies], ['回国或直连', 'fallback', ['回国节点', 'DIRECT']]);
  assert.deepEqual(global, { name: 'GLOBAL', type: 'select', hidden: true, proxies: ['回国节点', 'DIRECT'] });
  assert.equal(config['proxy-providers'].airport.filter, scriptValue('MAINLAND_NODE.source'));
  assert.equal(config.rules.at(-1), 'MATCH,DIRECT');
  assert.ok(config.rules.some((rule) => rule === 'RULE-SET,own-return,回国或直连,no-resolve'));
  const ownBase = scriptValue('SETTINGS.ownRulesBase');
  assert.equal(config['rule-providers']['own-return'].url, `${ownBase}return.txt`);
});

test('the router config is a LAN gateway and DNS server', () => {
  assert.deepEqual(
    { enable: config.tun.enable, 'auto-route': config.tun['auto-route'], 'auto-detect-interface': config.tun['auto-detect-interface'] },
    { enable: true, 'auto-route': true, 'auto-detect-interface': true },
  );
  // auto-redirect needs nftables, which QNAP kernels may lack.
  assert.equal(config.tun['auto-redirect'], undefined);
  assert.equal(config.dns.listen, '0.0.0.0:53');
  assert.equal(config.dns['enhanced-mode'], 'redir-host');
  assert.equal(config.ipv6, false);
  assert.equal(config.sniffer['override-destination'], true);
  assert.equal(config['external-controller'], '0.0.0.0:9090');
});

test('every placeholder appears in the config and is filled in by the compose script', () => {
  for (const placeholder of PLACEHOLDERS) {
    assert.ok(configText.includes(`'${placeholder}'`), `${placeholder} is single-quoted in the config`);
    assert.ok(script.includes(`s|${placeholder}|`), `the compose script fills in ${placeholder}`);
  }
  assert.equal(configText.match(/'<[A-Z_]+>'/g).length, 4, 'no other placeholder');
});

test('the compose file pins the image and points at the published template', () => {
  assert.match(service.image, /^metacubex\/mihomo:v\d+\.\d+\.\d+$/);
  assert.equal(
    service.environment.CONFIG_URL,
    'https://raw.githubusercontent.com/AlinJiang/flclash-return-to-china/main/router/config.yaml',
  );
  assert.match(service.environment.SUBSCRIPTION_URL, /^</, 'the repository holds no subscription');
  assert.match(service.environment.CONTROLLER_SECRET, /^</, 'the repository holds no secret');
  assert.deepEqual(service.cap_add, ['NET_ADMIN']);
  assert.equal(service.sysctls['net.ipv4.ip_forward'], 1);
  assert.equal(compose.networks.lan.driver, 'macvlan');
  // Compose expands a single $, so the shell script only uses $$.
  assert.doesNotMatch(script, /(?<!\$)\$(?!\$)/);
});
