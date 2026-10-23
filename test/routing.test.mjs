// Routes synthetic connections through the script's output with the pinned
// Mihomo core's own parser, rules and groups (see test/support/route-probe.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';
import { runInNode, scriptSource } from './support/flclash-runtime.mjs';
import { probe, probeBinary, realLists, upstreamFile } from './support/route-probe.mjs';
import { PROFILES } from './fixtures/profiles.mjs';

const unavailable = probeBinary ? false : 'set ROUTE_PROBE_BIN to the route-probe built against the pinned core';
if (process.env.CI && !probeBinary) {
  throw new Error('ROUTE_PROBE_BIN is required in CI');
}

function assertRoutes(config, cases, select = {}) {
  const result = probe(config, cases, [], select);
  cases.forEach(([network, host, port, expected], index) => {
    const { outbound, rule, resolutions } = result.cases[index];
    assert.equal(outbound, expected, `${network} ${host}:${port} matched ${rule}`);
    assert.equal(resolutions, 0, `${network} ${host}:${port} must not trigger DNS resolution`);
  });
}

// The first url-test member of the subconverter profile is an SSR node without UDP.
const ROUTES = [
  // Copyright checks sit on these pages and APIs.
  ['tcp', 'api.bilibili.com', 443, '回国或直连'],
  ['tcp', 'www.iqiyi.com', 443, '回国或直连'],
  ['tcp', 'www.mgtv.com', 443, '回国或直连'],
  ['tcp', 'u.y.qq.com', 443, '回国或直连'],
  ['tcp', 'interface3.music.163.com', 443, '回国或直连'],
  ['tcp', 'interface3.music.163.com.163jiasu.com', 443, '回国或直连'],
  ['tcp', 'v.qq.com', 443, '回国或直连'],
  ['tcp', 'h5vv6.video.qq.com', 443, '回国或直连'],
  // Tencent Video's playback-info hosts are in Sukka reject; unblock.txt lets them through.
  ['tcp', 'vd.l.qq.com', 443, '回国或直连'],
  ['tcp', 'vd6.l.qq.com', 443, '回国或直连'],
  ['tcp', 'vi.l.qq.com', 443, '回国或直连'],
  // WeChat chat media from mainland contacts; WeChat itself stays local.
  ['tcp', 'c2c.cdn.weixin.qq.com', 443, '回国或直连'],
  // Needs a China IP for other reasons.
  ['tcp', 'h5api.m.taobao.com', 443, '回国或直连'],
  ['tcp', 'www.zj.gov.cn', 443, '回国或直连'],
  ['tcp', 'www.icbc.com.cn', 443, '回国或直连'],
  ['tcp', 'www.abchina.com', 443, '回国或直连'],
  ['tcp', 'pbank.95559.com.cn', 443, '回国或直连'],
  ['tcp', 'bank.pingan.com', 443, '回国或直连'],
  ['tcp', 'www.czbank.com', 443, '回国或直连'],
  ['tcp', 'ebank.abchina.com.cn', 443, '回国或直连'],
  ['tcp', 'auth.orangebank.com.cn', 443, '回国或直连'],
  // bankofchina.com mirrors boc.cn for mainland banking; it is no overseas company.
  ['tcp', 'netc1.igtb.bankofchina.com', 443, '回国或直连'],
  ['tcp', 'www.10086.cn', 443, '回国或直连'],
  ['tcp', '59.111.160.195', 443, '回国或直连'],
  // Media CDNs serve overseas clients.
  ['tcp', 'upos-sz-mirrorcos.bilivideo.com', 443, 'DIRECT'],
  ['tcp', 'i0.hdslb.com', 443, 'DIRECT'],
  ['tcp', 'm801.music.126.net', 443, 'DIRECT'],
  ['tcp', 'aqqmusic.tc.qq.com', 443, 'DIRECT'],
  ['tcp', 'sjy6.stream.qqmusic.qq.com', 443, 'DIRECT'],
  // Overseas editions and overseas subsidiaries stay local.
  ['tcp', 'www.bilibili.tv', 443, 'DIRECT'],
  ['tcp', 'www.iq.com', 443, 'DIRECT'],
  ['tcp', 'www.youku.tv', 443, 'DIRECT'],
  ['tcp', 'www.icbc-uk.com', 443, 'DIRECT'],
  ['tcp', 'www.bochk.com', 443, 'DIRECT'],
  ['tcp', 'www.pingan.com.hk', 443, 'DIRECT'],
  // Ones v2fly does not tag @!cn are listed in direct.txt.
  ['tcp', 'www.clsa.com', 443, 'DIRECT'],
  ['tcp', 'www.icbcstandard.com', 443, 'DIRECT'],
  ['tcp', 'www.bocgins.com', 443, 'DIRECT'],
  ['tcp', 'www.hk.chinamobile.com', 443, 'DIRECT'],
  // Ads and platform analytics are rejected before every list, our own included.
  ['tcp', 'stats.doubleclick-cn.net', 443, 'REJECT'],
  ['tcp', 'sdk.jpush.cn', 443, 'REJECT-DROP'],
  ['tcp', 'afp.iqiyi.com', 443, 'REJECT'],
  ['tcp', 'atm.youku.com', 443, 'REJECT'],
  ['tcp', '203.107.1.1', 443, 'REJECT'],
  ['tcp', 'amdc.m.taobao.com', 443, 'REJECT'],
  ['tcp', 'adash.m.taobao.com', 443, 'REJECT'],
  ['tcp', 'btrace.video.qq.com', 443, 'REJECT'],
  ['tcp', 'wxsnsdy.video.qq.com', 443, 'REJECT'],
  // Our own files win over every community list.
  ['tcp', 'wetype.weixin.qq.com', 443, 'DIRECT'],
  ['tcp', 'finder.video.qq.com', 443, 'DIRECT'],
  ['tcp', 'findermp.video.qq.com', 443, 'DIRECT'],
  ['tcp', 'szzjwxsns.video.qq.com', 443, 'DIRECT'],
  ['tcp', 'music-file6.y.qq.com', 443, 'DIRECT'],
  // Everything else is local, China services that work abroad included.
  ['tcp', 'www.baidu.com', 443, 'DIRECT'],
  ['tcp', 'weixin.qq.com', 443, 'DIRECT'],
  ['tcp', 'mobilegw.alipay.com', 443, 'DIRECT'],
  ['tcp', 'www.google.com', 443, 'DIRECT'],
  ['tcp', '223.5.5.5', 443, 'DIRECT'],
  ['tcp', '192.168.1.1', 80, 'DIRECT'],
  // A 回国节点 rule skipped for UDP must not fall through to DIRECT.
  ['udp', 'api.bilibili.com', 443, 'REJECT'],
  ['udp', 'www.baidu.com', 443, 'DIRECT'],
  ['udp', 'www.google.com', 443, 'DIRECT'],
];

