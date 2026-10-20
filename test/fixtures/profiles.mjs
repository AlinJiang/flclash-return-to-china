// Synthetic airport profiles. Every server, credential and URL here is fake:
// servers use .invalid names or TEST-NET addresses and secrets are "test-only".

const ss = (name, server, extra = {}) => ({
  name, type: 'ss', server, port: 8388, cipher: 'aes-128-gcm', password: 'test-only', udp: true, ...extra,
});
const ssr = (name, server, extra = {}) => ({
  name, type: 'ssr', server, port: 8389, cipher: 'aes-256-cfb', password: 'test-only',
  obfs: 'plain', protocol: 'origin', ...extra,
});
const trojan = (name, server, extra = {}) => ({
  name, type: 'trojan', server, port: 443, password: 'test-only', sni: 'node.invalid', udp: true, ...extra,
});

const AIRPORT_TEST_URL = 'http://cp.cloudflare.com/generate_204';

function airportDns() {
  return {
    enable: true,
    ipv6: false,
    'default-nameserver': ['192.0.2.53', '198.51.100.53'],
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'use-hosts': true,
    nameserver: ['https://doh-cn.invalid/dns-query', 'https://doh-cn2.invalid/dns-query'],
    fallback: ['https://doh-global.invalid/dns-query', 'tls://192.0.2.54:853'],
    'fallback-filter': { geoip: true, 'geoip-code': 'CN', ipcidr: ['240.0.0.0/4', '0.0.0.0/32'] },
  };
}

/** Same shape as the user's current subconverter profile: inline nodes, one notice node. */
export function subconverterProfile() {
  const nodes = ['服务到期日：2026-11-19', '港广专线_回国', '港沪专线_回国'];
  return {
    port: 37890,
    'socks-port': 37891,
    'allow-lan': false,
    mode: 'Rule',
    'log-level': 'info',
    'external-controller': '127.0.0.1:9090',
    secret: 'test-only',
    dns: airportDns(),
    proxies: [
      ssr(nodes[0], '127.0.0.1'),
      ssr(nodes[1], 'gz.node.invalid'),
      trojan(nodes[2], 'sh.node.invalid'),
    ],
    'proxy-groups': [
      { name: '🚀 节点选择', type: 'select', proxies: ['♻️ 自动选择', '♻️ 自动选择_故障转移', ...nodes, 'DIRECT', '负载均衡'] },
      { name: '♻️ 自动选择', type: 'url-test', url: AIRPORT_TEST_URL, interval: 300, proxies: nodes },
      { name: '♻️ 自动选择_故障转移', type: 'fallback', url: AIRPORT_TEST_URL, interval: 300, proxies: nodes },
      { name: '🌍 国外媒体', type: 'select', proxies: ['🚀 节点选择', '♻️ 自动选择', '🎯 全球直连', ...nodes] },
      { name: '🎯 全球直连', type: 'select', proxies: ['DIRECT', '🚀 节点选择', '♻️ 自动选择'] },
      { name: '🛑 广告拦截', type: 'select', proxies: ['REJECT', 'DIRECT'] },
      { name: '🐟 漏网之鱼', type: 'select', proxies: ['🚀 节点选择', '🎯 全球直连', '♻️ 自动选择', ...nodes] },
      { name: '负载均衡', type: 'load-balance', url: AIRPORT_TEST_URL, interval: 300, proxies: nodes },
    ],
    rules: [
      'DOMAIN-SUFFIX,google.com,🚀 节点选择',
      'DOMAIN-SUFFIX,doubleclick.net,🛑 广告拦截',
      'GEOIP,CN,🎯 全球直连',
      'MATCH,🐟 漏网之鱼',
    ],
  };
}

