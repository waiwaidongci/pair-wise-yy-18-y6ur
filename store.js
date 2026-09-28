const { randomUUID } = require('crypto');
const db = require('./db');

function now() {
  return new Date().toISOString();
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function loadRow(collection, id) {
  return db.selectOne(
    'SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;',
    [collection, id]
  );
}

function loadRecord(collection, id) {
  const row = loadRow(collection, id);
  return row ? toRecord(row) : null;
}

function saveRecord(collectionConfig, collection, id, data, status) {
  db.run(
    'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE collection = ? AND id = ?;',
    [status, titleFor(collectionConfig, data), JSON.stringify(data), now(), collection, id]
  );
}

function insertRecord(collectionConfig, collection, { id = randomUUID(), status, data, createdAt = now() }) {
  db.run(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
    [id, collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, createdAt]
  );
  return id;
}

function insertEvent({ recordId, collection, action, status, actor, note, data }, executor = db) {
  executor.run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
    [
      randomUUID(),
      recordId,
      collection,
      action || '记录',
      status || '',
      actor || '',
      note || '',
      JSON.stringify(data || {}),
      now()
    ]
  );
}

function listEvents(recordId) {
  return db
    .select('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC;', [recordId])
    .map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
}

module.exports = {
  now,
  titleFor,
  toRecord,
  loadRow,
  loadRecord,
  saveRecord,
  insertRecord,
  insertEvent,
  listEvents
};
