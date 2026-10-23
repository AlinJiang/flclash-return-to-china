/**
 * FlClash 回国分流 Override Script
 *
 * FlClash 每次应用机场原生 URL Profile 时，把最新完整配置传给 main(config)。
 * 本脚本保留机场的节点、proxy-providers、DNS、hosts、sniffer、NTP 和其他根配置，
 * 只接管路由：只有必须用中国大陆 IP 的服务（影音版权、淘宝、政务、银行、运营商）
 * 走「回国节点」，其余流量（包括海外能正常用的国内服务）直连，并去广告。
 * 回国节点全部不可用时，这些服务自动改走直连，节点恢复后自动切回。
 * 应急用 FlClash 自己的出站模式：「全局」让所有流量回国，「直连」让所有流量直连。
 *
 * 名单几乎全部来自社区持续维护的规则集，由每台设备的核心按间隔自动更新：
 * v2fly/domain-list-community（MetaCubeX/meta-rules-dat 每日构建）和 Sukka 规则集。
 * 自己维护的只有仓库 rules/ 下的 direct.txt、return.txt 和 unblock.txt。
 *
 * 不含任何机场 URL、token 或节点凭据，可以公开托管。
 * 运行环境是 FlClash 0.9.1 内置的 QuickJS-ng：不要使用 structuredClone、import、
 * fetch 或定时器。console 输出只写到 stderr，界面里看不到。
 */

// ===== 用户设置 =====
const SETTINGS = {
  // 自己维护的规则文件所在目录：本仓库 main 分支的 rules/。
  // direct.txt 直连，return.txt 走回国，两者紧跟在去广告之后、所有社区名单之前。
  // unblock.txt 是被去广告误拦的域名，放行后按其余规则分流。
  ownRulesBase: 'https://raw.githubusercontent.com/AlinJiang/flclash-return-to-china/main/rules/',

  // 去广告：Sukka reject 规则集，加上 v2fly 各影音平台的广告和统计域名。
  // Sukka 的列表同时拦截 App 自带的 HTTPDNS，让它们改用系统 DNS，回国名单才能按域名匹配。
  blockAds: true,

  // 只影响 B 站视频（v2fly bilibili-cdn）和网易云音频等（Sukka domestic_cdn）：默认 false，
  // 它们海外直连；改成 true 后随平台名单走回国。其他平台的 CDN 不在回国名单里，不受影响。
  mediaCdnViaReturn: false,
};

const SCRIPT_VERSION = '3.3.0';

// FlClash 按组名记住手动选择，不要随意改名。
const RETURN_GROUP = '回国节点';
// 规则指向的隐藏组：回国节点能用就走它，整组都挂了改走直连，恢复后自动切回。
const FALLBACK_GROUP = '回国或直连';
// 只装着一个直连出口的订阅源，让直连排在机场订阅的节点之后（见 buildFallbackGroup）。
const DIRECT_PROVIDER = '回国直连';
const DEGRADED_GROUP = '⚠️ 回国脚本异常';

// Return nodes exit inside mainland China, so a foreign endpoint would measure a
// second border crossing. expected-status turns hijack pages into failures.
// Plain HTTP: every check is return traffic, which airports meter (EdNovas at
// 5x), and a TLS handshake here costs about 7 KB against 0.4 KB without it.
const HEALTH_CHECK = {
  url: 'http://wifi.vivo.com.cn/generate_204',
  'expected-status': '204',
};

// Airport notice and quota pseudo-nodes. Plain alternation only: JS compiles it
// with flags, Mihomo's regexp2 with an inline (?i), and a backtick would split it.
const NOTICE_PATTERN = [
  '官网', '网址', '地址', '剩余', '已用', '总流量', '到期', '过期', '有效期',
  '重置', '套餐', '订阅', '群', '频道', '客服', '公告',
  'traffic', 'expire', 'website', 'https?://',
].join('|');
const NOTICE_NODE = new RegExp(NOTICE_PATTERN, 'iu');
const NOTICE_EXCLUDE_FILTER = `(?i)${NOTICE_PATTERN}`;

// Names that mark a mainland exit. An airport that sells both directions marks
// its return nodes like this (🇨🇳 北京, 港广专线_回国); when no node matches,
// every node counts, as on a return-only airport whose names give no hint.
// 香港 is no sign either way: 上海 香港中转 exits in Shanghai.
const MAINLAND_NODE = /🇨🇳|回国|大陆|内地/u;

