import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  listMigrationFiles,
  MIGRATION_NAME_RE,
  parseMigrationId,
} from '../src/core/migrate.js';

test('MIGRATION_NAME_RE accepts numbered snake_case sql files', () => {
  assert.equal(MIGRATION_NAME_RE.test('001_baseline.sql'), true);
  assert.equal(MIGRATION_NAME_RE.test('002_add_foo.sql'), true);
  assert.equal(MIGRATION_NAME_RE.test('999_z.sql'), true);
});

test('MIGRATION_NAME_RE rejects bad filenames', () => {
  for (const name of [
    '1_baseline.sql',
    '01_baseline.sql',
    '001-baseline.sql',
    '001_Baseline.sql',
    '001_base-line.sql',
    'baseline.sql',
    '001_baseline.txt',
    '001_baseline.SQL',
  ]) {
    assert.equal(MIGRATION_NAME_RE.test(name), false, name);
  }
});

test('parseMigrationId strips .sql and rejects bad names', () => {
  assert.equal(parseMigrationId('001_baseline.sql'), '001_baseline');
  assert.equal(parseMigrationId('012_add_index.sql'), '012_add_index');
  assert.throws(() => parseMigrationId('bad.sql'), /Invalid migration filename/);
  assert.throws(() => parseMigrationId('001_Bad.sql'), /Invalid migration filename/);
});

test('listMigrationFiles sorts by filename and rejects invalid names', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-test-'));
  try {
    await fs.writeFile(path.join(dir, '002_later.sql'), '-- later\n');
    await fs.writeFile(path.join(dir, '001_baseline.sql'), '-- baseline\n');
    await fs.writeFile(path.join(dir, 'readme.md'), 'ignore\n');
    assert.deepEqual(await listMigrationFiles(dir), ['001_baseline.sql', '002_later.sql']);

    await fs.writeFile(path.join(dir, 'bad-name.sql'), '-- bad\n');
    await assert.rejects(() => listMigrationFiles(dir), /Invalid migration filename/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
