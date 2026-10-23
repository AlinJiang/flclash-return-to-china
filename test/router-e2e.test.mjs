// End-to-end test of the NAS side router: router/compose.yaml as written,
// with this checkout's router/config.yaml, on a throwaway Docker network.
// A LAN client uses the router as its gateway and DNS server; a stand-in
// airport (Mihomo with a Shadowsocks inbound) is the only node. The router
// downloads the real rule lists, so this needs Docker and internet access.
//
//   ROUTER_E2E=1 node --test test/router-e2e.test.mjs
//
// Everything runs inside containers on 198.51.100.0/24 (TEST-NET-2); nothing
// on the host network changes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(repositoryDirectory, 'router/compose.yaml');
const enabled = process.env.ROUTER_E2E === '1';
if (process.env.CI && !enabled) {
  throw new Error('ROUTER_E2E=1 is required in CI');
}

const PROJECT = 'router-e2e';
const NET = '198.51.100';
// The internet side of the home router (TEST-NET-3).
const WAN = '203.0.113';
const ROUTER = `${NET}.2`;
const SECRET = 'test-only-secret';
const RETURN = '回国节点';
const FALLBACK = '回国或直连';
const BACKUP = '回国备用';
const NODE = '🇨🇳 上海 01';
// A second mainland node on its own stand-in airport, added for the failover test.
const NODE2 = '🇨🇳 北京 02';
const OVERSEAS = '🇭🇰 香港 01';
const NOTICE = '剩余流量：100 GB';
const ROUTER_IMAGE = YAML.parse(fs.readFileSync(composeFile, 'utf8')).services.mihomo.image;
const OWN_RULES = 'https://raw.githubusercontent.com/AlinJiang/flclash-return-to-china/main/rules/';

/** This checkout's template, with our own rule files served from the test network instead of main. */
function servedTemplate(suffix = '') {
  const template = fs.readFileSync(path.join(repositoryDirectory, 'router/config.yaml'), 'utf8');
  assert.ok(template.includes(OWN_RULES));
  // Check our groups every 5 s instead of every minute, so failover and
  // recovery show up in the test.
  let fast = template;
  for (const name of [RETURN, FALLBACK, BACKUP]) {
    const next = fast.replace(new RegExp(`(- name: ${name}\\n(?: {4}.*\\n)*? {4}interval: )\\d+\\n`), '$15\n');
    assert.notEqual(next, fast, name);
    fast = next;
  }
  // Log every connection, so a test can read the rule and the chain it took.
  const verbose = fast.replace(/^log-level: warning$/m, 'log-level: info');
  assert.notEqual(verbose, fast);
  return `${verbose.replaceAll(OWN_RULES, `http://${NET}.10/rules/`)}${suffix}`;
}

function run(command, args, { input, allowFailure = false, timeout = 300_000 } = {}) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${output}`);
  }
  return { status: result.status, output, stdout: result.stdout ?? '' };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(label, check, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) {
        return last;
      }
    } catch (error) {
      last = error;
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${label}: ${last?.message ?? last}`);
}

/** A full Clash profile, as airports serve it: the provider only takes proxies. */
function writeSubscription(www, names) {
  const node = (name) => {
    const address = name === NODE2 ? `${NET}.12` : `${NET}.11`;
    return { name, type: 'ss', server: address, port: 8388, cipher: 'aes-128-gcm', password: 'test-only', udp: true };
  };
  fs.writeFileSync(path.join(www, 'sub.yaml'), YAML.stringify({
    proxies: names.map(node),
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: names }],
    rules: ['MATCH,PROXY'],
  }));
}