/** A later version of the same airport: providers replace inline nodes, groups renamed, root settings changed. */
export function providerProfile() {
  return {
    'mixed-port': 7890,
    'allow-lan': true,
    mode: 'rule',
    dns: {
      ...airportDns(),
      nameserver: ['https://doh-new.invalid/dns-query'],
      'proxy-server-nameserver': ['https://doh-bootstrap.invalid/dns-query'],
    },
    hosts: { 'service.invalid': '192.0.2.10' },
    sniffer: { enable: true, sniff: { TLS: { ports: [443] }, HTTP: { ports: [80], 'override-destination': true } } },
    ntp: { enable: true, server: 'time.invalid', port: 123, interval: 30 },
    'proxy-providers': {
      机场节点: {
        type: 'http',
        url: 'https://airport.invalid/api/v1/client/subscribe?token=test-only',
        interval: 3600,
        header: { 'User-Agent': ['mihomo'], Authorization: ['Bearer test-only'] },
        'health-check': { enable: true, url: AIRPORT_TEST_URL, interval: 600 },
        override: { 'additional-prefix': '[回国] ' },
      },
    },
    'proxy-groups': [
      { name: '✈️ 机场节点', type: 'select', use: ['机场节点'] },
      { name: '⚡ 低延迟', type: 'url-test', use: ['机场节点'], url: AIRPORT_TEST_URL, interval: 300 },
    ],
    rules: ['GEOIP,CN,DIRECT', 'MATCH,✈️ 机场节点'],
  };
}

/** Inline nodes plus an http provider plus an inline provider that carries a quota pseudo-node. */
export function mixedProfile() {
  return {
    'mixed-port': 7890,
    dns: airportDns(),
    proxies: [trojan('上海 IPLC 01', '192.0.2.21'), trojan('北京 BGP 0.5倍流量', '192.0.2.22')],
    'proxy-providers': {
      backup: { type: 'http', url: 'https://airport.invalid/backup?token=test-only', interval: 7200 },
      static: {
        type: 'inline',
        payload: [ss('剩余流量：100 GB', '127.0.0.1'), ss('深圳 02', '192.0.2.23')],
      },
    },
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['上海 IPLC 01'], use: ['backup', 'static'] }],
    rules: ['MATCH,PROXY'],
  };
}

/** Chains and other retained sections that name airport groups at parse time. */
export function chainProfile() {
  return {
    'mixed-port': 7890,
    dns: { ...airportDns(), nameserver: ['https://doh-cn.invalid/dns-query#🔗 前置节点&h3=false'] },
    ntp: { enable: true, server: 'time.invalid', port: 123, interval: 30, 'dialer-proxy': '🔗 前置节点' },
    tunnels: ['tcp/udp,127.0.0.1:6553,192.0.2.53:53,🔗 前置节点'],
    listeners: [{ name: 'chain-in', type: 'mixed', port: 17890, proxy: '🔗 前置节点' }],
    proxies: [
      ss('香港中转', 'hk.relay.invalid'),
      ss('深圳中转', 'sz.relay.invalid'),
      ss('上海落地', 'sh.exit.invalid', { 'dialer-proxy': '香港中转' }),
      trojan('广州落地', 'gz.exit.invalid', { 'dialer-proxy': '🔗 前置节点' }),
      { name: '直连出口', type: 'direct' },
    ],
    'proxy-groups': [
      { name: '🔗 前置节点', type: 'select', proxies: ['深圳中转', 'DIRECT'] },
      { name: '🚀 节点选择', type: 'select', proxies: ['上海落地', '广州落地', '🔗 前置节点'] },
    ],
    'sub-rules': { inner: ['MATCH,🚀 节点选择'] },
    rules: ['SUB-RULE,(NETWORK,TCP),inner', 'MATCH,🚀 节点选择'],
  };
}

/** Relays that come from providers, provider-level chains, and non-forwarding provider nodes. */
export function providerChainProfile() {
  return {
    'mixed-port': 7890,
    proxies: [ss('香港中转', 'hk.relay.invalid'), trojan('上海落地', 'sh.exit.invalid')],
    'proxy-providers': {
      relay: { type: 'inline', payload: [ss('香港中转 01', 'hk1.relay.invalid'), ss('香港中转 02', 'hk2.relay.invalid')] },
      exits: {
        type: 'http',
        url: 'https://airport.invalid/exits?token=test-only',
        interval: 3600,
        override: { 'dialer-proxy': '🔗 前置' },
      },
      'static-exits': {
        type: 'inline',
        payload: [
          trojan('广州落地', 'gz.exit.invalid', { 'dialer-proxy': '香港中转' }),
          { name: '直连备用', type: 'direct' },
          { name: 'DNS出口', type: 'dns' },
        ],
      },
    },
    'proxy-groups': [{ name: '🔗 前置', type: 'url-test', use: ['relay'], url: AIRPORT_TEST_URL, interval: 300 }],
    rules: ['MATCH,DIRECT'],
  };
}

