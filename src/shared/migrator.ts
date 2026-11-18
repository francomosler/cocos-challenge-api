import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Un advisory lock por schema evita que dos instancias migren a la vez. */
const LOCK_KEY = "hashtext('cocos-api:migrations:' || current_schema())";

async function appliedVersions(client: pg.PoolClient): Promise<Set<string>> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((row) => row.version));
}

/**
 * La migración corre en una transacción junto con su registro en `schema_migrations`:
 * o queda aplicada y anotada, o no queda nada.
 */
async function applyMigration(client: pg.PoolClient, directory: string, file: string) {
  const sql = await readFile(join(directory, file), 'utf8');
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`Falló la migración ${file}: ${(error as Error).message}`, { cause: error });
  }
}

/** Aplica, en orden, los `.sql` de `directory` que todavía no corrieron. */
export async function runMigrations(pool: pg.Pool, directory: string): Promise<MigrationResult> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  const client = await pool.connect();

  try {
    await client.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
    const alreadyApplied = await appliedVersions(client);

    for (const file of files) {
      if (alreadyApplied.has(file)) {
        result.skipped.push(file);
        continue;
      }
      await applyMigration(client, directory, file);
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => {});
    client.release();
  }
}
