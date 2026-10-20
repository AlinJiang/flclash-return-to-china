import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createNodeScriptContext, runInNode, scriptSource, scriptValue } from './support/flclash-runtime.mjs';
import {
  airportGlobalProfile,
  allRelaysProfile,
  chainProfile,
  collisionProfile,
  expiredProfile,
  flclashShapedProfile,
  mixedProfile,
  providerChainProfile,
  providerProfile,
  punctuatedRuleSetProfile,
  regionRelaysProfile,
  ruleSetReferenceProfile,
  subconverterProfile,
} from './fixtures/profiles.mjs';

const ROUTING_KEYS = ['proxy-groups', 'rule-providers', 'sub-rules', 'rules'];
const HEALTH_URL = 'https://wifi.vivo.com.cn/generate_204';
const NOTICE_FILTER = scriptValue('NOTICE_EXCLUDE_FILTER');
const VERSION = scriptValue('SCRIPT_VERSION');
const SUKKA_BASE = scriptValue('SUKKA_BASE');
const GEOSITE_BASE = scriptValue('GEOSITE_BASE');
const OWN_BASE = vm.runInContext('SETTINGS.ownRulesBase', createNodeScriptContext().context);
const NON_FORWARDING = 'Direct|Dns|Reject|RejectDrop|Rematch';
const RETURN = '回国节点';

// The routing plan, written out independently of the script's constants.
const AD_LISTS = ['iqiyi', 'youku', 'hunantv', 'tencent-tme', 'cctv'];
const OVERSEAS_LISTS = [
  'bilibili', 'iqiyi', 'youku', 'icbc', 'boc', 'ccb', 'cmb', 'citic', 'pingan', 'chinamobile', 'chinatelecom', 'chinaunicom',
];
const MEDIA_LISTS = ['bilibili', 'iqiyi', 'youku', 'hunantv', 'cctv', 'tencent-tme'];
const BANK_LISTS = [
  'icbc', 'boc', 'ccb', 'cmb', 'citic', 'pingan', 'unionpay', 'category-bank-cn', 'chinamobile', 'chinatelecom', 'chinaunicom',
];
const QUIC_GUARD = /^AND,\(\(NETWORK,UDP\),\(DST-PORT,443\),\(OR,\((.*)\)\)\),REJECT$/;

function expectedRules({ blockAds = true, mediaCdnViaReturn = false, returnName = RETURN, neteaseIp = 'sukka-neteasemusic-ip', netease = 'sukka-neteasemusic' } = {}) {
  const set = (name) => `RULE-SET,${name},no-resolve`;
  const rule = (name, target) => `RULE-SET,${name},${target},no-resolve`;
  const ad = (name, target) => `AND,((${set(name)}),(NOT,((${set('own-unblock')})))),${target}`;
  const guard = (names) => `AND,((NETWORK,UDP),(DST-PORT,443),(OR,(${names.map((name) => `(${set(name)})`).join(',')}))),REJECT`;
  const returnLists = [
    ...MEDIA_LISTS.map((name) => `geosite-${name}`),
    netease,
    ...BANK_LISTS.map((name) => `geosite-${name}`),
    neteaseIp,
  ];
  return [
    ...(blockAds
      ? [
        ad('sukka-reject-drop', 'REJECT-DROP'),
        ad('sukka-reject-domainset', 'REJECT'),
        ad('sukka-reject', 'REJECT'),
        ad('sukka-reject-no-drop', 'REJECT'),
        ...AD_LISTS.map((name) => ad(`geosite-${name}-ads`, 'REJECT')),
      ]
      : []),
    rule('own-direct', 'DIRECT'),
    rule('own-return', returnName),
    // The next rules are DIRECT, so 回国 QUIC skipped for UDP is stopped here.
    guard(['own-return']),
    ...OVERSEAS_LISTS.map((name) => rule(`geosite-${name}-overseas`, 'DIRECT')),
    ...(mediaCdnViaReturn ? [] : [rule('sukka-domestic-cdn', 'DIRECT'), rule('geosite-bilibili-cdn', 'DIRECT')]),
    ...returnLists.map((name) => rule(name, returnName)),
    guard(returnLists),
    'MATCH,DIRECT',
  ];
}
const DEFAULT_RULES = expectedRules();