// Proxy types that never forward traffic to a remote exit: YAML types for
// inline nodes, Mihomo adapter types for the exclude-type of provider nodes.
const NON_FORWARDING_TYPES = new Set(['direct', 'dns', 'reject', 'rematch']);
const NON_FORWARDING_EXCLUDE_TYPE = 'Direct|Dns|Reject|RejectDrop|Rematch';

// Names Mihomo registers before any profile entry, plus the generated GLOBAL.
const BUILTIN_NAMES = [
  'DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE', 'GLOBAL',
];

// Sections this script replaces. Everything else is the airport's.
const ROUTING_KEYS = new Set(['proxy-groups', 'rule-providers', 'sub-rules', 'rules']);


const SUKKA_BASE = 'https://ruleset.skk.moe/Clash/';
const GEOSITE_BASE = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/';

// FlClash rewrites every provider path to md5(name@url), so names and URLs stay
// stable to keep each device's cache warm. Upstream refresh cadences: Sukka
// twice a day, meta-rules-dat daily, our own files on every push.
function sukka(file, behavior) {
  return { type: 'http', behavior, format: 'text', url: `${SUKKA_BASE}${file}.txt`, interval: 43200, proxy: 'DIRECT' };
}

function geosite(name) {
  const file = name.replace('@', '%40').replace('!', '%21');
  return { type: 'http', behavior: 'domain', format: 'mrs', url: `${GEOSITE_BASE}${file}.mrs`, interval: 86400, proxy: 'DIRECT' };
}

function own(file) {
  return { type: 'http', behavior: 'classical', format: 'text', url: `${SETTINGS.ownRulesBase}${file}`, interval: 3600, proxy: 'DIRECT' };
}

