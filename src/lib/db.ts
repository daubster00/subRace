import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

declare global {
  var _db: Database.Database | undefined;
}

function createDb(): Database.Database {
  const dbPath = path.join(process.cwd(), 'data', 'subrace.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    )
  `);

  const migrationsDir = path.join(process.cwd(), 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const appliedRows = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
  const applied = new Set(appliedRows.map(r => r.name));
  const mark = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.transaction(() => {
      db.exec(sql);
      mark.run(file, new Date().toISOString());
    })();
    console.log(`[db] migration_applied file=${file}`);
  }
}

const db = globalThis._db ?? createDb();
if (process.env.NODE_ENV !== 'production') {
  globalThis._db = db;
}

export default db;
