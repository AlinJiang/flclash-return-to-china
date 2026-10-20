// Drives test/route-probe, which routes connections through a config with the
// pinned Mihomo core's own parser, rules and groups. Upstream http
// rule-providers (Sukka, MetaCubeX geosite, our rules/ files) are swapped for
// local copies so nothing is downloaded. Providers that are already inline,
// such as a test's stand-in for one of our files, are kept as they are, and so
// are airport providers the caller names: route-probe never loads http ones.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoreHome, withoutGeodataDownloads } from './geodata.mjs';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const probeBinary = process.env.ROUTE_PROBE_BIN ?? '';
// Optional directories of real upstream files, as tools/fetch-upstream.mjs
// saves them: Sukka named like non_ip_domestic.txt, MetaCubeX geosite named
// like bilibili@!cn.mrs. The core then parses them as file providers, in the
// formats devices download.
const sukkaDirectory = process.env.SUKKA_ARTIFACTS_DIR ?? '';
const geositeDirectory = process.env.GEOSITE_MRS_DIR ?? '';
export const realLists = Boolean(sukkaDirectory && geositeDirectory);

// Real entries taken from each Sukka list (2026-10-19), a few per set.
const SAMPLE_PAYLOADS = {
  'non_ip/reject-drop': ['DOMAIN-SUFFIX,jpush.cn'],
  'domainset/reject': [
    '+.doubleclick-cn.net', '+.amdc.m.taobao.com', '+.adash.m.taobao.com', 'btrace.video.qq.com', '+.rum.battle.net',
    'vd.l.qq.com', 'vd6.l.qq.com', 'vi.l.qq.com',
  ],
  'non_ip/reject': ['IP-CIDR,203.107.1.0/24,no-resolve', 'DOMAIN-KEYWORD,wxsnsdy'],
  'non_ip/reject-no-drop': ['DOMAIN-SUFFIX,bvmlt.top'],
  'non_ip/domestic_cdn': ['DOMAIN-SUFFIX,hdslb.com', 'DOMAIN-SUFFIX,alicdn.com', 'DOMAIN-SUFFIX,music.126.net'],
  'non_ip/domestic': [
    'DOMAIN-SUFFIX,qq.com', 'DOMAIN-SUFFIX,baidu.com', 'DOMAIN-SUFFIX,bilibili.com', 'DOMAIN-SUFFIX,hdslb.com',
    'DOMAIN-SUFFIX,alicdn.com', 'DOMAIN-SUFFIX,miwifi.com', 'DOMAIN-SUFFIX,peiluyou.com', 'DOMAIN-SUFFIX,gov.cn',
    'DOMAIN-SUFFIX,dl.delivery.mp.microsoft.com', 'DOMAIN-SUFFIX,cm.steampowered.com', 'DOMAIN-SUFFIX,steamserver.net',
    'DOMAIN-SUFFIX,battle.net', 'DOMAIN-SUFFIX,blizzard.com', 'DOMAIN-SUFFIX,aliyuncs.com', 'DOMAIN-SUFFIX,163jiasu.com',
    'DOMAIN,dl.ubnt.com', 'DOMAIN,i.dell.com', 'DOMAIN,ocsp.globalsign.com',
  ],
  'ip/neteasemusic': ['IP-CIDR,59.111.160.195/32,no-resolve'],
  'non_ip/neteasemusic': ['DOMAIN-SUFFIX,music.126.net', 'DOMAIN-SUFFIX,music.163.com'],
};

// Real entries taken from each MetaCubeX geosite list (2026-10-19).
const SAMPLE_GEOSITE = {
  bilibili: ['+.bilibili.com', '+.biliapi.net', '+.bilivideo.com', '+.hdslb.com', '+.bilibili.tv', '+.biligame.com'],
  'bilibili-cdn': ['+.bilivideo.com', '+.hdslb.com', '+.biliimg.com', 'upos-hz-mirrorakam.akamaized.net'],
  'bilibili@!cn': ['+.bilibili.tv', '+.biliintl.com', 'upos-hz-mirrorakam.akamaized.net'],
  iqiyi: ['+.iqiyi.com', '+.71.am', '+.qy.net', '+.iq.com', '+.afp.iqiyi.com'],
  'iqiyi@!cn': ['+.iq.com'],
  'iqiyi@ads': ['+.afp.iqiyi.com'],
  youku: ['+.youku.com', '+.ykimg.com', '+.youku.tv', '+.atm.youku.com'],
  'youku@!cn': ['+.youku.tv', '+.youkuplay.com'],
  'youku@ads': ['+.atm.youku.com'],
  hunantv: ['+.mgtv.com', '+.hunantv.com'],
  'hunantv@ads': ['+.da.mgtv.com'],
  cctv: ['+.cctv.com', '+.cntv.cn'],
  'cctv@ads': ['+.ad.cctv.com'],
  'tencent-tme': ['+.y.qq.com', '+.music.qq.com', '+.kugou.com', '+.kuwo.cn', '+.ximalaya.com'],
  'tencent-tme@ads': ['+.stat.y.qq.com'],
  icbc: ['+.icbc.com.cn', '+.icbc-uk.com', '+.icbcstandard.com'],
  'icbc@!cn': ['+.icbc-uk.com'],
  boc: ['+.boc.cn', '+.bochk.com', '+.bocgins.com', '+.bankofchina.com'],
  'boc@!cn': ['+.bochk.com'],
  ccb: ['+.ccb.com'],
  'ccb@!cn': ['+.ccbintl.com.hk'],
  cmb: ['+.cmbchina.com'],
  'cmb@!cn': ['+.cmbi.com.hk'],
  citic: ['+.citicbank.com', '+.clsa.com'],
  'citic@!cn': ['+.citics.com.hk'],
  pingan: ['+.pingan.com', '+.yqb.com', '+.pingan.com.cn', '+.pingan.com.hk'],
  'pingan@!cn': ['+.pingan.com.hk'],
  unionpay: ['+.unionpay.com', '+.95516.com'],
  'category-bank-cn': ['+.abchina.com', '+.bankcomm.com', '+.psbc.com'],
  chinamobile: ['+.10086.cn', '+.migu.cn', '+.chinamobile.com', '+.speedtest.hk.chinamobile.com'],
  'chinamobile@!cn': ['+.speedtest.hk.chinamobile.com'],
  chinatelecom: ['+.189.cn', '+.chinatelecomglobal.com'],
  'chinatelecom@!cn': ['+.chinatelecomglobal.com'],
  chinaunicom: ['+.10010.com', '+.chinaunicomglobal.com'],
  'chinaunicom@!cn': ['+.chinaunicomglobal.com'],
};

