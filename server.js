const express = require('express');
const db = require('./db');
const store = require('./store');
const tourflow = require('./tourflow');
const config = require('./project.config');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === ''
  );
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function initSchema() {
  db.execScript(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
-- 占用关系独立成表：一件物资在任意时刻至多一条活跃占用（held 草稿 / locked 锁定）
CREATE TABLE IF NOT EXISTS item_occupancy (
  id TEXT PRIMARY KEY,
  box_id TEXT NOT NULL,
  item_collection TEXT NOT NULL,
  item_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  locked_at TEXT,
  released_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_occupancy_active
  ON item_occupancy(item_collection, item_id) WHERE state IN ('held', 'locked');
CREATE INDEX IF NOT EXISTS idx_occupancy_box ON item_occupancy(box_id);
-- 返场按件登记
CREATE TABLE IF NOT EXISTS item_returns (
  id TEXT PRIMARY KEY,
  box_id TEXT NOT NULL,
  item_collection TEXT NOT NULL,
  item_id TEXT NOT NULL,
  result_label TEXT NOT NULL,
  problem TEXT,
  actor TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (box_id, item_collection, item_id)
);
CREATE INDEX IF NOT EXISTS idx_returns_box ON item_returns(box_id);
  `);
}

function seedData() {
  const count = db.selectOne('SELECT COUNT(*) AS count FROM records;').count;
  if (count > 0) return;

  db.transaction(() => {
    for (const seed of config.seed || []) {
      const collectionConfig = findCollection(seed.collection);
      const createdAt = seed.createdAt || store.now();
      const status = seed.status || collectionConfig.defaultStatus || '';
      const data = { ...seed.data, status };
      const id = store.insertRecord(collectionConfig, seed.collection, {
        id: seed.id,
        status,
        data,
        createdAt
      });
      store.insertEvent({
        recordId: id,
        collection: seed.collection,
        action: seed.eventAction || '创建',
        status,
        actor: seed.actor || 'system',
        note: seed.note || '',
        data
      });
    }
  });
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

// 装箱-返场专用流程路由（须在通用 :collection 路由之前挂载）
app.use('/api/tourBoxes', tourflow.createRouter(config));

// 缺损追踪单只能由返场登记产生
app.post('/api/lossReports', (req, res, next) => {
  next(Object.assign(new Error('缺损追踪单由返场登记自动开立，请使用 POST /api/tourBoxes/:id/returnRegister'), { status: 405 }));
});

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const rows = db
      .select('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;', [req.params.collection])
      .map((row) => store.toRecord(row));
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = db.transaction(() => {
      const newId = store.insertRecord(collectionConfig, req.params.collection, { status, data });
      store.insertEvent({
        recordId: newId,
        collection: req.params.collection,
        action: req.body.action || '创建',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data
      });
      return newId;
    });
    res.status(201).json(store.loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = store.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    const collection = req.params.collection;
    findCollection(collection);
    const record = store.loadRecord(collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    // 偶头/配件在箱期间锁定，禁止通用改状态
    if (collection === tourflow.HEADS || collection === tourflow.ACCESSORIES) {
      tourflow.assertItemWritable(collection, req.params.id);
    }
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    db.transaction(() => {
      store.saveRecord(findCollection(collection), collection, req.params.id, nextData, status);
      store.insertEvent({
        recordId: req.params.id,
        collection,
        action: req.body.action || '更新',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
    });
    res.json(store.loadRecord(collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collection = req.params.collection;
    const collectionConfig = findCollection(collection);
    const record = store.loadRecord(collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    if (collection === tourflow.HEADS || collection === tourflow.ACCESSORIES) {
      tourflow.assertItemWritable(collection, req.params.id);
    }
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    db.transaction(() => {
      store.saveRecord(collectionConfig, collection, req.params.id, nextData, status);
      store.insertEvent({
        recordId: req.params.id,
        collection,
        action: req.body.action || status || '记录',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
    });
    res.json(store.loadRecord(collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = store.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ record, events: store.listEvents(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    const collection = req.params.collection;
    findCollection(collection);
    if (collection === tourflow.HEADS || collection === tourflow.ACCESSORIES) {
      tourflow.assertItemWritable(collection, req.params.id);
      db.transaction(() => {
        db.run('DELETE FROM records WHERE collection = ? AND id = ?;', [collection, req.params.id]);
        db.run('DELETE FROM events WHERE record_id = ?;', [req.params.id]);
        db.run('DELETE FROM item_occupancy WHERE item_collection = ? AND item_id = ?;', [collection, req.params.id]);
        db.run('DELETE FROM item_returns WHERE item_collection = ? AND item_id = ?;', [collection, req.params.id]);
      });
      return res.status(204).end();
    }
    if (collection === tourflow.BOXES) {
      tourflow.discardDraftBox(config, req.params.id, req.query.actor || '');
      return res.status(204).end();
    }
    db.transaction(() => {
      db.run('DELETE FROM records WHERE collection = ? AND id = ?;', [collection, req.params.id]);
      db.run('DELETE FROM events WHERE record_id = ?;', [req.params.id]);
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  if (error.details) {
    return res.status(status).json({ error: error.message || 'server error', details: error.details });
  }
  res.status(status).json({ error: error.message || 'server error' });
});

db.connect().then(() => {
  initSchema();
  seedData();
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
});