function groupByName(output, name) {
  return output['proxy-groups'].find((group) => group.name === name);
}

function withSettings(replacements) {
  let source = scriptSource;
  for (const [from, to] of replacements) {
    assert.ok(source.includes(from), `script source contains ${from}`);
    source = source.replace(from, to);
  }
  return source;
}

function assertAirportRootPreserved(input, output) {
  for (const key of Object.keys(input)) {
    if (!ROUTING_KEYS.includes(key)) {
      assert.deepEqual(output[key], input[key], `root key ${key} is unchanged`);
    }
  }
  assert.equal('sub-rules' in output, false);
}

const OWN_GLOBAL = { name: 'GLOBAL', type: 'select', hidden: true, proxies: [RETURN, 'DIRECT'] };

/** Our group, our GLOBAL for Global mode, then every airport group, hidden. */
function assertAirportGroupsKeptHidden(input, output) {
  const airportGroups = input['proxy-groups'] ?? [];
  assert.deepEqual(output['proxy-groups'][1], OWN_GLOBAL);
  assert.deepEqual(
    output['proxy-groups'].slice(2),
    airportGroups.map((group) => ({ ...group, hidden: true })),
  );
}

test('the current subconverter profile gets return routing and keeps everything else', () => {
  const input = subconverterProfile();
  const { output, logs } = runInNode(input);

  assertAirportRootPreserved(input, output);
  assertAirportGroupsKeptHidden(input, output);
  assert.deepEqual(output['proxy-groups'][0], {
    name: RETURN,
    type: 'url-test',
    proxies: ['港广专线_回国', '港沪专线_回国'],
    url: HEALTH_URL,
    'expected-status': '204',
    interval: 300,
    tolerance: 50,
    lazy: true,
    'exclude-filter': NOTICE_FILTER,
  });
  assert.deepEqual(output.rules, DEFAULT_RULES);
  assert.deepEqual(logs, [{
    level: 'log',
    message: `[return-to-china ${VERSION}] 2 nodes, 0 proxy providers, ${input['proxy-groups'].length} airport groups kept, `
      + '0 airport rule-providers kept',
  }]);
});

test('rule-providers are community lists plus our three files, each with the right format', () => {
  const { output } = runInNode(subconverterProfile());
  const providers = output['rule-providers'];

  assert.deepEqual(Object.keys(providers), [
    'own-unblock',
    'sukka-reject-drop', 'sukka-reject-domainset', 'sukka-reject', 'sukka-reject-no-drop',
    ...AD_LISTS.map((name) => `geosite-${name}-ads`),
    'own-direct', 'own-return',
    ...OVERSEAS_LISTS.map((name) => `geosite-${name}-overseas`),
    'sukka-domestic-cdn', 'geosite-bilibili-cdn',
    ...MEDIA_LISTS.map((name) => `geosite-${name}`),
    'sukka-neteasemusic',
    ...BANK_LISTS.map((name) => `geosite-${name}`),
    'sukka-neteasemusic-ip',
  ]);
  for (const [name, provider] of Object.entries(providers)) {
    assert.equal(provider.type, 'http', name);
    assert.equal(provider.proxy, 'DIRECT', name);
    // FlClash rewrites every provider path to md5(name@url); a script path would be ignored.
    assert.equal('path' in provider, false, name);
    if (provider.url.startsWith(GEOSITE_BASE)) {
      assert.deepEqual([provider.behavior, provider.format, provider.interval], ['domain', 'mrs', 86400], name);
      const list = decodeURIComponent(provider.url.slice(GEOSITE_BASE.length).replace(/\.mrs$/, ''));
      const expected = name.replace(/^geosite-/, '').replace(/-overseas$/, '@!cn').replace(/-ads$/, '@ads');
      assert.equal(list, expected, name);
    } else if (provider.url.startsWith(SUKKA_BASE)) {
      const file = provider.url.slice(SUKKA_BASE.length);
      assert.equal(provider.behavior, file.startsWith('domainset/') ? 'domain' : 'classical', file);
      assert.deepEqual([provider.format, provider.interval], ['text', 43200], file);
    } else {
      assert.ok(provider.url.startsWith(OWN_BASE), name);
      assert.deepEqual([provider.behavior, provider.format, provider.interval], ['classical', 'text', 3600], name);
    }
  }
  assert.equal(providers['own-direct'].url, `${OWN_BASE}direct.txt`);
  assert.equal(providers['own-return'].url, `${OWN_BASE}return.txt`);
  assert.equal(providers['own-unblock'].url, `${OWN_BASE}unblock.txt`);
});

