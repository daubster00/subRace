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

// Lazy init: `next build` collects page data with 8 parallel workers, each
// importing this module. Opening the DB eagerly here makes them race to create
// data/subrace.db and fail with SQLITE_BUSY. Defer init until first real use.
let dbInstance: Database.Database | undefined;
function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  dbInstance = globalThis._db ?? createDb();
  if (process.env.NODE_ENV !== 'production') {
    globalThis._db = dbInstance;
  }
  return dbInstance;
}

const db = new Proxy({} as Database.Database, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === 'function' ? (value as Function).bind(real) : value;
  },
});

export default db;
