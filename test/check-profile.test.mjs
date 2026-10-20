// tools/check-profile.mjs runs on real airport profiles, so its output must
// never carry a server, address or secret, on the success path or when the
// core rejects the profile. The fixtures stand in for real profiles here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { mask } from '../tools/mask.mjs';
import { mihomoBinary } from './support/mihomo.mjs';
import { probeBinary } from './support/route-probe.mjs';
import { PROFILES, subconverterProfile } from './fixtures/profiles.mjs';

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/check-profile.mjs');
const unavailable = mihomoBinary && probeBinary ? false : 'set MIHOMO_BIN and ROUTE_PROBE_BIN to run';
if (process.env.CI && unavailable) {
  throw new Error('MIHOMO_BIN and ROUTE_PROBE_BIN are required in CI');
}

// What a real profile would leak: fixture servers are .invalid names or
// TEST-NET and loopback addresses, and every secret is "test-only".
const LEAKS = ['.invalid', 'test-only', '192.0.2.', '198.51.100.', '127.0.0.1'];

function checkProfile(yamlText, env = process.env) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'check-profile-'));
  try {
    const file = path.join(directory, 'profile.yaml');
    fs.writeFileSync(file, yamlText);
    const result = spawnSync(process.execPath, [tool, file], { encoding: 'utf8', timeout: 300_000, env });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function assertNoLeak(output, label) {
  for (const leak of LEAKS) {
    assert.equal(output.includes(leak), false, `${label} output contains ${leak}`);
  }
}

test('every fixture passes the offline check without printing a server, address or secret', { skip: unavailable }, () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    const { status, output } = checkProfile(YAML.stringify(profile()));
    assert.equal(status, 0, `${name}:\n${output}`);
    assert.doesNotMatch(output, /^FAIL/m, name);
    assertNoLeak(output, name);
  }
});

test('a profile the core rejects is reported with every host masked, underscore and IDN names included', { skip: unavailable }, () => {
  for (const server of ['node.fake_cdn.invalid', 'hk.机场云.invalid']) {
    const input = subconverterProfile();
    input.proxies[1] = { name: '坏节点', type: 'ss', server, port: 443, cipher: 'not-a-cipher', password: 'test-only' };
    const { status, output } = checkProfile(YAML.stringify(input));
    assert.equal(status, 1, output);
    assert.match(output, /^FAIL pinned core parses the output: .*<host>/m);
    assert.equal(output.includes(server.split('.')[1]), false, output);
    assertNoLeak(output, server);
  }
});

test('YAML merge keys are resolved the way FlClash decodes the profile', { skip: unavailable }, () => {
  const { status, output } = checkProfile([
    'mixed-port: 7890',
    'proxies:',
    '  - &node {name: 上海 01, type: ss, server: sh.node.invalid, port: 8388, cipher: aes-128-gcm, password: test-only, udp: true}',
    '  - {<<: *node, name: 广州 02, server: gz.node.invalid}',
    'proxy-groups:',
    '  - &group {name: PROXY, type: select, proxies: [上海 01, 广州 02]}',
    '  - {<<: *group, name: BACKUP}',
    'rules: [MATCH,PROXY]',
    '',
  ].join('\n'));
  assert.equal(status, 0, output);
  assert.match(output, /^ok {3}pinned core parses the output/m);
  assertNoLeak(output, 'merge-key profile');
});

test('masking hides addresses in the shapes Go errors print them', () => {
  for (const [text, masked] of [
    ['dial tcp 198.51.100.7:8443: connect: connection refused', 'dial tcp <ip>: connect: connection refused'],
    ['proxy 0: invalid address 203.0.113.5:443: bad port', 'proxy 0: invalid address <ip>: bad port'],
    ['dial tcp [2001:db8::1]:443: i/o timeout', 'dial tcp <ip6>: i/o timeout'],
    ['ss node.fake_cdn.invalid:443 cipher', 'ss <host> cipher'],
    ['ss hk.机场云.invalid:443 cipher', 'ss <host> cipher'],
    ['fetch https://sub.airport.invalid/api?token=test-only failed', 'fetch <url> failed'],
    ['[return-to-china 3.0.0] 2 nodes', '[return-to-china 3.0.0] 2 nodes'],
    ['北京 BGP 0.5倍流量', '北京 BGP 0.5倍流量'],
  ]) {
    assert.equal(mask(text), masked, text);
  }
});

test('airport rule-providers named by its DNS pass the check without samples or downloads', { skip: unavailable }, () => {
  const input = subconverterProfile();
  input.dns['nameserver-policy'] = {
    'rule-set:cn_domain': ['https://doh-cn.invalid/dns-query'],
    'rule-set:sukka_cdn': ['https://doh-cn.invalid/dns-query'],
  };
  input['rule-providers'] = {
    cn_domain: {
      type: 'http', behavior: 'domain', format: 'mrs', interval: 86400,
      url: 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs',
    },
    sukka_cdn: { type: 'http', behavior: 'domain', format: 'text', interval: 43200, url: 'https://ruleset.skk.moe/Clash/domainset/cdn.txt' },
  };
  const { status, output } = checkProfile(YAML.stringify(input));
  assert.equal(status, 0, output);
  assertNoLeak(output, 'kept http rule-providers');
});

test('a profile whose DNS needs GeoSite data gets a hint instead of a bare failure', { skip: unavailable }, () => {
  // Only GeoIP, as in CI, so the core cannot load geosite:cn.
  const geodata = fs.mkdtempSync(path.join(os.tmpdir(), 'geoip-only-'));
  try {
    const source = fs.readdirSync(process.env.MIHOMO_GEODATA_DIR).find((file) => /^geoip\.metadb$/i.test(file));
    fs.copyFileSync(path.join(process.env.MIHOMO_GEODATA_DIR, source), path.join(geodata, 'geoip.metadb'));
    const input = subconverterProfile();
    input.dns['nameserver-policy'] = { 'geosite:cn': ['https://doh-cn.invalid/dns-query'] };
    const { status, output } = checkProfile(YAML.stringify(input), { ...process.env, MIHOMO_GEODATA_DIR: geodata });
    assert.equal(status, 1, output);
    assert.match(output, /^hint the profile needs GeoSite data/m);
    assertNoLeak(output, 'geosite profile');
  } finally {
    fs.rmSync(geodata, { recursive: true, force: true });
  }
});