test('every Sukka provider follows SUKKA_BASE, so switching to the official mirror is one edit', () => {
  const mirror = 'https://ruleset-mirror.skk.moe/Clash/';
  const source = withSettings([[`const SUKKA_BASE = '${SUKKA_BASE}';`, `const SUKKA_BASE = '${mirror}';`]]);
  const urls = Object.values(runInNode(subconverterProfile(), source).output['rule-providers']).map((provider) => provider.url);

  assert.ok(urls.filter((url) => url.startsWith(mirror)).length >= 7);
  assert.equal(urls.some((url) => url.includes('//ruleset.skk.moe/')), false);
});

test('ad rules come first and skip unblock.txt; our own files come next, before every community list', () => {
  const { rules } = runInNode(subconverterProfile()).output;
  const adRules = rules.filter((rule) => /REJECT(-DROP)?$/.test(rule) && !QUIC_GUARD.test(rule));
  const ownDirect = rules.indexOf('RULE-SET,own-direct,DIRECT,no-resolve');

  assert.equal(adRules.length, 9);
  for (const rule of adRules) {
    assert.match(rule, /^AND,\(\(RULE-SET,[^,]+,no-resolve\),\(NOT,\(\(RULE-SET,own-unblock,no-resolve\)\)\)\),REJECT(-DROP)?$/);
    assert.ok(rules.indexOf(rule) < ownDirect, rule);
  }
  assert.equal(rules[ownDirect + 1], `RULE-SET,own-return,${RETURN},no-resolve`);
  const communityLists = rules.filter((rule) => /^RULE-SET,(geosite|sukka)-/.test(rule));
  assert.ok(communityLists.every((rule) => rules.indexOf(rule) > ownDirect + 1));
});

test('the overseas edition of every list goes DIRECT before the list itself goes home', () => {
  const { output } = runInNode(subconverterProfile());
  for (const name of OVERSEAS_LISTS) {
    const overseas = output.rules.indexOf(`RULE-SET,geosite-${name}-overseas,DIRECT,no-resolve`);
    const service = output.rules.indexOf(`RULE-SET,geosite-${name},${RETURN},no-resolve`);
    assert.ok(overseas >= 0 && service > overseas, name);
  }
});

test('QUIC to a 回国节点 set is rejected before any later rule could send it elsewhere', () => {
  for (const source of [
    scriptSource,
    withSettings([['blockAds: true,', 'blockAds: false,']]),
    withSettings([['mediaCdnViaReturn: false,', 'mediaCdnViaReturn: true,']]),
  ]) {
    const { rules } = runInNode(subconverterProfile(), source).output;
    rules.forEach((rule, index) => {
      const routed = new RegExp(`^RULE-SET,([^,]+),(${RETURN}),no-resolve$`).exec(rule);
      if (!routed) {
        return;
      }
      // A rule whose group cannot carry UDP is skipped. Until a guard names the
      // set, every later rule must route to the same group or reject.
      const [, set, group] = routed;
      const rest = rules.slice(index + 1);
      const guardIndex = rest.findIndex((later) => QUIC_GUARD.exec(later)?.[1].includes(`(RULE-SET,${set},no-resolve)`));
      assert.ok(guardIndex >= 0, `${set} has a QUIC guard`);
      for (const later of rest.slice(0, guardIndex)) {
        assert.ok(later.endsWith(`,${group},no-resolve`) || QUIC_GUARD.test(later) || /,REJECT(-DROP)?$/.test(later), `${later} sits between ${set} and its guard`);
      }
    });
  }
});

