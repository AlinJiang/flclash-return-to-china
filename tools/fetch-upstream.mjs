#!/usr/bin/env node
// Downloads every community rule list override.js points devices at, checks
// that each one is there and usable, and saves them for the routing tests:
//
//   node tools/fetch-upstream.mjs <geosite-dir> <sukka-dir>
//   GEOSITE_MRS_DIR=<geosite-dir> SUKKA_ARTIFACTS_DIR=<sukka-dir> node --test test/routing.test.mjs
//
// A renamed, emptied or broken upstream file would otherwise leave its rule
// silently empty on every device. Only the public rule hosts are contacted.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { runInNode, scriptValue } from '../test/support/flclash-runtime.mjs';
import { subconverterProfile } from '../test/fixtures/profiles.mjs';
import { LISTS_BASE, buildShadowrocketConfig, remoteLists } from './build-shadowrocket.mjs';
import { toRuleSet } from './build-shadowrocket-lists.mjs';

const [geositeDirectory, sukkaDirectory] = process.argv.slice(2);
if (!geositeDirectory || !sukkaDirectory) {
  console.error('usage: node tools/fetch-upstream.mjs <geosite-dir> <sukka-dir>');
  process.exit(2);
}

const SUKKA_BASE = scriptValue('SUKKA_BASE');
const GEOSITE_BASE = scriptValue('GEOSITE_BASE');
const OWN_BASE = scriptValue('SETTINGS.ownRulesBase');
// rules/provider/mrs_reader.go: zstd stream that starts with "MRS" 1, the
// behavior byte, then the entry count as a big-endian int64.
const MRS_MAGIC = Buffer.from([0x4d, 0x52, 0x53, 1]);

// A rename upstream answers 404 or 410 at once; anything else may be a passing
// network or rate-limit error, so it is retried after a pause.
const GONE = new Set([404, 410]);
const PAUSES_MS = [2_000, 8_000];

async function download(url) {
  for (let attempt = 0; ; attempt += 1) {
    let error;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) {
        return Buffer.from(await response.arrayBuffer());
      }
      error = Object.assign(new Error(`HTTP ${response.status}`), { gone: GONE.has(response.status) });
    } catch (caught) {
      error = caught;
    }
    if (error.gone || attempt >= PAUSES_MS.length) {
      throw error;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, PAUSES_MS[attempt]);
    });
  }
}

function checkMrs(body) {
  const data = zlib.zstdDecompressSync(body);
  if (!data.subarray(0, 4).equals(MRS_MAGIC)) {
    throw new Error('not an MRS v1 file');
  }
  const count = data.readBigInt64BE(5);
  if (count <= 0n) {
    throw new Error('the list is empty');
  }
  return `${count} entries`;
}

// Whether every line parses is checked by the routing tests, which load these
// files into the core and compare its rule counts with the line counts.
function checkText(body) {
  const text = body.toString('utf8');
  if (text.trimStart().startsWith('<')) {
    throw new Error('an HTML page, not a rule list');
  }
  const rules = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (rules.length === 0) {
    throw new Error('the list is empty');
  }
  return `${rules.length} lines`;
}

fs.mkdirSync(geositeDirectory, { recursive: true });
fs.mkdirSync(sukkaDirectory, { recursive: true });
const failures = [];
const providers = Object.entries(runInNode(subconverterProfile()).output['rule-providers']);
for (const [name, { url }] of providers) {
  let target;
  let check;
  if (url.startsWith(SUKKA_BASE)) {
    target = path.join(sukkaDirectory, `${url.slice(SUKKA_BASE.length).replace(/\.txt$/, '').replace('/', '_')}.txt`);
    check = checkText;
  } else if (url.startsWith(GEOSITE_BASE)) {
    target = path.join(geositeDirectory, decodeURIComponent(url.slice(GEOSITE_BASE.length)));
    check = checkMrs;
  } else if (url.startsWith(OWN_BASE)) {
    // Served from this repository; the tests read them from the checkout.
    continue;
  } else {
    failures.push(`${name}: unexpected host in ${url}`);
    continue;
  }
  try {
    const body = await download(url);
    const summary = check(body);
    fs.writeFileSync(target, body);
    console.log(`ok   ${name}: ${summary}`);
  } catch (error) {
    failures.push(`${name}: ${url}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

// The Surge-format copies the Shadowrocket config names instead. The converted
// geosite lists are checked at their source, and converted, here; the branch
// that serves them is published by the shadowrocket-lists workflow.
for (const { type, url } of remoteLists(buildShadowrocketConfig())) {
  if (url.startsWith(OWN_BASE)) {
    continue;
  }
  const source = url.startsWith(LISTS_BASE) ? `${GEOSITE_BASE}${url.slice(`${LISTS_BASE}geosite/`.length)}` : url;
  try {
    const body = await download(source);
    const summary = source === url ? checkText(body) : `${toRuleSet(body.toString('utf8')).split('\n').length - 1} rules`;
    console.log(`ok   shadowrocket ${type} ${url.split('/').slice(-2).join('/')}: ${summary}`);
  } catch (error) {
    failures.push(`shadowrocket: ${url}: ${error.message}`);
    console.log(`FAIL shadowrocket ${url}: ${error.message}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} upstream list(s) unusable:\n${failures.join('\n')}`);
  process.exit(1);
}
