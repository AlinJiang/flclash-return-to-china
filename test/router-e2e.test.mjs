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
const ROUTER = `${NET}.2`;
const SECRET = 'test-only-secret';
const RETURN = '回国节点';
const NODE = '上海 01';
const NOTICE = '剩余流量：100 GB';
const ROUTER_IMAGE = YAML.parse(fs.readFileSync(composeFile, 'utf8')).services.mihomo.image;
const OWN_RULES = 'https://raw.githubusercontent.com/AlinJiang/flclash-return-to-china/main/rules/';

/** This checkout's template, with our own rule files served from the test network instead of main. */
function servedTemplate(suffix = '') {
  const template = fs.readFileSync(path.join(repositoryDirectory, 'router/config.yaml'), 'utf8');
  assert.ok(template.includes(OWN_RULES));
  return `${template.replaceAll(OWN_RULES, `http://${NET}.10/rules/`)}${suffix}`;
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

function writeFixtures(directory) {
  const www = path.join(directory, 'www');
  fs.mkdirSync(www);
  fs.writeFileSync(path.join(www, 'config.yaml'), servedTemplate());
  fs.cpSync(path.join(repositoryDirectory, 'rules'), path.join(www, 'rules'), { recursive: true });
  const node = (name) => ({ name, type: 'ss', server: `${NET}.11`, port: 8388, cipher: 'aes-128-gcm', password: 'test-only', udp: true });
  // A full Clash profile, as airports serve it: the provider only takes proxies.
  fs.writeFileSync(path.join(www, 'sub.yaml'), YAML.stringify({
    proxies: [node(NODE), node(NOTICE)],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: [NODE] }],
    rules: ['MATCH,PROXY'],
  }));
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
    networks: !override
      lan:
        ipv4_address: ${ROUTER}
    depends_on: [www, airport]
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
  const routerState = () => JSON.parse(run('docker', ['inspect', `${PROJECT}-mihomo-1`]).stdout)[0].State;
  // nslookup prints the server as "Address:\t<ip>:53"; an answer is "Address: <ip>".
  const resolves = (name) => {
    const result = client('nslookup', '-type=a', name, ROUTER);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /^Address: \d+(\.\d+){3}$/m, result.output);
  };
  // An HTTPS request from the LAN client; any status line counts as reachable.
  const fetchFromClient = (host) => client('curl', '-sS', '-o', '/dev/null', '-m', '20', '-w', '%{http_code}', `https://${host}`);

  const teardown = () => run('docker', ['compose', '-p', PROJECT, '-f', composeFile, '-f', path.join(directory, 'override.yaml'), 'down', '-v', '--remove-orphans', '-t', '5'], { allowFailure: true });
  // A run that was killed leaves its containers and cached subscription behind.
  teardown();
  try {
    compose('up', '-d', '--quiet-pull');

    await t.test('the router fetches its config and the subscription, and drops notice nodes', async () => {
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

    await t.test('LAN clients resolve names through the router', () => {
      resolves('www.baidu.com');
    });

    await t.test('ordinary traffic goes direct, return traffic through the node, ads are blocked', () => {
      const direct = fetchFromClient('www.baidu.com');
      assert.equal(direct.status, 0, direct.output);
      const viaNode = fetchFromClient('v.qq.com');
      assert.equal(viaNode.status, 0, viaNode.output);
      // It resolves and the TCP connection opens, so only the rule can stop it:
      // curl fails in the TLS handshake (35) or on receive (56), not on DNS (6) or connect (7).
      resolves('amdc.m.taobao.com');
      const ad = fetchFromClient('amdc.m.taobao.com');
      assert.ok([35, 56].includes(ad.status), `an ad host must be rejected after connecting:\n${ad.output}`);
      const log = airportLog();
      assert.match(log, /v\.qq\.com:443/);
      assert.doesNotMatch(log, /baidu\.com/);
      assert.doesNotMatch(log, /amdc\.m\.taobao\.com/);
    });

    await t.test('a node can be pinned, and Global mode sends everything through the node', () => {
      api('PUT', `/proxies/${encodeURIComponent(RETURN)}`, { name: NODE });
      assert.equal(group().fixed, NODE);
      api('PATCH', '/configs', { mode: 'global' });
      try {
        const result = fetchFromClient('www.baidu.com');
        assert.equal(result.status, 0, result.output);
        assert.match(airportLog(), /baidu\.com:443/);
      } finally {
        api('PATCH', '/configs', { mode: 'rule' });
      }
    });

    await t.test('a template that does not parse is ignored', async () => {
      const startedAt = routerState().StartedAt;
      fs.writeFileSync(path.join(www, 'config.yaml'), 'proxy-groups: [{name: broken, type: url-test}]\n');
      await until('the refresh to reject the template', () => /does not parse/.test(compose('logs', '--no-color', 'mihomo').output), 60_000);
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