test('every rule-set match is no-resolve, and nothing needs geodata', () => {
  const { output } = runInNode(subconverterProfile());
  for (const rule of output.rules) {
    assert.doesNotMatch(rule, /^(GEOIP|GEOSITE|IP-ASN|SRC-IP)/);
    for (const [match] of rule.matchAll(/RULE-SET,[^()]*/g)) {
      assert.match(match, /,no-resolve$/, `${rule} must not resolve`);
    }
  }
});

test('a later airport version with providers and renamed groups is inherited in full', () => {
  const first = runInNode(subconverterProfile()).output;
  const latest = providerProfile();
  const second = runInNode(latest).output;

  assert.deepEqual(first.rules, DEFAULT_RULES);
  assert.deepEqual(second.rules, DEFAULT_RULES);
  assertAirportRootPreserved(latest, second);
  assertAirportGroupsKeptHidden(latest, second);
  for (const key of ['dns', 'hosts', 'sniffer', 'ntp', 'proxy-providers', 'mixed-port', 'allow-lan']) {
    assert.deepEqual(second[key], latest[key]);
  }
  const group = groupByName(second, RETURN);
  assert.deepEqual(group.use, ['机场节点']);
  assert.equal('proxies' in group, false);
  assert.equal(group['exclude-filter'], NOTICE_FILTER);
  // Provider nodes can be direct or dns types.
  assert.equal(group['exclude-type'], NON_FORWARDING);
});

test('mixed inline nodes and providers are both offered, notice nodes excluded on both paths', () => {
  const input = mixedProfile();
  const { output } = runInNode(input);
  const auto = groupByName(output, RETURN);

  // A traffic multiplier in a real node name is not a quota notice.
  assert.deepEqual(auto.proxies, ['上海 IPLC 01', '北京 BGP 0.5倍流量']);
  assert.deepEqual(auto.use, ['backup', 'static']);
  assert.deepEqual(input['proxy-providers'], output['proxy-providers']);

  // Provider nodes are only known at runtime; Mihomo's group exclude-filter drops them.
  const pattern = new RegExp(NOTICE_FILTER.replace(/^\(\?i\)/, ''), 'iu');
  assert.equal(pattern.test('剩余流量：100 GB'), true);
  assert.equal(pattern.test('[回国] 深圳 02'), false);
});