test('only China-IP services go to 回国或直连 (回国节点, else DIRECT); ads rejected; everything else local; no DNS lookups', { skip: unavailable }, () => {
  assertRoutes(runInNode(PROFILES.subconverter()).output, ROUTES);
});

test('every ad set rejects on its own', { skip: unavailable }, () => {
  // One host per set that no earlier set holds in the samples, so a set that
  // stopped loading fails here. Upstream may list a host in two sets, which
  // devices treat the same, so with real lists any ad rule will do; the
  // full-load test covers each real set.
  const cases = [
    ['sdk.jpush.cn', 'sukka-reject-drop'], ['stats.doubleclick-cn.net', 'sukka-reject-domainset'],
    ['wxsnsdy.video.qq.com', 'sukka-reject'], ['bvmlt.top', 'sukka-reject-no-drop'],
  ];
  const result = probe(runInNode(PROFILES.subconverter()).output, cases.map(([host]) => ['tcp', host, 443]));
  cases.forEach(([host, set], index) => {
    const { outbound, rule } = result.cases[index];
    assert.match(outbound, /^REJECT(-DROP)?$/, host);
    assert.match(rule, new RegExp(`^AND,\\(\\(RuleSet,${realLists ? 'sukka-reject[\\w-]*' : set}\\) `), host);
  });
});

test('QUIC for a return.txt line that a later DIRECT list also holds is rejected, not sent DIRECT', { skip: unavailable }, () => {
  const output = runInNode(PROFILES.subconverter()).output;
  output['rule-providers']['own-return'] = { type: 'inline', behavior: 'classical', payload: ['DOMAIN-SUFFIX,bilivideo.com'] };
  assertRoutes(output, [
    ['tcp', 'upos-sz-mirrorcos.bilivideo.com', 443, '回国或直连'],
    ['udp', 'upos-sz-mirrorcos.bilivideo.com', 443, 'REJECT'],
    ['udp', 'upos-sz-mirrorcos.bilivideo.com', 8000, 'DIRECT'],
  ]);
});

test('with a UDP-capable node pinned, China UDP and QUIC go home', { skip: unavailable }, () => {
  // The trojan node carries UDP; pinning it is what a tap in FlClash does.
  const output = runInNode(PROFILES.subconverter()).output;
  assertRoutes(output, [
    ['udp', 'api.bilibili.com', 443, '回国或直连'],
    ['udp', 'www.google.com', 443, 'DIRECT'],
  ], { 回国节点: '港沪专线_回国' });
});

test('without ad blocking, ad domains follow the normal routes', { skip: unavailable }, () => {
  const source = scriptSource.replace('blockAds: true,', 'blockAds: false,');
  assertRoutes(runInNode(PROFILES.subconverter(), source).output, [
    ['tcp', 'stats.doubleclick-cn.net', 443, 'DIRECT'],
    ['tcp', 'afp.iqiyi.com', 443, '回国或直连'],
    ['tcp', 'api.bilibili.com', 443, '回国或直连'],
  ]);
});