// v2fly lists whose mainland service needs a China IP. Each full list also
// carries the overseas edition, marked @!cn, which goes DIRECT first.
const MEDIA_LISTS = ['bilibili', 'iqiyi', 'youku', 'hunantv', 'cctv', 'tencent-tme'];
const BANK_CARRIER_LISTS = [
  'icbc', 'boc', 'ccb', 'cmb', 'citic', 'pingan', 'unionpay', 'category-bank-cn',
  'chinamobile', 'chinatelecom', 'chinaunicom',
];
const OVERSEAS_EDITION_LISTS = [
  'bilibili', 'iqiyi', 'youku', 'icbc', 'boc', 'ccb', 'cmb', 'citic', 'pingan',
  'chinamobile', 'chinatelecom', 'chinaunicom',
];
// v2fly marks these platforms' ad and analytics hosts @ads; Sukka misses some.
const MEDIA_AD_LISTS = ['iqiyi', 'youku', 'hunantv', 'tencent-tme', 'cctv'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueName(base, taken, separator) {
  let name = base;
  for (let index = 2; taken.has(name); index += 1) {
    name = `${base}${separator}${index}`;
  }
  taken.add(name);
  return name;
}

function inlineProxies(config) {
  return Array.isArray(config.proxies) ? config.proxies.filter(isObject) : [];
}

function proxyProviders(config) {
  return isObject(config['proxy-providers']) ? config['proxy-providers'] : {};
}

/**
 * Inline nodes and proxy-providers that serve as the first hop of a
 * dialer-proxy chain. They exit wherever they are, usually outside mainland
 * China, and would otherwise win url-test by skipping the extra hop.
 *
 * A target group contributes the nodes it lists and the providers it uses as a
 * whole. Members it would pick by include-all-proxies count as every inline
 * node: the script does not evaluate group filters. A provider whose own
 * config chains every node through dialer-proxy holds exits, never relays.
 */
function frontHops(config, inlineNames, providerNames) {
  const groups = new Map(
    (Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [])
      .filter(isObject)
      .map((group) => [group.name, group]),
  );
  const providerConfigs = proxyProviders(config);
  const chainsEveryNode = (name) => {
    const provider = providerConfigs[name];
    return isObject(provider) && (typeof provider['dialer-proxy'] === 'string'
      || (isObject(provider.override) && typeof provider.override['dialer-proxy'] === 'string'));
  };
  const inline = new Set();
  const providers = new Set();
  const visited = new Set();
  const add = (name) => {
    if (typeof name !== 'string' || visited.has(name)) {
      return;
    }
    visited.add(name);
    if (inlineNames.has(name)) {
      inline.add(name);
    }
    const group = groups.get(name);
    if (!group) {
      return;
    }
    for (const member of Array.isArray(group.proxies) ? group.proxies : []) {
      add(member);
    }
    const includeAll = group['include-all'] === true;
    const used = includeAll || group['include-all-providers'] === true
      ? providerNames
      : Array.isArray(group.use) ? group.use : [];
    for (const provider of used.filter((name) => !chainsEveryNode(name))) {
      providers.add(provider);
    }
    if (includeAll || group['include-all-proxies'] === true) {
      for (const proxyName of inlineNames) {
        inline.add(proxyName);
      }
    }
  };
  for (const proxy of inlineProxies(config)) {
    add(proxy['dialer-proxy']);
  }
  for (const provider of Object.values(providerConfigs)) {
    if (!isObject(provider)) {
      continue;
    }
    add(provider['dialer-proxy']);
    add(isObject(provider.override) ? provider.override['dialer-proxy'] : undefined);
    for (const proxy of Array.isArray(provider.payload) ? provider.payload : []) {
      add(isObject(proxy) ? proxy['dialer-proxy'] : undefined);
    }
  }
  return { inline, providers };
}

/** Inline node names and proxy-provider names the return groups draw from. */
function returnMembers(config) {
  const proxies = inlineProxies(config);
  const inlineNames = new Set(proxies.map((proxy) => proxy.name));
  const providerNames = Object.keys(proxyProviders(config));
  const nodes = unique(
    proxies
      .filter((proxy) => !NON_FORWARDING_TYPES.has(String(proxy.type).toLowerCase()))
      .map((proxy) => proxy.name)
      .filter((name) => typeof name === 'string' && name !== '' && !NOTICE_NODE.test(name)),
  );
  const hops = frontHops(config, inlineNames, providerNames);
  const exits = nodes.filter((name) => !hops.inline.has(name));
  const mainland = exits.filter((name) => MAINLAND_NODE.test(name));
  const exitNodes = mainland.length > 0 ? mainland : exits;
  const exitProviders = providerNames.filter((name) => !hops.providers.has(name));
  // Without a recognizable exit, offering the hops beats offering nothing.
  return exitNodes.length > 0 || exitProviders.length > 0
    ? { nodes: exitNodes, providers: exitProviders }
    : { nodes, providers: providerNames };
}

/** Visits every string, including object keys, below the given values. */
function forEachString(values, visit) {
  const stack = [...values];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      visit(value);
    } else if (Array.isArray(value)) {
      // No spread: QuickJS-ng caps call arguments at 65535.
      for (const item of value) {
        stack.push(item);
      }
    } else if (isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(key);
        stack.push(child);
      }
    }
  }
}

/**
 * Airport rule-providers that retained sections still name, for example
 * dns.nameserver-policy "rule-set:x" or sniffer skip-domain entries. Mihomo
 * rejects the whole config at parse time when such a name is missing.
 * Over-approximates: any string that contains a provider's name keeps it,
 * since keeping an unused provider only costs a download.
 */
function referencedRuleProviders(config) {
  const providers = isObject(config['rule-providers']) ? config['rule-providers'] : {};
  const names = Object.keys(providers).filter((name) => name !== '');
  if (names.length === 0) {
    return {};
  }
  const kept = new Set();
  let frontier = [];
  const visit = (text) => {
    for (const name of names) {
      if (!kept.has(name) && text.includes(name)) {
        kept.add(name);
        frontier.push(name);
      }
    }
  };
  forEachString(
    Object.entries(config).filter(([key]) => !ROUTING_KEYS.has(key)).map(([, value]) => value),
    visit,
  );
  while (frontier.length > 0) {
    const current = frontier;
    frontier = [];
    forEachString(current.map((name) => providers[name]), visit);
  }
  return Object.fromEntries(Object.entries(providers).filter(([name]) => kept.has(name)));
}