/** Every inline node is a relay; the real exits only exist in a provider. */
export function allRelaysProfile() {
  return {
    'mixed-port': 7890,
    proxies: [ss('香港中转 01', 'hk1.relay.invalid'), ss('香港中转 02', 'hk2.relay.invalid')],
    'proxy-providers': {
      exits: {
        type: 'inline',
        payload: [trojan('上海回国 01', 'sh.exit.invalid')],
        override: { 'dialer-proxy': '中转' },
      },
    },
    'proxy-groups': [{ name: '中转', type: 'select', proxies: ['香港中转 01', '香港中转 02'] }],
    rules: ['MATCH,中转'],
  };
}

/**
 * The classic chain: an overseas provider, a region group picking its relays
 * by filter, and mainland landing nodes. Exit names share the filter word,
 * which the group never applies to them, and the provider's other overseas
 * nodes are not exits either.
 */
export function regionRelaysProfile() {
  return {
    'mixed-port': 7890,
    proxies: [
      trojan('上海 IEPL 落地', 'sh.exit.invalid', { 'dialer-proxy': '🔗 IEPL 中转' }),
      trojan('广州 IEPL 落地', 'gz.exit.invalid', { 'dialer-proxy': '🔗 IEPL 中转' }),
    ],
    'proxy-providers': {
      overseas: {
        type: 'inline',
        payload: [
          ss('香港 IEPL 01', 'hk1.relay.invalid'), ss('香港 IEPL 02', 'hk2.relay.invalid'),
          ss('日本 IEPL 01', 'jp1.relay.invalid'), ss('美国 01', 'us1.node.invalid'),
        ],
      },
      // Chained as a whole by its own dialer-proxy: every node is an exit.
      home: { type: 'inline', 'dialer-proxy': '🔗 IEPL 中转', payload: [trojan('北京 01', 'bj.exit.invalid')] },
    },
    'proxy-groups': [
      { name: '🔗 IEPL 中转', type: 'url-test', 'include-all-providers': true, filter: 'IEPL', url: AIRPORT_TEST_URL, interval: 300 },
    ],
    rules: ['MATCH,DIRECT'],
  };
}

/** An airport that defines its own GLOBAL group, so Mihomo does not generate one. */
export function airportGlobalProfile() {
  const base = subconverterProfile();
  return {
    ...base,
    'proxy-groups': [...base['proxy-groups'], { name: 'GLOBAL', type: 'select', proxies: ['🚀 节点选择', 'DIRECT'] }],
  };
}

/** Rule-provider names with parentheses and spaces, referenced from every retained form. */
export function punctuatedRuleSetProfile() {
  return {
    'mixed-port': 7890,
    dns: {
      ...airportDns(),
      'nameserver-policy': { 'rule-set:国内(域名)': ['https://doh-cn.invalid/dns-query'] },
      'fake-ip-filter-mode': 'rule',
      'fake-ip-filter': ['RULE-SET,lan (private),real-ip', 'MATCH,fake-ip'],
    },
    sniffer: { enable: true, 'skip-domain': ['rule-set:skip(1)'], sniff: { TLS: { ports: [443] } } },
    proxies: [trojan('上海 01', '192.0.2.31')],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['上海 01'] }],
    'rule-providers': {
      '国内(域名)': { type: 'inline', behavior: 'domain', payload: ['+.cn.invalid'] },
      'lan (private)': { type: 'inline', behavior: 'domain', payload: ['+.lan'] },
      'skip(1)': { type: 'inline', behavior: 'domain', payload: ['+.skip.invalid'] },
    },
    rules: ['MATCH,PROXY'],
  };
}

