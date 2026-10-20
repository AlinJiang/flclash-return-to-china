// Guards the public repository against carrying airport secrets. The real
// subscription and nodes only ever live on each device; .gitignore keeps
// profiles (*.yaml), backups and databases out. This scan is the second line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROFILES } from './fixtures/profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRECTORIES = new Set(['.git', '.core', 'node_modules']);
// Generated dependency manifests: registry and module hosts, no airport data.
const SKIP_FILES = new Set(['package-lock.json', 'go.sum', '.DS_Store']);
// A FlClash backup is a zip holding database.sqlite with every subscription URL.
const ARCHIVE_OR_DATABASE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz|sqlite3?|db|bak|backup)$/i;

// Hosts a file in this repository may name. Anything else could be an airport.
const ALLOWED_HOSTS = [
  /^ruleset\.skk\.moe$/, /^ruleset-mirror\.skk\.moe$/,
  /^wifi\.vivo\.com\.cn$/, /^connectivitycheck\.platform\.hicloud\.com$/, /^connect\.rom\.miui\.com$/,
  /^cp\.cloudflare\.com$/, /^www\.gstatic\.com$/,
  /^github\.com$/, /^raw\.githubusercontent\.com$/,
  /^localhost$/, /^127\.0\.0\.1$/, /^::1$/, /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/,
  // Mihomo's wildcard in tun.dns-hijack (tcp://any:53), never a host.
  /^any$/,
  /(^|\.)invalid$/,
];
const isAllowedHost = (host) => ALLOWED_HOSTS.some((pattern) => pattern.test(host.toLowerCase()));
// Fixtures use "test-only"; docs and code name values through placeholders.
const isPlaceholder = (value) => value === '' || value.includes('test-only') || /^[<$[({]/.test(value)
  || /^(true|false|null)$/.test(value);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRECTORIES.has(entry.name)) {
      return [];
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(full);
    }
    // A committed symlink stores only its target path, so its target is not published.
    return entry.isFile() && !SKIP_FILES.has(entry.name) ? [full] : [];
  });
}

/** Files git would publish, or every file when this is not a git checkout. */
function publishedFiles(directory) {
  let listed;
  try {
    // -z lists names verbatim; without it git C-quotes non-ASCII names.
    listed = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return walk(directory);
  }
  return listed.split('\0').filter(Boolean)
    .filter((file) => !SKIP_FILES.has(path.basename(file)))
    .map((file) => path.join(directory, file))
    .filter((file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile());
}

const files = publishedFiles(root);

const URL_PATTERN = /\b([a-z][a-z0-9+.-]*):\/\/([^\s'"`>(){}\\/?#]*)/gi;
// A credential key and its own value: a quoted string, the first quoted item
// of a list, or a bare token. Every key on a line is checked on its own.
const CREDENTIAL = new RegExp(
  '(?<![\\w-])["\']?(password|passwd|passphrase|secret|token|psk|uuid|private-key|pre-shared-key|public-key|short-id'
    + '|auth|auth-str|auth-key|age-secret-key|identity-secret|obfs-password|authorization|username|protocol-param)["\']?'
    + '\\s*[:=](?![=>])\\s*(?:\\[\\s*)?(?:(["\'`])(.*?)\\2|([^\\s,;&\'"`(){}\\[\\]]*))',
  'gi',
);
// Fields that name an airport host: the server itself, TLS names, transport
// Host headers and SSR's obfs-param.
const SERVER_NAME = /(?<![\w-])["']?(server|servername|sni|host|obfs-host|obfs-param)["']?\s*:(?![=>])\s*(["'`]?)([^\s"',}\]]+)/gim;

function decodePercentEscapes(text) {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (escaped) => {
    try {
      return decodeURIComponent(escaped);
    } catch {
      return escaped;
    }
  });
}

/** Hosts and passwords in URLs of any scheme, including inside percent-encoded import links. */
function urlViolations(text) {
  const violations = [];
  for (const variant of [text, decodePercentEscapes(text)]) {
    for (const [, scheme, authority] of variant.matchAll(URL_PATTERN)) {
      const at = authority.lastIndexOf('@');
      const userinfo = at >= 0 ? authority.slice(0, at) : '';
      const hostPort = authority.slice(at + 1);
      const host = hostPort.startsWith('[') ? hostPort.replace(/^\[([^\]]*)\].*$/, '$1') : hostPort.replace(/:\d+$/, '');
      if (!isAllowedHost(host) && !isPlaceholder(host)) {
        violations.push(`${scheme}://${host}`);
      }
      // A share link keeps the password before @ even when its host is a placeholder.
      if (userinfo !== '' && !isPlaceholder(userinfo) && !(userinfo === 'git' && isAllowedHost(host))) {
        violations.push(`${scheme}:// password`);
      }
    }
  }
  return violations;
}

