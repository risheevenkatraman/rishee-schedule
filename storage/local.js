import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function createLocalStorage(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'schedule.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL, showProgress INTEGER NOT NULL, progress INTEGER NOT NULL, color TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, name TEXT NOT NULL, bytes BLOB NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS finances (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, amountCents INTEGER NOT NULL, category TEXT NOT NULL, createdAt TEXT NOT NULL);
  `);
  if (
    !db
      .prepare('PRAGMA table_info(finances)')
      .all()
      .some((column) => column.name === 'status')
  ) {
    db.exec(
      "ALTER TABLE finances ADD COLUMN status TEXT NOT NULL DEFAULT 'Unpaid' CHECK(status IN ('Unpaid', 'Paid'))",
    );
  }
  const columns = {
    tasks: [
      'id',
      'title',
      'description',
      'start',
      'end',
      'status',
      'showProgress',
      'progress',
      'color',
    ],
    finances: [
      'id',
      'purpose',
      'amountCents',
      'category',
      'createdAt',
      'status',
    ],
    files: ['id', 'taskId', 'name', 'bytes', 'size'],
  };
  function table(type) {
    if (!columns[type]) throw new Error('Invalid table');
    return type;
  }
  return {
    cloud: false,
    async list(type) {
      const select = type === 'files' ? 'id, taskId, name, size' : '*';
      return db.prepare(`SELECT ${select} FROM ${table(type)}`).all();
    },
    async get(type, id) {
      return db.prepare(`SELECT * FROM ${table(type)} WHERE id=?`).get(id);
    },
    async create(type, record) {
      const keys = columns[table(type)];
      db.prepare(
        `INSERT INTO ${type} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      ).run(...keys.map((key) => record[key]));
    },
    async update(type, id, record) {
      const keys = Object.keys(record);
      if (
        keys.some((key) => key === 'id' || !columns[table(type)].includes(key))
      )
        throw new Error('Invalid fields');
      db.prepare(
        `UPDATE ${type} SET ${keys.map((key) => `${key}=?`).join(',')} WHERE id=?`,
      ).run(...keys.map((key) => record[key]), id);
    },
    async delete(type, id) {
      db.prepare(`DELETE FROM ${table(type)} WHERE id=?`).run(id);
    },
  };
}