/** The return nodes as 回国节点's members, with the filters provider nodes need at runtime. */
function memberOptions({ nodes, providers: providerNames }) {
  // An expired subscription can leave no nodes at all. A group needs a member
  // to parse, and DIRECT keeps China traffic working.
  const members = nodes.length === 0 && providerNames.length === 0
    ? { proxies: ['DIRECT'] }
    : { ...(nodes.length > 0 ? { proxies: nodes } : {}), ...(providerNames.length > 0 ? { use: providerNames } : {}) };
  return {
    ...members,
    // Provider nodes are only known at runtime; inline ones are filtered above.
    'exclude-filter': NOTICE_EXCLUDE_FILTER,
    ...(providerNames.length > 0 ? { 'exclude-type': NON_FORWARDING_EXCLUDE_TYPE } : {}),
  };
}

/**
 * The one group users see. url-test picks the fastest return node; tapping a
 * node in FlClash pins it, and the core leaves a pinned node only while it is
 * down (adapter/outboundgroup/urltest.go).
 */
function buildReturnGroup(name, members) {
  return {
    name,
    type: 'url-test',
    ...memberOptions(members),
    ...HEALTH_CHECK,
    // Each check tests every node. Mihomo keeps the results per node and test
    // URL, shared with 回国或直连, so both see a dead node within a minute. A
    // provider also takes the interval of the first group that registers its
    // URL (adapter/provider/healthcheck.go), so both groups use the same one.
    interval: 60,
    // Stay on a node until another is 300 ms faster: return traffic is APIs and
    // media, where that gap goes unnoticed, and each switch changes the exit
    // address. Over a day of EdNovas checks, 50 ms switched 18 times, 300 ms 10,
    // for 14 ms more on average.
    tolerance: 300,
    lazy: true,
  };
}


/**
 * The group the rules use: 回国节点, then every return node on its own, then
 * DIRECT. fallback takes the first member that passed its last check
 * (adapter/outboundgroup/fallback.go). A group is checked through the node it
 * is on, so when that node fails a check, return traffic moves to another
 * node, and goes DIRECT, where region-locked APIs fail, only when every node
 * failed. The check URL answers from abroad too, so DIRECT always passes.
 *
 * A group lists its own proxies before its providers' nodes
 * (adapter/outboundgroup/parser.go), so with providers DIRECT comes from a
 * one-node provider listed last.
 */
function buildFallbackGroup(name, returnName, { nodes, providers: providerNames }, directProvider) {
  const members = providerNames.length === 0
    ? { proxies: [returnName, ...nodes, 'DIRECT'] }
    : {
      proxies: [returnName, ...nodes],
      use: [...providerNames, directProvider],
      'exclude-filter': NOTICE_EXCLUDE_FILTER,
      // Without Direct, which would drop the last resort; an airport's own
      // direct nodes would join, as they do nowhere else.
      'exclude-type': NON_FORWARDING_EXCLUDE_TYPE.replace('Direct|', ''),
    };
  return {
    name,
    type: 'fallback',
    ...members,
    ...HEALTH_CHECK,
    // Back on 回国节点 within a minute of it answering again.
    interval: 60,
    lazy: true,
    hidden: true,
  };
}

/**
 * The routing plan in rule order. Each step is one rule-provider and the rule
 * that uses it: [name, provider, target]. RETURN stands for the 回国或直连 group
 * name, resolved after collision handling. UNBLOCK marks the set the ad rules
 * skip; it has no rule of its own.
 */
const RETURN = Symbol('回国节点');
const UNBLOCK = Symbol('放行');

function routingPlan() {
  const steps = [];
  if (SETTINGS.blockAds) {
    steps.push(
      ['own-unblock', own('unblock.txt'), UNBLOCK],
      ['sukka-reject-drop', sukka('non_ip/reject-drop', 'classical'), 'REJECT-DROP'],
      ['sukka-reject-domainset', sukka('domainset/reject', 'domain'), 'REJECT'],
      ['sukka-reject', sukka('non_ip/reject', 'classical'), 'REJECT'],
      ['sukka-reject-no-drop', sukka('non_ip/reject-no-drop', 'classical'), 'REJECT'],
      ...MEDIA_AD_LISTS.map((name) => [`geosite-${name}-ads`, geosite(`${name}@ads`), 'REJECT']),
    );
  }
  steps.push(
    // Our own files win over every community list, but not over ad blocking:
    // a suffix there must not let the ad hosts below it through.
    ['own-direct', own('direct.txt'), 'DIRECT'],
    ['own-return', own('return.txt'), RETURN],
    ...OVERSEAS_EDITION_LISTS.map((name) => [`geosite-${name}-overseas`, geosite(`${name}@!cn`), 'DIRECT']),
  );
  if (!SETTINGS.mediaCdnViaReturn) {
    // Sukka's own position: these CDNs should be DIRECT abroad.
    steps.push(
      ['sukka-domestic-cdn', sukka('non_ip/domestic_cdn', 'classical'), 'DIRECT'],
      ['geosite-bilibili-cdn', geosite('bilibili-cdn'), 'DIRECT'],
    );
  }
  steps.push(
    ...MEDIA_LISTS.map((name) => [`geosite-${name}`, geosite(name), RETURN]),
    ['sukka-neteasemusic', sukka('non_ip/neteasemusic', 'classical'), RETURN],
    ...BANK_CARRIER_LISTS.map((name) => [`geosite-${name}`, geosite(name), RETURN]),
    ['sukka-neteasemusic-ip', sukka('ip/neteasemusic', 'classical'), RETURN],
  );
  return steps;
}