function writeFixtures(directory) {
  const www = path.join(directory, 'www');
  fs.mkdirSync(www);
  fs.writeFileSync(path.join(www, 'config.yaml'), servedTemplate());
  fs.cpSync(path.join(repositoryDirectory, 'rules'), path.join(www, 'rules'), { recursive: true });
  writeSubscription(www, [NODE, OVERSEAS, NOTICE]);
  fs.writeFileSync(path.join(directory, 'airport.yaml'), YAML.stringify({
    'log-level': 'info',
    listeners: [{ name: 'ss-in', type: 'shadowsocks', port: 8388, listen: '0.0.0.0', cipher: 'aes-128-gcm', password: 'test-only', udp: true }],
    rules: ['MATCH,DIRECT'],
  }));
  // !reset and !override replace the NAS's macvlan network with a private bridge.
  fs.writeFileSync(path.join(directory, 'override.yaml'), `
services:
  mihomo:
    container_name: !reset null
    environment:
      SUBSCRIPTION_URL: http://${NET}.10/sub.yaml
      CONFIG_URL: http://${NET}.10/config.yaml
      CONTROLLER_SECRET: ${SECRET}
      UPSTREAM_DNS: 1.1.1.1
      REFRESH_SECONDS: 5
      DIRECT_REPLIES: ${NET}.21:2222
    networks: !override
      lan:
        ipv4_address: ${ROUTER}
    depends_on: [www, airport, airport2]
  www:
    image: busybox:1.37.0
    command: [httpd, -f, -p, '80', -h, /www]
    volumes: ['${www}:/www']
    networks: { lan: { ipv4_address: ${NET}.10 } }
  airport:
    image: ${ROUTER_IMAGE}
    command: [-d, /airport, -f, /airport/airport.yaml]
    volumes: ['${directory}/airport.yaml:/airport/airport.yaml:ro']
    networks: { lan: { ipv4_address: ${NET}.11 } }
  airport2:
    image: ${ROUTER_IMAGE}
    command: [-d, /airport, -f, /airport/airport.yaml]
    volumes: ['${directory}/airport.yaml:/airport/airport.yaml:ro']
    networks: { lan: { ipv4_address: ${NET}.12 } }
  # The home router: forwards ${WAN}.254:2222 to the workstation, like the
  # ASUS port forward, and gives the LAN its way out.
  lanrouter:
    image: ${ROUTER_IMAGE}
    cap_add: [NET_ADMIN]
    sysctls: { net.ipv4.ip_forward: 1 }
    entrypoint: [/bin/sh, -c]
    command: ['iptables -t nat -A PREROUTING -d ${WAN}.254 -p tcp --dport 2222 -j DNAT --to-destination ${NET}.21:2222 && iptables -t nat -A POSTROUTING -s ${NET}.0/24 ! -d ${NET}.0/24 -j MASQUERADE && exec sleep 3600']
    networks: { lan: { ipv4_address: ${NET}.254 }, wan: { ipv4_address: ${WAN}.254 } }
  # A LAN server behind the port forward whose gateway is the side router.
  workstation:
    image: busybox:1.37.0
    cap_add: [NET_ADMIN]
    entrypoint: [/bin/sh, -c]
    command: ['ip route replace default via ${ROUTER} && mkdir -p /www && echo reachable > /www/index.html && exec httpd -f -p 2222 -h /www']
    networks: { lan: { ipv4_address: ${NET}.21 } }
  outsider:
    image: curlimages/curl:8.17.0
    entrypoint: [/bin/sh, -c]
    command: ['exec sleep 3600']
    networks: { wan: { ipv4_address: ${WAN}.20 } }
  client:
    image: curlimages/curl:8.17.0
    user: root
    cap_add: [NET_ADMIN]
    entrypoint: [/bin/sh, -c]
    command: ['ip route replace default via ${ROUTER} && echo "nameserver ${ROUTER}" > /etc/resolv.conf && exec sleep 3600']
    networks: { lan: { ipv4_address: ${NET}.20 } }
networks:
  lan:
    driver: bridge
    driver_opts: !reset {}
    ipam: !override
      config:
        - subnet: ${NET}.0/24
          gateway: ${NET}.1
  # internal: Docker's host masquerade would otherwise rewrite the outsider's
  # address as the forwarded packet crosses the LAN bridge.
  wan:
    internal: true
    ipam:
      config:
        - subnet: ${WAN}.0/24
          gateway: ${WAN}.1
`);
  return www;
}

