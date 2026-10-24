#!/usr/bin/env node
// Writes the v2fly geosite lists the Shadowrocket config uses, as Shadowrocket
// rule sets. meta-rules-dat publishes them only in Clash's domain format
// (`+.example.com`), which Shadowrocket's DOMAIN-SET does not read: on an
// iPhone, api.bilibili.com fell through to FINAL. The shadowrocket-lists
// workflow runs this daily and publishes the result on the shadowrocket-lists
// branch, which shadowrocket/return-to-china.conf points at.
//
//   node tools/build-shadowrocket-lists.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptValue } from '../test/support/flclash-runtime.mjs';

const GEOSITE_BASE = scriptValue('GEOSITE_BASE');

/** Every geosite list in override.js's routing plan, as its URL-encoded file name. */
export function geositeFiles() {
  // Spread: the script's array belongs to its own VM realm.
  return [...scriptValue('routingPlan().map(([, provider]) => provider.url)')]
    .filter((url) => url.startsWith(GEOSITE_BASE))
    .map((url) => url.slice(GEOSITE_BASE.length).replace(/\.mrs$/, ''));
}

/** A Clash domain list as a Shadowrocket rule set; fails on lines it cannot place. */
export function toRuleSet(text) {
  const rules = [];
  for (const line of text.split('\n').map((entry) => entry.trim())) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('+.')) {
      rules.push(`DOMAIN-SUFFIX,${line.slice(2)}`);
    } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(line)) {
      rules.push(`DOMAIN,${line}`);
    } else {
      throw new Error(`no Shadowrocket rule for ${JSON.stringify(line)}`);
    }
  }
  if (rules.length === 0) {
    throw new Error('the list is empty');
  }
  return `${rules.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [outDirectory] = process.argv.slice(2);
  if (!outDirectory) {
    console.error('usage: node tools/build-shadowrocket-lists.mjs <out-dir>');
    process.exit(2);
  }
  const directory = path.join(outDirectory, 'geosite');
  fs.mkdirSync(directory, { recursive: true });
  for (const file of geositeFiles()) {
    const url = `${GEOSITE_BASE}${file}.list`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    const rules = toRuleSet(await response.text());
    // Decoded on disk, so the raw URL carries the same %40/%21 escapes as the source.
    fs.writeFileSync(path.join(directory, `${decodeURIComponent(file)}.list`), rules);
    console.log(`ok   ${decodeURIComponent(file)}: ${rules.split('\n').length - 1} rules`);
  }
}