function buildRules(plan, providerNames, returnName) {
  const target = (value) => (value === RETURN ? returnName : value);
  // no-resolve on every set: matching never waits on DNS, whatever an upstream
  // line says, and IP entries only match connections made to an IP.
  const matcher = (name) => `RULE-SET,${providerNames[name]},no-resolve`;
  const unblock = plan.find(([, , value]) => value === UNBLOCK);
  const rules = [];
  // A rule whose group cannot carry UDP (SSR nodes without udp) is skipped for
  // UDP and matching goes on. Rejecting that QUIC before any later rule could
  // send it DIRECT makes clients retry over TCP through the group instead.
  let unguarded = [];
  const guard = () => {
    if (unguarded.length > 0) {
      const sets = unguarded.map((name) => `(${matcher(name)})`).join(',');
      rules.push(`AND,((NETWORK,UDP),(DST-PORT,443),(OR,(${sets}))),REJECT`);
    }
    unguarded = [];
  };
  for (const [name, , value] of plan) {
    if (value === UNBLOCK) {
      continue;
    }
    const rejects = value === 'REJECT' || value === 'REJECT-DROP';
    if (!rejects && value !== RETURN) {
      guard();
    }
    if (rejects && unblock) {
      rules.push(`AND,((${matcher(name)}),(NOT,((${matcher(unblock[0])})))),${value}`);
    } else {
      rules.push(`RULE-SET,${providerNames[name]},${target(value)},no-resolve`);
    }
    if (value === RETURN) {
      unguarded.push(name);
    }
  }
  guard();
  rules.push('MATCH,DIRECT');
  return rules;
}

/** Throws if a generated reference would make Mihomo reject the whole config. */
function assertResolvable(output, ourGroups) {
  const groupNames = new Set(output['proxy-groups'].map((group) => group?.name));
  const known = new Set([
    ...BUILTIN_NAMES,
    ...inlineProxies(output).map((proxy) => proxy.name),
    ...groupNames,
  ]);
  const providers = new Set(Object.keys(proxyProviders(output)));
  for (const group of ourGroups) {
    for (const member of group.proxies ?? []) {
      if (!known.has(member)) {
        throw new Error(`group ${group.name} references missing ${member}`);
      }
    }
    for (const provider of group.use ?? []) {
      if (!providers.has(provider)) {
        throw new Error(`group ${group.name} uses missing provider ${provider}`);
      }
    }
  }
  for (const rule of output.rules) {
    for (const [, name] of rule.matchAll(/RULE-SET,([^,()]+)/g)) {
      if (!Object.hasOwn(output['rule-providers'], name)) {
        throw new Error(`rule ${rule} references missing rule-provider ${name}`);
      }
    }
  }
}

/**
 * FlClash's Global mode sends everything through GLOBAL, so 回国节点 comes
 * first there: switching to Global is the one-tap "everything home". Mihomo
 * only generates GLOBAL when the profile has none, defaulting to DIRECT, so
 * the script defines it; an airport's own select GLOBAL gets 回国节点 first.
 */