test('routing media CDNs home sends Bilibili video and NetEase audio home', { skip: unavailable }, () => {
  const source = scriptSource.replace('mediaCdnViaReturn: false,', 'mediaCdnViaReturn: true,');
  assertRoutes(runInNode(PROFILES.subconverter(), source).output, [
    ['tcp', 'upos-sz-mirrorcos.bilivideo.com', 443, '回国或直连'],
    ['tcp', 'm801.music.126.net', 443, '回国或直连'],
    ['tcp', 'www.bilibili.tv', 443, 'DIRECT'],
  ]);
});

test('every profile routes China-IP services to its fallback over its return group', { skip: unavailable }, () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    const output = runInNode(profile()).output;
    const [returnGroup, fallback] = output['proxy-groups'].map((group) => group.name);
    assertRoutes(output, [
      ['tcp', 'api.bilibili.com', 443, fallback],
      ['tcp', 'www.google.com', 443, 'DIRECT'],
    ]);
    assert.ok(returnGroup.startsWith('回国节点') && fallback.startsWith('回国或直连'), name);
    // The core sees the fallback as the return group first, then each of its
    // nodes on its own, then DIRECT last, after provider nodes too.
    const seen = probe(output, [], [fallback, returnGroup]).members;
    assert.equal(seen[fallback][0], returnGroup, name);
    assert.equal(seen[fallback].at(-1), 'DIRECT', name);
    // An http provider stays empty offline, where 回国节点 holds COMPATIBLE instead.
    for (const node of seen[returnGroup].filter((member) => !['DIRECT', 'COMPATIBLE'].includes(member))) {
      assert.ok(seen[fallback].includes(node), `${name}: ${node}`);
    }
  }
});

test('the return group drops notice nodes from providers and relays from chains in the core', { skip: unavailable }, () => {
  const members = (name) => probe(runInNode(PROFILES[name]()).output, [], ['回国节点']).members['回国节点'];
  assert.deepEqual(members('mixed'), ['上海 IPLC 01', '北京 BGP 0.5倍流量', '深圳 02']);
  assert.deepEqual(members('chain'), ['上海落地', '广州落地']);
  // exits is an http provider and stays empty offline; static-exits also holds direct and dns nodes.
  assert.deepEqual(members('providerChain'), ['上海落地', '广州落地']);
  assert.deepEqual(members('allRelays'), ['上海回国 01']);
  // An expired subscription leaves DIRECT, so China traffic still works.
  assert.deepEqual(members('expired'), ['DIRECT']);
});

test('a region group over an overseas provider keeps that whole provider out of the pools in the core', { skip: unavailable }, () => {
  // The provider's other overseas nodes are not exits either, and exit names
  // sharing the filter word stay.
  const { members } = probe(runInNode(PROFILES.regionRelays()).output, [], ['回国节点', '🔗 IEPL 中转']);
  assert.deepEqual(members, {
    回国节点: ['上海 IEPL 落地', '广州 IEPL 落地', '北京 01'],
    '🔗 IEPL 中转': ['香港 IEPL 01', '香港 IEPL 02', '日本 IEPL 01'],
  });
});

test('every upstream list loads in full', { skip: unavailable || (!realLists && 'set GEOSITE_MRS_DIR and SUKKA_ARTIFACTS_DIR to check real lists') }, () => {
  // The core skips a line it cannot parse with only a warning, so a reshaped
  // upstream file would otherwise leave its rule partly empty without notice.
  const output = runInNode(PROFILES.subconverter()).output;
  const { loaded } = probe(output, []);
  let checked = 0;
  for (const [name, provider] of Object.entries(output['rule-providers'])) {
    const file = upstreamFile(provider);
    if (!file) {
      continue;
    }
    const body = fs.readFileSync(file.path);
    const expected = file.format === 'mrs'
      ? Number(zlib.zstdDecompressSync(body).readBigInt64BE(5))
      // The core skips # and // comment lines (rules/provider/provider.go).
      : body.toString('utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('//')).length;
    assert.ok(expected > 0, `${name} is empty`);
    assert.equal(loaded[name], expected, `${name} loaded ${loaded[name]} of ${expected} rules`);
    checked += 1;
  }
  // Every provider but our own three files comes from upstream.
  assert.equal(checked, Object.keys(output['rule-providers']).filter((name) => !name.startsWith('own-')).length);
});

test('Global mode starts on 回国节点, also when the airport defines its own GLOBAL', { skip: unavailable }, () => {
  const global = (name) => probe(runInNode(PROFILES[name]()).output, [], ['GLOBAL']).members.GLOBAL;
  assert.deepEqual(global('subconverter'), ['回国节点', 'DIRECT']);
  assert.deepEqual(global('airportGlobal'), ['回国节点', '🚀 节点选择', 'DIRECT']);
});
