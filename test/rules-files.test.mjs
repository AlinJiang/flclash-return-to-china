// rules/direct.txt, rules/return.txt and rules/unblock.txt are the only lists
// this repository maintains. Devices fetch them as classical rule-providers, where a bad line
// is skipped rather than fatal, so CI is where mistakes must be caught.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rulesDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../rules');
const DOMAIN_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-WILDCARD']);
const IP_TYPES = new Set(['IP-CIDR', 'IP-CIDR6']);

// Go's netip.ParsePrefix rejects leading zeros in octets and prefix lengths.
function isIpv4Cidr(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(0|[1-9]\d?)$/.exec(text);
  return Boolean(match)
    && match.slice(1, 5).every((octet) => Number(octet) <= 255 && String(Number(octet)) === octet)
    && Number(match[5]) <= 32;
}

function isIpv6Cidr(text) {
  const match = /^([0-9a-f:]+)\/(0|[1-9]\d{0,2})$/i.exec(text);
  if (!match || Number(match[2]) > 128) {
    return false;
  }
  const halves = match[1].split('::');
  const groups = halves.flatMap((half) => (half === '' ? [] : half.split(':')));
  return halves.length <= 2 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))
    && (halves.length === 2 ? groups.length < 8 : groups.length === 8);
}

/** Returns why a line is not a valid target-less classical rule, or null. */
export function lineProblem(line) {
  const [type, payload, ...params] = line.split(',');
  if (DOMAIN_TYPES.has(type)) {
    if (!payload || !/^[a-z0-9*?.-]+$/i.test(payload) || params.length > 0) {
      return 'domain rules take one lowercase host or pattern and no target';
    }
    return null;
  }
  if (IP_TYPES.has(type)) {
    const valid = type === 'IP-CIDR' ? isIpv4Cidr(payload) || isIpv6Cidr(payload) : isIpv6Cidr(payload);
    if (!valid || params.some((param) => param !== 'no-resolve')) {
      return 'IP rules take one canonical CIDR and optionally no-resolve';
    }
    return null;
  }
  return `unsupported rule type ${type}`;
}

for (const file of ['direct.txt', 'return.txt', 'unblock.txt']) {
  test(`rules/${file} holds only valid, unique, target-less rules`, () => {
    const lines = fs.readFileSync(path.join(rulesDirectory, file), 'utf8').split('\n')
      .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.equal(lineProblem(line), null, `${file}: ${line}`);
    }
    assert.equal(new Set(lines).size, lines.length, `${file} has duplicate lines`);
  });
}

test('the line checker rejects the mistakes it is meant to catch', () => {
  for (const bad of [
    'DOMAIN-SUFFIX,taobao.com,回国', 'DOMAIN-SUFFIX,', 'GEOIP,CN', 'MATCH', 'DOMAIN,a b', 'IP-CIDR,10.0.0.0/08',
    'IP-CIDR,192.0.2.1', 'IP-CIDR6,192.0.2.0/24', 'IP-CIDR,192.0.2.0/24,src', 'RULE-SET,x',
  ]) {
    assert.notEqual(lineProblem(bad), null, bad);
  }
  for (const good of ['DOMAIN-SUFFIX,taobao.com', 'DOMAIN,vd.l.qq.com', 'DOMAIN-WILDCARD,*.example.invalid', 'IP-CIDR,203.0.113.0/24,no-resolve', 'IP-CIDR6,2001:db8::/32']) {
    assert.equal(lineProblem(good), null, good);
  }
});