function withGlobal(airportGroups, returnName, takenNames) {
  const own = airportGroups.find((group) => isObject(group) && group.name === 'GLOBAL');
  if (own === undefined) {
    if (takenNames.has('GLOBAL')) {
      return airportGroups;
    }
    // Hidden: FlClash shows every group in Global mode and hides it in Rule mode.
    return [{ name: 'GLOBAL', type: 'select', hidden: true, proxies: [returnName, 'DIRECT'] }, ...airportGroups];
  }
  return airportGroups.map((group) => (group === own && group.type === 'select'
    ? { ...group, proxies: unique([returnName, ...(Array.isArray(group.proxies) ? group.proxies : [])]) }
    : group));
}

function buildProfile(config) {
  if (!isObject(config)) {
    throw new Error('airport profile must be a configuration object');
  }

  const airportGroups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  const providerNames = Object.keys(proxyProviders(config));
  const members = returnMembers(config);

  const takenGroupNames = new Set([
    ...BUILTIN_NAMES,
    ...inlineProxies(config).map((proxy) => proxy.name),
    ...airportGroups.map((group) => group?.name),
    ...providerNames,
  ]);
  const returnName = uniqueName(RETURN_GROUP, takenGroupNames, ' ');
  const fallbackName = uniqueName(FALLBACK_GROUP, takenGroupNames, ' ');

  const keptRuleProviders = referencedRuleProviders(config);
  const takenProviderNames = new Set([...Object.keys(keptRuleProviders), ...providerNames]);
  const plan = routingPlan();
  const ourProviderNames = {};
  const ruleProviders = { ...keptRuleProviders };
  for (const [name, provider] of plan) {
    ourProviderNames[name] = uniqueName(name, takenProviderNames, '-');
    ruleProviders[ourProviderNames[name]] = { ...provider };
  }

  const returnGroup = buildReturnGroup(returnName, members);
  // Provider and group names share one namespace in Mihomo.
  const directProvider = members.providers.length > 0 ? uniqueName(DIRECT_PROVIDER, takenGroupNames, ' ') : null;
  const fallbackGroup = buildFallbackGroup(fallbackName, returnName, members, directProvider);
  const output = { ...config };
  delete output['sub-rules'];
  // Airport groups stay because dialer-proxy, DNS "#group", tunnels and remote
  // provider payloads may name them. No rule points at them any more, so they
  // are hidden from the Rule-mode proxies page.
  const keptGroups = airportGroups.map((group) => (isObject(group) ? { ...group, hidden: true } : group));
  const proxyNames = new Set([...inlineProxies(config).map((proxy) => proxy.name), ...providerNames]);
  const groups = [returnGroup, fallbackGroup, ...withGlobal(keptGroups, returnName, proxyNames)];
  output['proxy-groups'] = groups;
  if (directProvider) {
    output['proxy-providers'] = {
      ...config['proxy-providers'],
      [directProvider]: { type: 'inline', payload: [{ name: 'DIRECT', type: 'direct' }] },
    };
  }
  output['rule-providers'] = ruleProviders;
  output.rules = buildRules(plan, ourProviderNames, fallbackName);
  const ours = new Set([returnGroup, fallbackGroup]);
  assertResolvable(output, groups.filter((group) => ours.has(group) || group?.name === 'GLOBAL'));

  console.log(
    `[return-to-china ${SCRIPT_VERSION}] ${members.nodes.length} nodes, ${members.providers.length} proxy providers, `
      + `${airportGroups.length} airport groups kept, ${Object.keys(keptRuleProviders).length} airport rule-providers kept`,
  );
  return output;
}

/**
 * Last resort for an airport shape this script did not anticipate. Throwing
 * would make FlClash push an empty config and close its listener, so keep the
 * airport profile intact, send everything DIRECT and show a warning group.
 */
function degradedProfile(config) {
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  const taken = new Set([
    ...BUILTIN_NAMES,
    ...inlineProxies(config).map((proxy) => proxy.name),
    ...groups.map((group) => group?.name),
    ...Object.keys(proxyProviders(config)),
  ]);
  return {
    ...config,
    'proxy-groups': [
      { name: uniqueName(DEGRADED_GROUP, taken, ' '), type: 'select', proxies: ['DIRECT'] },
      ...groups,
    ],
    rules: ['MATCH,DIRECT'],
  };
}

function main(config) {
  try {
    return buildProfile(config);
  } catch (error) {
    console.error(`[return-to-china ${SCRIPT_VERSION}] degraded: ${error?.stack ?? error}`);
    try {
      return degradedProfile(config);
    } catch {
      return config;
    }
  }
}