/** Credential-like keys with real values, and server names outside the allowed hosts. */
function credentialViolations(text) {
  const violations = [];
  for (const variant of [text, decodePercentEscapes(text)]) {
    for (const [, key, , quoted, bare] of variant.matchAll(CREDENTIAL)) {
      if (!isPlaceholder(quoted ?? bare)) {
        violations.push(key);
      }
    }
    for (const [, key, quote, value] of variant.matchAll(SERVER_NAME)) {
      // Code names a host through a variable or field (host, probe.Host); a
      // host name ends in a lowercase top-level domain.
      const reference = quote === '' && /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(value) && !/\.[a-z]{2,}$/.test(value);
      if (!isAllowedHost(value) && !isPlaceholder(value) && !reference) {
        violations.push(`${key} ${value}`);
      }
    }
  }
  return violations;
}

test('no archive, database or binary file is in the repository', () => {
  assert.ok(files.length > 10, 'the scan sees the repository files');
  for (const file of files) {
    const name = path.relative(root, file);
    assert.doesNotMatch(name, ARCHIVE_OR_DATABASE, `${name} may hide subscription data`);
    assert.equal(fs.readFileSync(file).includes(0), false, `${name} is binary`);
  }
});

test('every URL of any scheme names an allowed host and carries no password', () => {
  for (const file of files) {
    assert.deepEqual(urlViolations(fs.readFileSync(file, 'utf8')), [], path.relative(root, file));
  }
});

test('no file carries a credential value or a real server name', () => {
  for (const file of files) {
    assert.deepEqual(credentialViolations(fs.readFileSync(file, 'utf8')), [], path.relative(root, file));
  }
});

test('every fixture server, TLS name and URL is a reserved name or address', () => {
  // Fixture helpers take the server positionally, which no key pattern sees.
  const fields = new Set(['server', 'sni', 'servername', 'url']);
  for (const [name, profile] of Object.entries(PROFILES)) {
    const stack = [profile()];
    while (stack.length > 0) {
      for (const [key, child] of Object.entries(stack.pop() ?? {})) {
        if (child !== null && typeof child === 'object') {
          stack.push(child);
        } else if (fields.has(key) && typeof child === 'string' && child !== '') {
          assert.ok(isAllowedHost(key === 'url' ? new URL(child).hostname : child), `${name} ${key} ${child}`);
        }
      }
    }
  }
});

test('the scan catches share links, encoded subscription links, credentials and server names', () => {
  // Built at runtime so this file itself never contains a leak-shaped literal.
  const host = ['hk02', 'airport-cdn', 'example', 'net'].join('.');
  const scheme = (name) => `${name}:${'//'}`;
  for (const leak of [
    `${scheme('hy2')}secret@${host}:443`,
    `${scheme('vmess')}eyJhZGQiOiJob3N0In0=`,
    `${scheme('clash')}install-config?url=${encodeURIComponent(`${scheme('https')}sub.${host}/api?${'token'}=abcdef`)}`,
    `- ${scheme('https')}${host}/sub`,
    `${scheme('trojan')}${'R3al'}Passw0rd@sh.node.invalid:443`,
  ]) {
    assert.notDeepEqual(urlViolations(leak), [], leak);
  }
  for (const benign of [
    `${scheme('https')}ruleset.skk.moe/Clash/non_ip/domestic.txt`, `curl ${scheme('http')}[::1]:9090/version`,
    `${scheme('https')}<机场域名>/api/v1/client/subscribe?${'token'}=<token>`,
  ]) {
    assert.deepEqual(urlViolations(benign), [], benign);
  }

  const line = (key, value) => `${key}: ${value}`;
  const real = "'7f6e5d4c-real'";
  for (const leak of [
    line('password', 'hunter2real'), line('"uuid"', real), `${'token'}=${'a'.repeat(12)}`,
    line('age-secret-key', 'AGE-SECRET-KEY-1REAL'), line('auth-key', 'tskey-auth-real'), line('username', 'realuser01'),
    line("'protocol-param'", "'31337:Xk9pReal7'"), line('server', host), line('sni', `'${host}'`),
    line("'obfs-param'", `'a1b2.${host}'`), `{ headers: { ${line('Host', host)} } }`,
    // Every key on a line is checked, and a placeholder elsewhere on it excuses nothing.
    `{ password: 'test-only', uuid: ${real} }`, `{ uuid: ${real}, note: 'test-only' }`,
    line('Authorization', `['Bearer ${'b'.repeat(16)}']`),
  ]) {
    assert.notDeepEqual(credentialViolations(leak), [], leak);
  }
  for (const benign of [
    line('password', "'test-only'"), `{ password: 'test-only', uuid: 'test-only' }`, line('server', "'gz.node.invalid'"),
    line('server', 'host'), line('Authorization', "['Bearer test-only']"), `${'host'} := probe.Host`,
  ]) {
    assert.deepEqual(credentialViolations(benign), [], benign);
  }
});

test('the file list sees names git would otherwise quote, such as non-ASCII ones', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  try {
    try {
      execFileSync('git', ['init', '-q'], { cwd: directory, stdio: 'ignore' });
    } catch {
      context.skip('git is not available');
      return;
    }
    fs.writeFileSync(path.join(directory, '备注.md'), 'notes\n');
    assert.deepEqual(publishedFiles(directory).map((file) => path.basename(file)), ['备注.md']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