/** Retained DNS and sniffer sections that name airport rule-providers, one of them colliding with ours. */
export function ruleSetReferenceProfile() {
  return {
    'mixed-port': 7890,
    dns: {
      ...airportDns(),
      'nameserver-policy': {
        'rule-set:airport-cn': ['https://doh-cn.invalid/dns-query'],
        '+.corp.invalid,rule-set:sukka-neteasemusic': '192.0.2.53',
      },
      'fake-ip-filter': ['rule-set:airport-private', '+.lan'],
    },
    sniffer: { enable: true, 'skip-domain': ['rule-set:airport-private'], sniff: { TLS: { ports: [443] } } },
    proxies: [trojan('上海 01', '192.0.2.31')],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['上海 01'] }],
    'rule-providers': {
      'airport-cn': { type: 'inline', behavior: 'domain', payload: ['+.cn.invalid'] },
      'airport-private': { type: 'inline', behavior: 'domain', payload: ['+.lan', '+.local'] },
      'sukka-neteasemusic': { type: 'inline', behavior: 'domain', payload: ['+.corp.invalid'] },
      'airport-unused': {
        type: 'http', behavior: 'classical', format: 'text', interval: 86400, url: 'https://rules.invalid/unused.txt',
      },
    },
    rules: ['RULE-SET,airport-unused,PROXY', 'MATCH,DIRECT'],
  };
}

/** Airport names that collide with the script's group names. */
export function collisionProfile() {
  return {
    'mixed-port': 7890,
    proxies: [trojan('回国节点', '192.0.2.41'), trojan('上海', '192.0.2.42')],
    'proxy-groups': [{ name: '回国节点 2', type: 'select', proxies: ['回国节点', '上海'] }],
    'proxy-providers': {
      GLOBAL: { type: 'http', url: 'https://airport.invalid/fallback?token=test-only', interval: 3600 },
    },
    rules: ['MATCH,回国节点 2'],
  };
}

/** An expired subscription that only lists notice nodes. */
export function expiredProfile() {
  const nodes = ['剩余流量：0 GB', '套餐到期：2026-10-01', '官网 https://airport.invalid'];
  return {
    'mixed-port': 7890,
    proxies: nodes.map((name) => ss(name, '127.0.0.1')),
    'proxy-groups': [{ name: '🚀 节点选择', type: 'select', proxies: nodes }],
    rules: ['MATCH,🚀 节点选择'],
  };
}

/**
 * What FlClash really passes to main(): the airport YAML decoded into Mihomo's
 * RawConfig with defaults filled in, so unset maps arrive as null and
 * proxy-providers as {}.
 */
export function flclashShapedProfile() {
  const base = subconverterProfile();
  return {
    ...base,
    'mixed-port': 0,
    ipv6: true,
    'unified-delay': false,
    'tcp-concurrent': false,
    'find-process-mode': 'strict',
    'geodata-mode': false,
    'global-client-fingerprint': '',
    hosts: {},
    'proxy-providers': {},
    'rule-providers': null,
    'sub-rules': null,
    listeners: null,
    tunnels: null,
    profile: { 'store-selected': true, 'store-fake-ip': true },
    tun: { enable: false, stack: 'gvisor', 'dns-hijack': ['0.0.0.0:53'], 'auto-route': true, 'auto-detect-interface': true },
    sniffer: { enable: false, sniff: {}, 'force-domain': [], 'skip-domain': [], 'skip-src-address': [], 'skip-dst-address': [] },
    ntp: { enable: false, server: '', port: 0, interval: 0 },
  };
}

export const PROFILES = {
  subconverter: subconverterProfile,
  provider: providerProfile,
  mixed: mixedProfile,
  chain: chainProfile,
  providerChain: providerChainProfile,
  allRelays: allRelaysProfile,
  regionRelays: regionRelaysProfile,
  airportGlobal: airportGlobalProfile,
  ruleSetReference: ruleSetReferenceProfile,
  punctuatedRuleSet: punctuatedRuleSetProfile,
  collision: collisionProfile,
  expired: expiredProfile,
  flclashShaped: flclashShapedProfile,
};
