// Gives each core run a private home with the GeoIP data it needs, without
// ever downloading: the profile's own geox-url could point at an airport host,
// and per-run downloads would fetch about 10 MB each time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const geodataDirectory = process.env.MIHOMO_GEODATA_DIR ?? '';
// Connection refused immediately, so a missing file fails fast and visibly.
const UNREACHABLE = 'http://127.0.0.1:9/geodata-download-disabled';

export function createCoreHome() {
  if (!geodataDirectory || !fs.readdirSync(geodataDirectory).some((file) => /^(geoip\.metadb|country\.mmdb)$/i.test(file))) {
    throw new Error(
      'MIHOMO_GEODATA_DIR must name a directory with geoip.metadb, for example a copy of FlClash\'s GEOIP.metadb '
        + 'or https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb; a profile whose DNS '
        + 'names geosite: entries also needs GEOSITE.dat',
    );
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flclash-return-core-'));
  for (const file of fs.readdirSync(geodataDirectory)) {
    fs.symlinkSync(path.resolve(geodataDirectory, file), path.join(home, file));
  }
  return home;
}

export function withoutGeodataDownloads(config) {
  return {
    ...config,
    'geo-auto-update': false,
    'geox-url': { geoip: UNREACHABLE, geosite: UNREACHABLE, mmdb: UNREACHABLE, asn: UNREACHABLE },
  };
}