test('notice filter matches pseudo-nodes but never real nodes, our groups or DIRECT', () => {
  assert.match(NOTICE_FILTER, /^\(\?i\)/);
  const body = NOTICE_FILTER.slice(4);
  assert.doesNotMatch(body, /`/, 'a backtick splits Mihomo filters');
  assert.ok(body.split('|').every((alternative) => alternative.length > 0), 'an empty alternative matches everything');
  const pattern = new RegExp(body, 'iu');
  for (const name of [
    '服务到期日：2026-11-19', '剩余流量：12.3 GB', '距离下次重置剩余：3 天', '套餐到期：2026-12-01',
    '过期时间：2026-12-01', '有效期至 2027-01-01', '官网 airport.invalid', '最新地址 airport.invalid',
    'TG群 @airport', 'Telegram频道', '联系客服', '公告：请更新订阅', 'Traffic: 10 GB / 200 GB',
    'Expire: 2026-11-19', 'https://airport.invalid',
  ]) {
    assert.equal(pattern.test(name), true, name);
  }
  for (const name of [
    RETURN, 'GLOBAL', 'DIRECT', '港广专线_回国', '港沪专线_回国', '上海 IPLC 01',
    '北京 BGP 0.5倍流量', '广州移动 02', '深圳电信 x2', 'Shanghai 01', 'HK-SZ IEPL',
  ]) {
    assert.equal(pattern.test(name), false, name);
  }
});

test('airport groups that chains, DNS, NTP, tunnels and listeners name stay, front hops leave the pools', () => {
  const input = chainProfile();
  const { output } = runInNode(input);

  assertAirportRootPreserved(input, output);
  assertAirportGroupsKeptHidden(input, output);
  // 香港中转 is a direct dialer-proxy target, 深圳中转 a member of one, 直连出口 never forwards.
  assert.deepEqual(groupByName(output, RETURN).proxies, ['上海落地', '广州落地']);
});

test('relay providers and provider-level chains leave the return pools', () => {
  const { output } = runInNode(providerChainProfile());
  // 香港中转 is a payload node's dialer-proxy; relay is used by the 🔗 前置 group.
  assert.deepEqual(groupByName(output, RETURN).proxies, ['上海落地']);
  assert.deepEqual(groupByName(output, RETURN).use, ['exits', 'static-exits']);
});

test('when every inline node is a relay, only the provider exits are offered', () => {
  const { output } = runInNode(allRelaysProfile());
  const group = groupByName(output, RETURN);

  assert.equal('proxies' in group, false);
  assert.deepEqual(group.use, ['exits']);
});

test('a provider a relay group draws from counts as a relay provider as a whole', () => {
  // The overseas provider only feeds the region group, so none of it is an exit.
  const region = runInNode(regionRelaysProfile()).output;
  assert.deepEqual(groupByName(region, RETURN).proxies, ['上海 IEPL 落地', '广州 IEPL 落地']);
  // A provider its own dialer-proxy chains holds exits only.
  assert.deepEqual(groupByName(region, RETURN).use, ['home']);
});

test('Global mode sends everything home: our GLOBAL starts with 回国节点', () => {
  // Without it Mihomo would generate a GLOBAL that starts on DIRECT.
  const { output } = runInNode(subconverterProfile());
  assert.deepEqual(output['proxy-groups'].filter((group) => group.name === 'GLOBAL'), [OWN_GLOBAL]);
});

test('an airport GLOBAL group offers 回国节点 first instead of a second GLOBAL', () => {
  const input = airportGlobalProfile();
  const { output } = runInNode(input);

  assert.deepEqual(output['proxy-groups'].filter((group) => group.name === 'GLOBAL'), [
    { name: 'GLOBAL', type: 'select', proxies: [RETURN, '🚀 节点选择', 'DIRECT'], hidden: true },
  ]);
  const unchanged = output['proxy-groups'].slice(1).filter((group) => group.name !== 'GLOBAL');
  assert.deepEqual(unchanged, input['proxy-groups'].filter((group) => group.name !== 'GLOBAL').map((group) => ({ ...group, hidden: true })));
});

test('rule-provider names with parentheses or spaces are still kept when retained sections name them', () => {
  const input = punctuatedRuleSetProfile();
  const { output } = runInNode(input);
  for (const name of ['国内(域名)', 'lan (private)', 'skip(1)']) {
    assert.deepEqual(output['rule-providers'][name], input['rule-providers'][name], name);
  }
});

test('airport rule-providers named by retained DNS and sniffer sections stay, ours are renamed around them', () => {
  const input = ruleSetReferenceProfile();
  const { output, logs } = runInNode(input);
  const providers = output['rule-providers'];

  assert.deepEqual(providers['airport-cn'], input['rule-providers']['airport-cn']);
  assert.deepEqual(providers['airport-private'], input['rule-providers']['airport-private']);
  assert.deepEqual(providers['sukka-neteasemusic'], input['rule-providers']['sukka-neteasemusic']);
  assert.equal('airport-unused' in providers, false);
  assert.equal(providers['sukka-neteasemusic-2'].url, `${SUKKA_BASE}non_ip/neteasemusic.txt`);
  assert.deepEqual(output.rules, expectedRules({ netease: 'sukka-neteasemusic-2' }));
  assert.deepEqual(output.dns, input.dns);
  assert.match(logs[0].message, /3 airport rule-providers kept/);
});

test('names that collide with airport proxies, groups or providers get a deterministic suffix', () => {
  const input = collisionProfile();
  const { output } = runInNode(input);
  const [ret] = output['proxy-groups'];

  // 回国节点 is a node and 回国节点 2 an airport group.
  assert.equal(ret.name, '回国节点 3');
  assert.deepEqual(ret.proxies, ['回国节点', '上海']);
  assert.deepEqual(ret.use, ['GLOBAL']);
  assert.deepEqual(output.rules, expectedRules({ returnName: '回国节点 3' }));
  // A provider named GLOBAL leaves Mihomo's own GLOBAL alone; a second one would not parse.
  assert.equal(output['proxy-groups'].some((group) => group.name === 'GLOBAL'), false);
});

test('an expired subscription degrades to DIRECT instead of failing the whole profile', () => {
  const { output } = runInNode(expiredProfile());

  assert.deepEqual(groupByName(output, RETURN).proxies, ['DIRECT']);
  assert.deepEqual(output.rules, DEFAULT_RULES);
});

test('the shape FlClash actually passes, with null maps and defaults, is handled', () => {
  const input = flclashShapedProfile();
  const { output } = runInNode(input);

  assertAirportRootPreserved(input, output);
  assert.deepEqual(output.rules, DEFAULT_RULES);
  assert.equal('use' in groupByName(output, RETURN), false);
});

test('turning ad blocking off removes only the reject sets', () => {
  const source = withSettings([['blockAds: true,', 'blockAds: false,']]);
  const { output } = runInNode(subconverterProfile(), source);

  assert.deepEqual(output.rules, expectedRules({ blockAds: false }));
  assert.equal(Object.keys(output['rule-providers']).some((name) => /reject|-ads$|unblock/.test(name)), false);
});

test('routing media CDNs home removes only the CDN DIRECT exceptions', () => {
  const source = withSettings([['mediaCdnViaReturn: false,', 'mediaCdnViaReturn: true,']]);
  const { output } = runInNode(subconverterProfile(), source);

  assert.deepEqual(output.rules, expectedRules({ mediaCdnViaReturn: true }));
  assert.equal('sukka-domestic-cdn' in output['rule-providers'], false);
  assert.equal('geosite-bilibili-cdn' in output['rule-providers'], false);
});

test('an unexpected airport shape degrades to a visible all-DIRECT profile instead of throwing', () => {
  const { context, logs } = createNodeScriptContext();
  const input = subconverterProfile();
  input['proxy-providers'] = {
    weird: {
      get 'dialer-proxy'() {
        throw new Error('unexpected shape');
      },
    },
  };
  const output = context.main(input);

  // Objects built inside the vm realm are compared after copying them into this one.
  assert.deepEqual(JSON.parse(JSON.stringify(output['proxy-groups'][0])), {
    name: '⚠️ 回国脚本异常', type: 'select', proxies: ['DIRECT'],
  });
  assert.deepEqual([...output['proxy-groups'].slice(1)], input['proxy-groups']);
  assert.deepEqual([...output.rules], ['MATCH,DIRECT']);
  assert.equal(output.dns, input.dns);
  assert.match(logs.at(-1).message, /degraded: Error: unexpected shape/);
});

test('main never throws, even for input FlClash would never send', () => {
  const { context } = createNodeScriptContext();
  for (const input of [null, undefined, 'text', 42, []]) {
    assert.doesNotThrow(() => context.main(input));
  }
});

test('the returned object is a new object and the input is not mutated', () => {
  const { context } = createNodeScriptContext();
  const input = subconverterProfile();
  const snapshot = JSON.stringify(input);
  const output = context.main(input);

  assert.notEqual(output, input);
  assert.equal(JSON.stringify(input), snapshot);
});
