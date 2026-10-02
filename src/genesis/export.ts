import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OceanDatabase } from '../db.js';
import { hashCode } from './service.js';
import { EconomyError } from '../tide/ledger.js';

export async function readGenesisExport(db: OceanDatabase, databasePath: string, wave: string, key?: string) {
  if (!/^[A-Z0-9_]{1,64}$/.test(wave)) throw new EconomyError('INVALID_WAVE', 'Neplatná emise.', 400);
  const expected = db.prepare('SELECT genesis_number,reward_tide,code_hash,digest_scheme FROM genesis_codes WHERE wave_id=? ORDER BY genesis_number')
    .all(wave) as Array<{ genesis_number: number; reward_tide: number; code_hash: string; digest_scheme: string }>;
  if (!expected.length) throw new EconomyError('EXPORT_UNAVAILABLE', 'Export pro tuto emisi není k dispozici.', 404);
  const filename = `genesis-codes-${wave}.csv`;
  let csv: string;
  try {
    const path = join(dirname(databasePath), 'genesis-exports', filename);
    const info = await stat(path);
    if (!info.isFile() || info.size > 256_000) throw new Error('Invalid export');
    csv = await readFile(path, 'utf8');
  } catch { throw new EconomyError('EXPORT_UNAVAILABLE', 'Export pro tuto emisi není k dispozici.', 404); }
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  if (header !== 'index,code,reward_tide,wave' || lines.length !== expected.length) throw new EconomyError('EXPORT_MISMATCH', 'Export neodpovídá emisi.', 409);
  const valid = lines.every((line, i) => {
    const fields = line.split(','), row = expected[i]!;
    return fields.length === 4 && /^\d+$/.test(fields[0]!) && Number(fields[0]) === row.genesis_number
      && /^OCN(?:-[A-Z2-9]{5}){4}$/.test(fields[1]!) && fields[2] === String(row.reward_tide) && fields[3] === wave
      && row.digest_scheme === 'hmac_sha256_v1' && hashCode(fields[1]!, key) === row.code_hash;
  });
  if (!valid) throw new EconomyError('EXPORT_MISMATCH', 'Export neodpovídá emisi.', 409);
  return { csv, filename, count: expected.length };
}