test('the side router serves DNS, routes by the rules and recovers on its own', { skip: enabled ? false : 'set ROUTER_E2E=1 (needs Docker and internet)', timeout: 900_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'router-e2e-'));
  const compose = (...args) => run('docker', ['compose', '-p', PROJECT, '-f', composeFile, '-f', path.join(directory, 'override.yaml'), ...args]);
  const www = writeFixtures(directory);
  const client = (...args) => run('docker', ['compose', '-p', PROJECT, '-f', composeFile, '-f', path.join(directory, 'override.yaml'), 'exec', '-T', 'client', ...args], { allowFailure: true, timeout: 60_000 });
  const api = (method, route, body) => {
    const args = ['curl', '-sS', '-m', '20', '-X', method, '--oauth2-bearer', SECRET, `http://${ROUTER}:9090${route}`];
    if (body !== undefined) {
      args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
    }
    const result = client(...args);
    if (result.status !== 0) {
      throw new Error(result.output);
    }
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const group = () => api('GET', `/proxies/${encodeURIComponent(RETURN)}`);
  const airportLog = () => compose('logs', '--no-color', 'airport').output;
  const routerLog = () => compose('logs', '--no-color', 'mihomo').output;
  const routerState = () => JSON.parse(run('docker', ['inspect', `${PROJECT}-mihomo-1`]).stdout)[0].State;
  // nslookup prints the server as "Address:\t<ip>:53"; an answer is "Address: <ip>".
  const resolves = (name) => {
    const result = client('nslookup', '-type=a', name, ROUTER);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /^Address: (?!0\.0\.0\.0$)\d+(\.\d+){3}$/m, result.output);
  };
  // An HTTPS request from the LAN client; any status line counts as reachable.
  const fetchFromClient = (host) => client('curl', '-sS', '-o', '/dev/null', '-m', '20', '-w', '%{http_code}', `https://${host}`);

  // router/router-mode as a LAN device runs it, with the password in a file.
  const routerModeScript = fs.readFileSync(path.join(repositoryDirectory, 'router/router-mode'), 'utf8');
  const routerMode = (...args) => run('docker', ['compose', '-p', PROJECT, '-f', composeFile, '-f', path.join(directory, 'override.yaml'), 'exec', '-T', '-e', `ROUTER=${ROUTER}:9090`, '-e', 'ROUTER_SECRET_FILE=/tmp/router-secret', 'client', 'sh', '-s', '--', ...args], { input: routerModeScript, timeout: 180_000 }).stdout;

  const teardown = () => run('docker', ['compose', '-p', PROJECT, '-f', composeFile, '-f', path.join(directory, 'override.yaml'), 'down', '-v', '--remove-orphans', '-t', '5'], { allowFailure: true });
  // A run that was killed leaves its containers and cached subscription behind.
  teardown();
  try {
    compose('up', '-d', '--quiet-pull');

    await t.test('the router fetches its config and the subscription, and keeps only mainland exits', async () => {
      const current = await until('the airport provider', () => {
        const value = group();
        return value.all?.includes(NODE) ? value : null;
      });
      assert.equal(current.type, 'URLTest');
      assert.deepEqual(current.all, [NODE]);
    });

    await t.test('the rule lists load from their upstreams', async () => {
      // Mihomo only accepts LAN connections once every provider has loaded.
      const expected = Object.keys(YAML.parse(servedTemplate())['rule-providers']);
      await until('rule providers', () => {
        const { providers } = api('GET', '/providers/rules');
        return expected.every((name) => providers[name]?.ruleCount > 0) && providers['sukka-reject-domainset'].ruleCount > 1000;
      });
    });

    await t.test('return traffic goes through the node once the subscription has loaded', async () => {
      // On the first start the fallback checks 回国节点 before the subscription
      // has loaded, and 回国节点 keeps that empty pick (COMPATIBLE) for 10 s
      // (adapter/outboundgroup/urltest.go), so return traffic waits for it.
      await until('return traffic through the node', () => {
        fetchFromClient('v.qq.com');
        return /v\.qq\.com:443/.test(airportLog());
      }, 60_000).catch((error) => {
        // The router's log names the rule and the chain each connection took.
        throw new Error(`${error.message}\n${routerLog().split('\n').filter((line) => line.includes('v.qq.com')).join('\n')}`);
      });
    });

    await t.test('LAN clients resolve names through the router', () => {
      resolves('www.baidu.com');
    });

    await t.test('ordinary traffic goes direct, return traffic through the node, ads are blocked', () => {
      const direct = fetchFromClient('www.baidu.com');
      assert.equal(direct.status, 0, direct.output);
      const viaNode = fetchFromClient('v.qq.com');
      assert.equal(viaNode.status, 0, viaNode.output);
      // Taobao's DNS answers 0.0.0.0 abroad at times, so the client skips DNS and
      // dials a reserved address; the sniffer still reads the name from the TLS
      // handshake. A rejected connection fails in the handshake (35) or on receive
      // (56); one that slipped through would time out dialing 192.0.2.1 (28).
      // The router's own log names the rule that stopped it.
      const adHost = 'amdc.m.taobao.com';
      const ad = client('curl', '-sS', '-o', '/dev/null', '-m', '10', '--resolve', `${adHost}:443:192.0.2.1`, `https://${adHost}`);
      assert.ok([35, 56].includes(ad.status), `an ad host must be rejected after connecting:\n${ad.output}`);
      assert.match(routerLog(), /amdc\.m\.taobao\.com:443 match .* using REJECT/);
      const log = airportLog();
      assert.match(log, /v\.qq\.com:443/);
      assert.doesNotMatch(log, /baidu\.com/);
      assert.doesNotMatch(log, /amdc\.m\.taobao\.com/);
    });

    await t.test('router-mode shows the mode and where return traffic goes, and switches to Direct', () => {
      client('sh', '-c', `echo ${SECRET} > /tmp/router-secret`);
      assert.equal(routerMode(), `mode: rule\nreturn traffic: ${NODE}\n`);
      const viaNode = () => (airportLog().match(/v\.qq\.com:443/g) ?? []).length;
      assert.match(routerMode('direct'), /^mode: direct\n/);
      try {
        const before = viaNode();
        const result = fetchFromClient('v.qq.com');
        assert.equal(result.status, 0, result.output);
        assert.equal(viaNode(), before, 'Direct mode sends return traffic direct');
      } finally {
        assert.match(routerMode('rule'), /^mode: rule\n/);
      }
    });

    await t.test('router-mode refresh downloads every rule list and the subscription', () => {
      const count = Object.keys(YAML.parse(servedTemplate())['rule-providers']).length;
      assert.equal(routerMode('refresh'), `updated ${count} rule lists and the subscription\n`);
    });

    await t.test('a node can be pinned, and Global mode sends everything through the node', () => {
      api('PUT', `/proxies/${encodeURIComponent(RETURN)}`, { name: NODE });
      assert.equal(group().fixed, NODE);
      // The dashboard's choice in GLOBAL must not keep Global mode direct.
      api('PUT', '/proxies/GLOBAL', { name: 'DIRECT' });
      assert.equal(routerMode('global'), `mode: global\nreturn traffic: ${NODE} (pinned)\n`);
      try {
        const result = fetchFromClient('www.baidu.com');
        assert.equal(result.status, 0, result.output);
        assert.match(airportLog(), /baidu\.com:443/);
      } finally {
        routerMode('rule');
      }
    });

    await t.test('a port-forwarded LAN server answers the internet, and still goes out through the router', () => {
      const exec = (service, ...args) => run('docker', ['compose', '-p', PROJECT, '-f', composeFile, '-f', path.join(directory, 'override.yaml'), 'exec', '-T', service, ...args], { allowFailure: true, timeout: 60_000 });
      // On the NAS the side router's default route is the home router; here it is Docker's bridge.
      run('docker', ['exec', `${PROJECT}-mihomo-1`, 'ip', 'route', 'replace', 'default', 'via', `${NET}.254`]);
      const fromOutside = () => exec('outsider', 'curl', '-sS', '-m', '10', `http://${WAN}.254:2222/`);
      const answered = fromOutside();
      assert.equal(answered.status, 0, answered.output);
      assert.match(answered.stdout, /reachable/);
      // Its own traffic still goes through Mihomo and the rules.
      const out = exec('workstation', 'wget', '-q', '-O', '/dev/null', '-T', '15', `http://${'v.qq.com'}/`);
      assert.match(airportLog(), /v\.qq\.com:80/, out.output);
      // Without the rule the reply enters the TUN and is lost.
      run('docker', ['exec', `${PROJECT}-mihomo-1`, 'ip', 'rule', 'del', 'priority', '8000']);
      assert.notEqual(fromOutside().status, 0, 'the reply must need the DIRECT_REPLIES rule');
    });

    await t.test("when 回国节点's node goes down, return traffic moves to another node instead of DIRECT", async () => {
      const now = (name) => api('GET', `/proxies/${encodeURIComponent(name)}`).now;
      const secondLog = () => compose('logs', '--no-color', 'airport2').output;
      // Listed first, so 回国备用 takes it while 回国节点 stays pinned to NODE.
      writeSubscription(www, [NODE2, NODE, OVERSEAS, NOTICE]);
      api('PUT', '/providers/proxies/airport');
      await until('the second node', () => group().all?.includes(NODE2), 60_000);
      api('PUT', `/proxies/${encodeURIComponent(RETURN)}`, { name: NODE });
      await until('回国备用 on the second node', () => now(BACKUP) === NODE2 && now(FALLBACK) === RETURN, 60_000);
      compose('stop', 'airport');
      let wentDirect = false;
      await until('return traffic through the second node', () => {
        wentDirect ||= now(FALLBACK) === 'DIRECT';
        fetchFromClient('v.qq.com');
        wentDirect ||= now(FALLBACK) === 'DIRECT';
        return /v\.qq\.com:443/.test(secondLog());
      }, 90_000);
      assert.equal(wentDirect, false, 'one dead node must not send return traffic DIRECT');
      assert.match(routerMode(), new RegExp(`^return traffic: ${NODE2}`, 'm'));
    });

    await t.test('with every node down return traffic goes direct, and back to the node once it answers', async () => {
      const now = () => api('GET', `/proxies/${encodeURIComponent(FALLBACK)}`).now;
      const viaNode = () => (airportLog().match(/v\.qq\.com:443/g) ?? []).length;
      compose('stop', 'airport2');
      await until('the switch to DIRECT', () => {
        fetchFromClient('v.qq.com');
        return now() === 'DIRECT';
      }, 120_000);
      assert.match(routerMode(), /^return traffic: DIRECT, every return node failed its last check$/m);
      const direct = fetchFromClient('v.qq.com');
      assert.equal(direct.status, 0, `China apps keep working while the airport is down:\n${direct.output}`);
      compose('start', 'airport', 'airport2');
      await until('the switch back to the node', () => {
        fetchFromClient('v.qq.com');
        return now() === RETURN;
      }, 120_000);
      // 回国或直连 can be back on 回国节点 while 回国节点 is still on the second
      // node, before its next check finds the pinned one alive again.
      const before = viaNode();
      await until('the request through the pinned node', () => {
        assert.equal(fetchFromClient('v.qq.com').status, 0);
        return viaNode() > before;
      }, 60_000);
    });

    await t.test('a template that does not parse is ignored', async () => {
      const startedAt = routerState().StartedAt;
      fs.writeFileSync(path.join(www, 'config.yaml'), 'proxy-groups: [{name: broken, type: url-test}]\n');
      await until('the refresh to reject the template', () => /does not parse/.test(routerLog()), 60_000);
      assert.equal(routerState().StartedAt, startedAt, 'the router keeps running its config');
      assert.ok(group().all.includes(NODE));
    });

    await t.test('a changed template restarts the router with it', async () => {
      const startedAt = routerState().StartedAt;
      fs.writeFileSync(path.join(www, 'config.yaml'), servedTemplate('# changed\n'));
      await until('the restart', () => routerState().StartedAt !== startedAt && routerState().Running, 90_000);
      const config = run('docker', ['exec', `${PROJECT}-mihomo-1`, 'cat', '/root/.config/mihomo/config.yaml']).stdout;
      assert.ok(config.endsWith('# changed\n'));
      assert.ok(!config.includes('<SUBSCRIPTION_URL>') && config.includes(`'http://${NET}.10/sub.yaml'`));
      await until('the controller after the restart', () => group().all?.includes(NODE));
    });

    await t.test('without GitHub the last good config keeps running after a restart', async () => {
      compose('stop', 'www');
      compose('restart', 'mihomo');
      await until('the controller without the template host', () => group().all?.includes(NODE), 90_000);
      assert.ok(routerState().Running);
    });
  } finally {
    teardown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
