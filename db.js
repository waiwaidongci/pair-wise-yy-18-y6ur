const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db;

async function connect() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
}

function persist() {
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function select(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function selectOne(sql, params = []) {
  return select(sql, params)[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
}

// 执行多语句 DDL 脚本（不带参数）
function execScript(sql) {
  db.exec(sql);
}

// 在单个事务中执行 fn；成功后落盘，失败整体回滚。
function transaction(fn) {
  db.run('BEGIN');
  try {
    const result = fn();
    db.run('COMMIT');
    persist();
    return result;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

module.exports = { connect, select, selectOne, run, execScript, transaction, persist, DB_FILE };
