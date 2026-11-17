import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { pool } from './db.js';

/** Advisory lock key reserved for schema migrations (stable across processes). */
export const MIGRATION_ADVISORY_LOCK_KEY = 872014001;

export const MIGRATION_NAME_RE = /^\d{3}_[a-z0-9_]+\.sql$/;

export function parseMigrationId(filename: string): string {
  if (!MIGRATION_NAME_RE.test(filename)) {
    throw new Error(`Invalid migration filename: ${filename}`);
  }
  return filename.slice(0, -'.sql'.length);
}

export async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await fs.readdir(migrationsDir);
  const sqlFiles = entries.filter((name) => name.endsWith('.sql'));
  for (const name of sqlFiles) {
    if (!MIGRATION_NAME_RE.test(name)) {
      throw new Error(`Invalid migration filename: ${name}`);
    }
  }
  return sqlFiles.sort((a, b) => a.localeCompare(b));
}

function migrationsDirectory(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
}

export async function migrate(clientPool: pg.Pool = pool): Promise<void> {
  const client = await clientPool.connect();
  let locked = false;
  try {
    // Disable timeout while waiting for the advisory lock (second instance must not fail waiting).
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    locked = true;
    // DDL / migration apply budget after the lock is held.
    await client.query(`SET statement_timeout = '120000'`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = migrationsDirectory();
    const files = await listMigrationFiles(migrationsDir);
    const appliedResult = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(appliedResult.rows.map((row) => row.id));

    for (const file of files) {
      const id = parseMigrationId(file);
      if (applied.has(id)) continue;

      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      try {
        // Do not use CREATE INDEX CONCURRENTLY here — it cannot run inside a transaction.
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
        await client.query('COMMIT');
        console.log(`Applied migration ${id}`);
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors; original error is rethrown below
        }
        throw error;
      }
    }
  } finally {
    // node-pg does not reset session GUCs on release(); restore before returning to the pool.
    try {
      await client.query('RESET statement_timeout');
    } catch {
      // best-effort; unlock/release still required
    }
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      } catch {
        // best-effort unlock
      }
    }
    client.release();
  }
}
