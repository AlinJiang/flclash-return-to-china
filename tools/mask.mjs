// Masks what a core log or error can quote from a real airport profile: URLs,
// IP addresses and host names. Used by tools/check-profile.mjs.

// Host labels may hold underscores or any script (IDN); the last label starts
// with a letter, so version numbers and names such as 0.5倍流量 stay readable.
const HOST = /(?<![\p{L}\p{N}_.-])(?:[\p{L}\p{N}_-]+\.)+\p{L}[\p{L}\p{N}_-]*(?::\d+)?/gu;

// IPv4 goes first: in "dial tcp 192.0.2.7:443: refused" the IPv6 pattern
// would otherwise take "7:443:" and leave the first three octets.
export function mask(text) {
  return String(text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\[?\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\]?(?::\d+)?/gi, (match) => (match.includes(':') ? '<ip6>' : match))
    .replace(HOST, '<host>');
}

export function maskCoreLog(log) {
  return String(log).split('\n')
    .filter((line) => /level=(error|warning)|test (failed|is successful)/.test(line))
    .map((line) => mask(/msg="(.*)"/.exec(line)?.[1] ?? line));
}
