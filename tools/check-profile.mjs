#!/usr/bin/env node
// Offline check of override.js against a local airport Profile YAML, for
// example FlClash's profiles/<id>.yaml.
//
//   node tools/check-profile.mjs <profile.yaml>
//
// With MIHOMO_BIN (pinned core) the output is also parsed by the core, and with
// ROUTE_PROBE_BIN sample connections are routed through it. Both need
// MIHOMO_GEODATA_DIR so the core never downloads anything: copy GEOIP.metadb,
// GEOSITE.dat and ASN.mmdb from FlClash's home there, since an airport DNS
// policy may name geosite: or geoip: entries.
//
// Output masks URLs, host names and IP addresses, and never prints the config,
// the YAML source or core logs unmasked. Node and group names are printed:
// they can identify the airport, so do not post the output publicly.
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { runInNode, runInQuickJs } from '../test/support/flclash-runtime.mjs';
import { mihomoBinary, parseWithMihomo } from '../test/support/mihomo.mjs';
import { probe, probeBinary } from '../test/support/route-probe.mjs';
import { mask, maskCoreLog } from './mask.mjs';

const ROUTING_KEYS = new Set(['proxy-groups', 'rule-providers', 'sub-rules', 'rules']);

// Messages this tool's own helpers raise carry no profile data.
function describe(error) {
  const message = String(error?.message ?? error);
  return message.startsWith('MIHOMO_GEODATA_DIR') ? message : mask(message);
}

// Anything unexpected is reported without its stack or message details.
process.on('uncaughtException', (error) => {
  console.error(`FAIL unexpected error: ${describe(error)}`);
  process.exit(1);
});

const profilePath = process.argv[2];
if (!profilePath) {
  console.error('usage: node tools/check-profile.mjs <profile.yaml>');
  process.exit(2);
}

let input;
try {
  // FlClash hands the script the YAML decoded into Mihomo's RawConfig by Go
  // yaml, with defaults for absent keys. Go yaml resolves `<<` merge keys,
  // which YAML 1.2 decoding only does with merge: true; the 1.1 schema would
  // also change how booleans and numbers resolve, so it is not used.
  const parsed = YAML.parse(fs.readFileSync(profilePath, 'utf8'), { maxAliasCount: -1, merge: true, prettyErrors: false });
  input = JSON.parse(JSON.stringify(parsed));
} catch (error) {
  // A YAML error message quotes the offending source line, which may hold a credential.
  const position = error?.linePos?.[0];
  console.error(`FAIL profile does not parse as YAML: ${error?.code ?? 'error'}${position ? ` at line ${position.line}` : ''}`);
  process.exit(2);
}

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) {
    failures.push(message);
  }
};

const node = runInNode(input);
const quickjs = runInQuickJs(input);
const { output } = quickjs;
for (const entry of quickjs.logs) {
  console.log(`log  [${entry.level}] ${mask(entry.message)}`);
}
check(isDeepStrictEqual(node.output, output), 'QuickJS-ng and Node produce the same config');
const retainedKeys = Object.keys(input).filter((key) => !ROUTING_KEYS.has(key));
const changed = retainedKeys.filter((key) => !isDeepStrictEqual(input[key], output[key]));
check(changed.length === 0, `non-routing root keys unchanged (${retainedKeys.length} keys${changed.length > 0 ? `; changed: ${changed.join(', ')}` : ''})`);

const groups = output['proxy-groups'];
const degraded = groups[0]?.name?.startsWith('⚠️');
check(!degraded, 'script built the return policy (no degraded fallback)');
for (const group of groups.slice(0, 2)) {
  const members = [...(group.proxies ?? []), ...(group.use ?? []).map((name) => `use:${name}`)];
  console.log(`     group ${group.name} (${group.type}${group.hidden ? ', hidden' : ''}): ${members.map(mask).join(' | ')}`);
}
// After 回国节点 come our hidden fallback and GLOBAL, then the airport's groups, all hidden.
check(degraded || groups.slice(1).every((group) => group.hidden === true), `${(input['proxy-groups'] ?? []).length} airport groups kept and hidden`);
console.log(`     rule-providers: ${Object.keys(output['rule-providers'] ?? {}).map(mask).join(', ')}`);
// Rules come from the script's own constants and SETTINGS, never from the airport.
console.log(`     rules:\n       ${output.rules.join('\n       ')}`);

let coreParsed = !mihomoBinary;
if (mihomoBinary) {
  try {
    const result = parseWithMihomo(output);
    coreParsed = result.ok;
    check(result.ok, `pinned core parses the output: ${maskCoreLog(result.log).join(' / ')}`);
    const missing = /can't initial (GeoSite|GeoIP|ASN)/i.exec(result.log)?.[1];
    if (!result.ok && missing) {
      console.log(`hint the profile needs ${missing} data: copy it from FlClash's home into MIHOMO_GEODATA_DIR`);
    }
  } catch (error) {
    check(false, `pinned core check could not run: ${describe(error)}`);
  }
} else {
  console.log('skip core parse (set MIHOMO_BIN and MIHOMO_GEODATA_DIR)');
}

if (!probeBinary) {
  console.log('skip routing probe (set ROUTE_PROBE_BIN and MIHOMO_GEODATA_DIR)');
} else if (degraded || !coreParsed) {
  console.log('skip routing probe (the output must build and parse first)');
} else {
  // Rules target the fallback (groups[1]); it uses 回国节点 (groups[0]) while that answers.
  const [returnGroup, ruleTarget] = groups.map((group) => group.name);
  const cases = [
    ['tcp', 'api.bilibili.com', 443, ruleTarget],
    ['tcp', 'upos-sz-mirrorcos.bilivideo.com', 443, 'DIRECT'],
    ['tcp', 'interface3.music.163.com', 443, ruleTarget],
    ['tcp', 'www.taobao.com', 443, ruleTarget],
    ['tcp', 'amdc.m.taobao.com', 443, 'REJECT'],
    ['tcp', 'vd6.l.qq.com', 443, ruleTarget],
    ['tcp', 'www.icbc.com.cn', 443, ruleTarget],
    ['tcp', 'www.baidu.com', 443, 'DIRECT'],
    ['tcp', 'weixin.qq.com', 443, 'DIRECT'],
    ['tcp', 'wetype.weixin.qq.com', 443, 'DIRECT'],
    ['tcp', 'www.google.com', 443, 'DIRECT'],
    ['tcp', '223.5.5.5', 443, 'DIRECT'],
  ];
  try {
    // The airport's own providers stay as they are: they only serve its DNS and
    // sniffer, and route-probe never loads an http provider.
    const airportProviders = Object.keys(input['rule-providers'] ?? {});
    const result = probe(output, cases, [returnGroup, ruleTarget, 'GLOBAL'], {}, airportProviders);
    cases.forEach(([network, host, port, expected], index) => {
      const actual = result.cases[index];
      check(actual.outbound === expected && actual.resolutions === 0,
        `${network} ${host}:${port} -> ${actual.outbound} via ${actual.rule}${actual.resolutions ? ' (resolved DNS)' : ''}`);
    });
    for (const [name, members] of Object.entries(result.members)) {
      console.log(`     core members of ${name}: ${members.map(mask).join(' | ')}`);
    }
  } catch (error) {
    check(false, `routing probe failed: ${describe(error)}${error.log ? ` / ${maskCoreLog(error.log).join(' / ')}` : ''}`);
  }
}

process.exitCode = failures.length > 0 ? 1 : 0;