const SUKKA_URL = /^https:\/\/ruleset\.skk\.moe\/Clash\//;
const GEOSITE_URL = /^https:\/\/raw\.githubusercontent\.com\/MetaCubeX\/meta-rules-dat\/meta\/geo\/geosite\/(.+)\.mrs$/;
const OWN_URL = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/rules\/([a-z-]+\.txt)$/;

const lines = (text) => text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

/** A file provider over a copy inside the core's home, the only place Mihomo reads provider files. */
function fileProvider(home, source, behavior, format) {
  const target = path.join(home, 'providers', path.basename(source));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return { type: 'file', behavior, format, path: target };
}

function sample(samples, name) {
  assert.ok(samples[name], `sample payload for ${name}`);
  return samples[name];
}

/** The real upstream file standing in for a provider, or null in sample mode or for other URLs. */
export function upstreamFile(provider) {
  const url = provider?.url ?? '';
  if (sukkaDirectory && SUKKA_URL.test(url)) {
    const file = url.replace(SUKKA_URL, '').replace(/\.txt$/, '').replace('/', '_');
    return { path: path.join(sukkaDirectory, `${file}.txt`), behavior: provider.behavior, format: 'text' };
  }
  const geosite = GEOSITE_URL.exec(url);
  if (geositeDirectory && geosite) {
    return { path: path.join(geositeDirectory, `${decodeURIComponent(geosite[1])}.mrs`), behavior: 'domain', format: 'mrs' };
  }
  return null;
}

/** Local copy of an upstream provider, or null when the URL is not one we know. */
function localCopy(provider, home) {
  const real = upstreamFile(provider);
  if (real) {
    return fileProvider(home, real.path, real.behavior, real.format);
  }
  const url = provider?.url ?? '';
  if (SUKKA_URL.test(url)) {
    const file = url.replace(SUKKA_URL, '').replace(/\.txt$/, '');
    return { type: 'inline', behavior: provider.behavior, payload: sample(SAMPLE_PAYLOADS, file) };
  }
  const geosite = GEOSITE_URL.exec(url);
  if (geosite) {
    return { type: 'inline', behavior: 'domain', payload: sample(SAMPLE_GEOSITE, decodeURIComponent(geosite[1])) };
  }
  const ownFile = OWN_URL.exec(url);
  if (ownFile) {
    // Our own files are read from this checkout, exactly as they will be published.
    const text = fs.readFileSync(path.join(repositoryDirectory, 'rules', ownFile[1]), 'utf8');
    return { type: 'inline', behavior: 'classical', payload: lines(text) };
  }
  return null;
}

function offline(config, home, untouched) {
  const providers = {};
  for (const [name, provider] of Object.entries(config['rule-providers'] ?? {})) {
    providers[name] = untouched.includes(name) ? provider : localCopy(provider, home) ?? provider;
  }
  return withoutGeodataDownloads({ ...config, 'rule-providers': providers });
}

/**
 * cases are [network, host, port] tuples; members are group names to list;
 * select maps a select group to the member to pick first; untouched names
 * rule-providers to pass through as they are.
 */
export function probe(config, cases, members = [], select = {}, untouched = []) {
  const home = createCoreHome();
  try {
    const request = {
      config: offline(config, home, untouched),
      select,
      cases: cases.map(([network, host, port]) => ({ network, host, port })),
      members,
    };
    const result = spawnSync(probeBinary, ['-d', home], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 120_000,
    });
    if (result.status !== 0) {
      // The core log can quote config fragments such as server names, so it is
      // attached for callers that mask it instead of being put in the message.
      throw Object.assign(new Error(`route-probe exited with status ${result.status}`), { log: result.stderr ?? '' });
    }
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
