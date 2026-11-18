import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/shared/db.ts';
import { runMigrations } from '../src/shared/migrator.ts';

const config = loadConfig();
// Una migración puede tardar más que un pedido de la API: no usa sus timeouts cortos.
const pool = createPool({ ...config.db, statementTimeoutMs: 600_000, lockTimeoutMs: 30_000 });

try {
  const directory = join(import.meta.dirname, '..', 'db', 'migrations');
  const { applied, skipped } = await runMigrations(pool, directory);
  for (const file of applied) console.log(`aplicada   ${file}`);
  for (const file of skipped) console.log(`ya estaba  ${file}`);
  console.log(applied.length === 0 ? 'Sin migraciones pendientes.' : 'Migraciones aplicadas.');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
