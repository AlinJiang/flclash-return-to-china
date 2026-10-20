// Parses a config with the exact Mihomo core FlClash 0.9.1 ships
// (chen08209/Clash.Meta @ 8380d0e built with -tags with_gvisor, see
// .github/workflows/test.yml).
// `-t` only parses the config and exits: no listener, proxy or TUN starts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createCoreHome, withoutGeodataDownloads } from './geodata.mjs';

export const mihomoBinary = process.env.MIHOMO_BIN ?? '';

export function parseWithMihomo(config) {
  const home = createCoreHome();
  try {
    // YAML is a superset of JSON, which keeps this independent of a YAML writer.
    const result = spawnSync(mihomoBinary, ['-t', '-d', home, '-f', '-'], {
      input: JSON.stringify(withoutGeodataDownloads(config)),
      encoding: 'utf8',
      timeout: 120_000,
    });
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return { ok: result.status === 0 && /test is successful/.test(log), status: result.status, log };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
