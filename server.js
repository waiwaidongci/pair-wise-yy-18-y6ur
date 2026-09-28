const express = require('express');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { randomUUID } = require('crypto');
const config = require('./project.config');

const app = express();
const PORT = process.env.PORT || config.port;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

app.use(express.json({ limit: '2mb' }));

let db;

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function run(sql) {
  db.run(sql);
}

function all(sql) {
  const result = db.exec(sql);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function getRow(sql) {
  return all(sql)[0] || null;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

// 多步写操作放在一个事务里，全部成功才落盘
function transaction(work) {
  run('BEGIN;');
  try {
    const result = work();
    run('COMMIT;');
    persist();
    return result;
  } catch (error) {
    run('ROLLBACK;');
    throw error;
  }
}

function now() {
  return new Date().toISOString();
}

function httpError(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra || {});
  return error;
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

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    throw httpError(404, 'unknown collection: ' + name);
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === null || data[field] === ''
  );
  if (missing.length) {
    throw httpError(400, 'missing required fields: ' + missing.join(', '), {
      code: 'VALIDATION_FAILED',
      missing
    });
  }
}

function assertStatus(collectionConfig, status) {
  if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
    throw httpError(400, 'invalid status: ' + status, { code: 'INVALID_STATUS' });
  }
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function initDb() {
  run(`
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
-- 占用关系：一件物资同一时刻只允许一条 active 占用（由部分唯一索引兜底）
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  box_id TEXT NOT NULL,
  box_no TEXT NOT NULL,
  item_collection TEXT NOT NULL,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  problem TEXT,
  loss_report_id TEXT,
  packed_at TEXT NOT NULL,
  returned_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_item
  ON bookings(item_collection, item_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_bookings_box ON bookings(box_id);
`);

  const count = getRow('SELECT COUNT(*) AS count FROM records;').count;
  if (count > 0) return;

  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...collectionConfig.defaults, ...seed.data, status };
    validate(collectionConfig, data);
    run(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
      [
        sqlValue(id),
        sqlValue(seed.collection),
        sqlValue(status),
        sqlValue(titleFor(collectionConfig, data)),
        sqlValue(JSON.stringify(data)),
        sqlValue(createdAt),
        sqlValue(seed.updatedAt || createdAt)
      ].join(', ') +
      ');'
    );
    insertEvent({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
  persist();
}

function loadRecord(collection, id) {
  const row = getRow(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return row ? toRecord(row) : null;
}

function saveRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  run(
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(titleFor(collectionConfig, data)) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function stripMeta(record) {
  const data = { ...record };
  for (const key of ['id', 'collection', 'createdAt', 'updatedAt']) delete data[key];
  return data;
}

// 创建一条记录并写创建事件
function createRecord(collection, data, eventOptions = {}) {
  const collectionConfig = findCollection(collection);
  const merged = { ...collectionConfig.defaults, ...data };
  const status = merged.status || collectionConfig.defaultStatus || '';
  merged.status = status;
  validate(collectionConfig, merged);
  const id = randomUUID();
  const createdAt = now();
  run(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(collection),
      sqlValue(status),
      sqlValue(titleFor(collectionConfig, merged)),
      sqlValue(JSON.stringify(merged)),
      sqlValue(createdAt),
      sqlValue(createdAt)
    ].join(', ') +
    ');'
  );
  insertEvent({
    recordId: id,
    collection,
    action: eventOptions.action || '创建',
    status,
    actor: eventOptions.actor || '',
    note: eventOptions.note || '',
    data: eventOptions.data || merged
  });
  return id;
}

// 状态流转的唯一入口：改状态、存字段、写事件一起完成
function changeStatus(collection, id, nextStatus, dataPatch, eventOptions = {}) {
  const record = loadRecord(collection, id);
  if (!record) throw httpError(404, 'not found');
  const collectionConfig = findCollection(collection);
  assertStatus(collectionConfig, nextStatus);
  const data = { ...stripMeta(record), ...(dataPatch || {}), status: nextStatus };
  saveRecord(collection, id, data, nextStatus);
  insertEvent({
    recordId: id,
    collection,
    action: eventOptions.action || nextStatus,
    status: nextStatus,
    actor: eventOptions.actor || '',
    note: eventOptions.note || '',
    data: eventOptions.data || dataPatch || {}
  });
  return loadRecord(collection, id);
}

// ---------------- 占用关系 ----------------

const ITEM_TYPES = config.itemTypes;
const ITEM_COLLECTIONS = Object.keys(ITEM_TYPES);
const ITEM_TYPE_ALIASES = {
  puppetHeads: 'puppetHeads',
  puppetHead: 'puppetHeads',
  head: 'puppetHeads',
  heads: 'puppetHeads',
  偶头: 'puppetHeads',
  accessories: 'accessories',
  accessory: 'accessories',
  配件: 'accessories'
};

function normalizeItemType(itemType) {
  const normalized = ITEM_TYPE_ALIASES[itemType];
  if (!normalized) {
    throw httpError(400, 'itemType 必须是 puppetHeads(偶头) 或 accessories(配件)', { code: 'UNKNOWN_ITEM_TYPE' });
  }
  return normalized;
}

function activeBooking(itemCollection, itemId) {
  return getRow(
    'SELECT * FROM bookings WHERE item_collection = ' + sqlValue(itemCollection) +
    ' AND item_id = ' + sqlValue(itemId) + " AND status = 'active' LIMIT 1;"
  );
}

function boxActiveBookings(boxId) {
  return all('SELECT * FROM bookings WHERE box_id = ' + sqlValue(boxId) + " AND status = 'active' ORDER BY packed_at ASC;");
}

function boxAllBookings(boxId) {
  return all('SELECT * FROM bookings WHERE box_id = ' + sqlValue(boxId) + ' ORDER BY packed_at ASC;');
}

function findBoxByNo(boxNo) {
  return getRow(
    'SELECT * FROM records WHERE collection = ' + sqlValue('tourBoxes') +
    ' AND json_extract(data, ' + sqlValue('$.boxNo') + ') = ' + sqlValue(boxNo) + ' LIMIT 1;'
  );
}

function itemDisplayName(itemCollection, item) {
  return titleFor(findCollection(itemCollection), item);
}

// 逐件核对：可用状态 + 占用关系，冲突时直接给出所在箱号
function checkPackItem(itemCollection, itemId, options = {}) {
  const typeConfig = ITEM_TYPES[itemCollection];
  const item = loadRecord(itemCollection, itemId);
  if (!item) {
    return {
      itemType: itemCollection,
      itemTypeLabel: typeConfig.label,
      itemId,
      available: false,
      code: 'ITEM_NOT_FOUND',
      reason: '未找到该' + typeConfig.label
    };
  }

  const name = itemDisplayName(itemCollection, item);

  // 占用关系优先核对：已装入别箱时直接说明所在箱号
  const booking = activeBooking(itemCollection, itemId);
  if (booking) {
    if (options.currentBoxId && booking.box_id === options.currentBoxId) {
      return {
        itemType: itemCollection,
        itemTypeLabel: typeConfig.label,
        itemId,
        name,
        available: true,
        currentStatus: item.status,
        code: 'ALREADY_IN_BOX',
        boxId: booking.box_id,
        boxNo: booking.box_no,
        reason: '已在本箱（' + booking.box_no + '）中'
      };
    }
    return {
      itemType: itemCollection,
      itemTypeLabel: typeConfig.label,
      itemId,
      name,
      available: false,
      currentStatus: item.status,
      code: 'ITEM_IN_BOX',
      boxId: booking.box_id,
      boxNo: booking.box_no,
      reason: typeConfig.label + '已装入巡演箱 ' + booking.box_no
    };
  }

  if (item.status !== typeConfig.packableStatus) {
    return {
      itemType: itemCollection,
      itemTypeLabel: typeConfig.label,
      itemId,
      name,
      available: false,
      currentStatus: item.status,
      code: 'ITEM_NOT_USABLE',
      reason: typeConfig.label + '当前状态为「' + item.status + '」，不可装箱（需为「' + typeConfig.packableStatus + '」）'
    };
  }

  return {
    itemType: itemCollection,
    itemTypeLabel: typeConfig.label,
    itemId,
    name,
    available: true,
    currentStatus: item.status,
    reason: '可装箱'
  };
}

function collectChecks(headIds, accessoryIds, options) {
  const checks = [];
  const seen = new Set();
  const groups = [['puppetHeads', headIds], ['accessories', accessoryIds]];
  for (const [itemCollection, ids] of groups) {
    for (const itemId of ids || []) {
      const key = itemCollection + ':' + itemId;
      if (seen.has(key)) {
        const typeConfig = ITEM_TYPES[itemCollection];
        checks.push({
          itemType: itemCollection,
          itemTypeLabel: typeConfig.label,
          itemId,
          available: false,
          code: 'DUPLICATE_ITEM',
          reason: typeConfig.label + '在装箱清单中重复出现'
        });
        continue;
      }
      seen.add(key);
      checks.push(checkPackItem(itemCollection, itemId, options));
    }
  }
  return checks;
}

function insertBooking(box, itemCollection, itemId) {
  run(
    'INSERT INTO bookings (id, box_id, box_no, item_collection, item_id, status, packed_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(box.id),
      sqlValue(box.boxNo),
      sqlValue(itemCollection),
      sqlValue(itemId),
      sqlValue('active'),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

// 装箱：建立占用并把物资流转到「已装箱」
function packItem(box, itemCollection, itemId, actor, action) {
  insertBooking(box, itemCollection, itemId);
  const item = loadRecord(itemCollection, itemId);
  const patch = itemCollection === 'puppetHeads' ? { currentUsable: true } : {};
  changeStatus(itemCollection, itemId, '已装箱', patch, {
    action: action || '装箱',
    actor,
    data: {
      tourBoxId: box.id,
      boxNo: box.boxNo,
      showName: box.showName,
      play: box.play
    }
  });
}

// 撤箱/返场后，按结果恢复物资状态
function releaseStatus(result, itemCollection) {
  if (itemCollection === 'puppetHeads') {
    if (result === '完好') return { status: '可演出', patch: { currentUsable: true } };
    if (result === '缺损') return { status: '待修补', patch: { currentUsable: false } };
    return { status: '不可演出', patch: { currentUsable: false } }; // 遗失
  }
  if (result === '完好') return { status: '在库', patch: {} };
  if (result === '缺损') return { status: '缺损', patch: {} };
  return { status: '遗失', patch: {} };
}

// 用占用表回写箱子清单，保证 headIds/accessoryIds 与占用关系一致
function syncBoxMembership(boxId) {
  const box = loadRecord('tourBoxes', boxId);
  const bookings = boxActiveBookings(boxId);
  const data = {
    ...stripMeta(box),
    headIds: bookings.filter((b) => b.item_collection === 'puppetHeads').map((b) => b.item_id),
    accessoryIds: bookings.filter((b) => b.item_collection === 'accessories').map((b) => b.item_id)
  };
  saveRecord('tourBoxes', boxId, data, box.status);
}

function assertBoxEditable(box) {
  if (!['草稿', '已装箱'].includes(box.status)) {
    throw httpError(409, '箱子状态为「' + box.status + '」，成员已锁定，不能再增减物资', {
      code: 'BOX_LOCKED'
    });
  }
}

function assertBoxDeparted(box) {
  if (!['巡演中', '返场清点中'].includes(box.status)) {
    throw httpError(409, '箱子尚未出发（当前「' + box.status + '」），不能登记返场', {
      code: 'BOX_NOT_DEPARTED'
    });
  }
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

// ---------------- 装箱/返场流程 ----------------

// 建箱：逐件核对全部通过才建箱并占用
function createTourBox(req, res, next) {
  try {
    const body = req.body || {};
    const data = {
      ...config.collections.tourBoxes.defaults,
      boxNo: body.boxNo,
      showName: body.showName,
      venue: body.venue,
      play: body.play,
      note: body.note || '',
      headIds: body.headIds || [],
      accessoryIds: body.accessoryIds || []
    };
    validate(config.collections.tourBoxes, data);
    if (findBoxByNo(data.boxNo)) {
      throw httpError(409, '箱号 ' + data.boxNo + ' 已存在', { code: 'BOX_NO_TAKEN' });
    }

    const checks = collectChecks(data.headIds, data.accessoryIds);
    const conflicts = checks.filter((check) => !check.available || check.code === 'DUPLICATE_ITEM');
    if (conflicts.length) {
      throw httpError(409, '装箱核对未通过，已阻止建箱：' + conflicts.map((c) => c.itemId + ' ' + c.reason).join('；'), {
        code: 'PACK_CHECK_FAILED',
        conflicts
      });
    }

    const box = transaction(() => {
      const id = createRecord('tourBoxes', { ...data, status: '草稿' }, {
        action: '建箱',
        actor: body.actor,
        note: body.note || '',
        data: {
          boxNo: data.boxNo,
          showName: data.showName,
          venue: data.venue,
          play: data.play,
          headIds: data.headIds,
          accessoryIds: data.accessoryIds
        }
      });
      const created = loadRecord('tourBoxes', id);
      for (const itemId of data.headIds) packItem(created, 'puppetHeads', itemId, body.actor, '装箱');
      for (const itemId of data.accessoryIds) packItem(created, 'accessories', itemId, body.actor, '装箱');
      syncBoxMembership(id);
      return loadRecord('tourBoxes', id);
    });

    res.status(201).json(box);
  } catch (error) {
    next(error);
  }
}

function loadTourBox(req) {
  const box = loadRecord('tourBoxes', req.params.id);
  if (!box) throw httpError(404, 'not found');
  return box;
}

// 建箱/装箱前的逐件核对（只读）
app.post('/api/tourBoxes/check-items', (req, res, next) => {
  try {
    const body = req.body || {};
    const checks = collectChecks(body.headIds, body.accessoryIds, {});
    res.json({
      ok: checks.every((check) => check.available && check.code !== 'DUPLICATE_ITEM'),
      items: checks
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tourBoxes', createTourBox);

// 装箱：向草稿/已装箱箱子逐件追加
app.post('/api/tourBoxes/:id/items', (req, res, next) => {
  try {
    const box = loadTourBox(req);
    assertBoxEditable(box);
    const body = req.body || {};
    const itemType = body.itemType ? normalizeItemType(body.itemType) : null;
    const itemIds = body.itemIds || (body.itemId ? [body.itemId] : []);
    if (itemType && itemIds.length === 0) {
      throw httpError(400, '请提供 itemId 或 itemIds', { code: 'VALIDATION_FAILED' });
    }

    const checks = itemType
      ? itemIds.map((itemId) => checkPackItem(itemType, itemId, { currentBoxId: box.id }))
      : collectChecks(body.headIds, body.accessoryIds, { currentBoxId: box.id });
    const blockers = checks.filter((check) => !check.available && check.code !== 'ALREADY_IN_BOX');
    if (blockers.length) {
      throw httpError(409, '装箱核对未通过：' + blockers.map((c) => (c.name || c.itemId) + ' ' + c.reason).join('；'), {
        code: 'PACK_CHECK_FAILED',
        conflicts: blockers
      });
    }

    const pending = itemType
      ? itemIds.map((itemId) => [itemType, itemId])
      : [
          ...(body.headIds || []).map((id) => ['puppetHeads', id]),
          ...(body.accessoryIds || []).map((id) => ['accessories', id])
        ];

    transaction(() => {
      for (const [collection, itemId] of pending) {
        const check = checkPackItem(collection, itemId, { currentBoxId: box.id });
        if (check.code === 'ALREADY_IN_BOX') continue;
        packItem(box, collection, itemId, body.actor, '装箱');
      }
      syncBoxMembership(box.id);
    });
    res.json(loadRecord('tourBoxes', box.id));
  } catch (error) {
    next(error);
  }
});

// 从箱中撤出物资（未出发前）
app.post('/api/tourBoxes/:id/remove-items', (req, res, next) => {
  try {
    const box = loadTourBox(req);
    assertBoxEditable(box);
    const body = req.body || {};
    const itemType = body.itemType ? normalizeItemType(body.itemType) : null;
    const pending = itemType && body.itemId
      ? [[itemType, body.itemId]]
      : [
          ...(body.headIds || []).map((id) => ['puppetHeads', id]),
          ...(body.accessoryIds || []).map((id) => ['accessories', id])
        ];
    if (!pending.length) throw httpError(400, '请提供要撤出的物资', { code: 'VALIDATION_FAILED' });

    transaction(() => {
      for (const [collection, itemId] of pending) {
        const booking = getRow(
          'SELECT * FROM bookings WHERE box_id = ' + sqlValue(box.id) +
          ' AND item_collection = ' + sqlValue(collection) +
          ' AND item_id = ' + sqlValue(itemId) + " AND status = 'active' LIMIT 1;"
        );
        if (!booking) {
          throw httpError(409, ITEM_TYPES[collection].label + ' ' + itemId + ' 不在本箱中', {
            code: 'NOT_IN_BOX'
          });
        }
        run('DELETE FROM bookings WHERE id = ' + sqlValue(booking.id) + ';');
        const { status, patch } = releaseStatus('完好', collection);
        changeStatus(collection, itemId, status, patch, {
          action: '撤箱',
          actor: body.actor,
          data: { tourBoxId: box.id, boxNo: box.boxNo }
        });
      }
      syncBoxMembership(box.id);
    });
    res.json(loadRecord('tourBoxes', box.id));
  } catch (error) {
    next(error);
  }
});

// 封箱：草稿 -> 已装箱
app.post('/api/tourBoxes/:id/seal', (req, res, next) => {
  try {
    const box = loadTourBox(req);
    if (box.status !== '草稿') {
      throw httpError(409, '只有草稿箱可以封箱（当前「' + box.status + '」）', { code: 'INVALID_TRANSITION' });
    }
    if (!boxActiveBookings(box.id).length) {
      throw httpError(409, '空箱不能封箱', { code: 'EMPTY_BOX' });
    }
    const actor = (req.body || {}).actor;
    transaction(() => {
      changeStatus('tourBoxes', box.id, '已装箱', {}, {
        action: '封箱',
        actor,
        note: (req.body || {}).note || '',
        data: { lockedAt: now() }
      });
    });
    res.json(loadRecord('tourBoxes', box.id));
  } catch (error) {
    next(error);
  }
});

// 出发：成员锁定，按件写入出发事件
app.post('/api/tourBoxes/:id/depart', (req, res, next) => {
  try {
    const box = loadTourBox(req);
    if (!['草稿', '已装箱'].includes(box.status)) {
      throw httpError(409, '箱子已出发或已闭环（当前「' + box.status + '」）', { code: 'INVALID_TRANSITION' });
    }
    const bookings = boxActiveBookings(box.id);
    if (!bookings.length) {
      throw httpError(409, '空箱不能出发', { code: 'EMPTY_BOX' });
    }
    const body = req.body || {};
    transaction(() => {
      changeStatus('tourBoxes', box.id, '巡演中', { lockedAt: now() }, {
        action: '出发',
        actor: body.actor,
        note: body.note || '',
        data: { headCount: box.headIds.length, accessoryCount: box.accessoryIds.length }
      });
      for (const booking of bookings) {
        insertEvent({
          recordId: booking.item_id,
          collection: booking.item_collection,
          action: '随箱出发',
          status: '已装箱',
          actor: body.actor || '',
          note: body.note || '',
          data: { tourBoxId: box.id, boxNo: box.boxNo, showName: box.showName, venue: box.venue }
        });
      }
    });
    res.json(loadRecord('tourBoxes', box.id));
  } catch (error) {
    next(error);
  }
});

const RETURN_RESULTS = ['完好', '缺损', '遗失'];

// 返场：按件登记完好/缺损/遗失
app.post('/api/tourBoxes/:id/return', (req, res, next) => {
  try {
    const box = loadTourBox(req);
    assertBoxDeparted(box);
    const body = req.body || {};
    const itemCollection = body.itemType ? normalizeItemType(body.itemType) : null;
    if (!itemCollection || !body.itemId) {
      throw httpError(400, '请提供 itemType 与 itemId', { code: 'VALIDATION_FAILED' });
    }
    if (!RETURN_RESULTS.includes(body.result)) {
      throw httpError(400, 'result 必须是 完好 / 缺损 / 遗失', { code: 'VALIDATION_FAILED' });
    }
    if (body.result !== '完好' && !body.problem) {
      throw httpError(400, '登记' + body.result + '必须填写 problem', { code: 'VALIDATION_FAILED' });
    }

    const item = loadRecord(itemCollection, body.itemId);
    if (!item) throw httpError(404, '未找到该物资', { code: 'ITEM_NOT_FOUND' });

    const result = transaction(() => {
      const booking = getRow(
        'SELECT * FROM bookings WHERE box_id = ' + sqlValue(box.id) +
        ' AND item_collection = ' + sqlValue(itemCollection) +
        ' AND item_id = ' + sqlValue(body.itemId) + " AND status = 'active' LIMIT 1;"
      );
      if (!booking) {
        const elsewhere = activeBooking(itemCollection, body.itemId);
        throw httpError(
          409,
          elsewhere
            ? ITEM_TYPES[itemCollection].label + '占用在巡演箱 ' + elsewhere.box_no + '，不属于本箱'
            : ITEM_TYPES[itemCollection].label + '未在本箱占用中，不能登记返场',
          { code: elsewhere ? 'ITEM_IN_BOX' : 'NOT_IN_BOX' }
        );
      }

      const { status: nextStatus, patch } = releaseStatus(body.result, itemCollection);
      let lossReportId = null;

      if (body.result === '完好') {
        run(
          'UPDATE bookings SET status = ' + sqlValue('returned') +
          ', result = ' + sqlValue('完好') +
          ', returned_at = ' + sqlValue(now()) +
          ' WHERE id = ' + sqlValue(booking.id) + ';'
        );
      } else {
        lossReportId = createRecord('lossReports', {
          tourBoxId: box.id,
          boxNo: box.boxNo,
          itemType: ITEM_TYPES[itemCollection].label,
          itemCollection,
          itemId: item.id,
          itemName: itemDisplayName(itemCollection, item),
          problem: body.problem,
          status: body.result === '遗失' ? '确认为遗失' : '待处理'
        }, {
          action: '返场登记',
          actor: body.actor,
          note: body.note || '',
          data: { tourBoxId: box.id, boxNo: box.boxNo, result: body.result }
        });
        run(
          'UPDATE bookings SET status = ' + sqlValue(body.result === '遗失' ? 'lost' : 'damaged') +
          ', result = ' + sqlValue(body.result) +
          ', problem = ' + sqlValue(body.problem) +
          ', loss_report_id = ' + sqlValue(lossReportId) +
          ', returned_at = ' + sqlValue(now()) +
          ' WHERE id = ' + sqlValue(booking.id) + ';'
        );
      }

      changeStatus(itemCollection, item.id, nextStatus, patch, {
        action: '返场-' + body.result,
        actor: body.actor,
        note: body.note || '',
        data: {
          tourBoxId: box.id,
          boxNo: box.boxNo,
          result: body.result,
          problem: body.problem || '',
          lossReportId
        }
      });

      insertEvent({
        recordId: box.id,
        collection: 'tourBoxes',
        action: '返场登记',
        status: box.status,
        actor: body.actor || '',
        note: body.note || '',
        data: {
          itemType: ITEM_TYPES[itemCollection].label,
          itemCollection,
          itemId: item.id,
          itemName: itemDisplayName(itemCollection, item),
          result: body.result,
          problem: body.problem || '',
          lossReportId
        }
      });

      // 全部清点完：自动闭环；否则进入返场清点中
      const remaining = boxActiveBookings(box.id);
      if (!remaining.length) {
        changeStatus('tourBoxes', box.id, '已闭环', {}, {
          action: '闭环',
          actor: body.actor,
          data: { closedAt: now() }
        });
      } else if (box.status === '巡演中') {
        changeStatus('tourBoxes', box.id, '返场清点中', {}, {
          action: '开始返场清点',
          actor: body.actor,
          data: { remaining: remaining.length }
        });
      }

      return { updatedBox: loadRecord('tourBoxes', box.id), updatedItem: loadRecord(itemCollection, item.id), lossReportId };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 手动闭环（清点已结束时）
app.post('/api/tourBoxes/:id/close', (req, res, next) => {
  try {
    const box = loadTourBox(req);
    assertBoxDeparted(box);
    if (boxActiveBookings(box.id).length) {
      throw httpError(409, '仍有物资未返场登记，不能闭环', { code: 'ITEMS_PENDING' });
    }
    const body = req.body || {};
    transaction(() => {
      changeStatus('tourBoxes', box.id, '已闭环', {}, {
        action: '闭环',
        actor: body.actor,
        note: body.note || '',
        data: { closedAt: now() }
      });
    });
    res.json(loadRecord('tourBoxes', box.id));
  } catch (error) {
    next(error);
  }
});

// 箱内成员 + 返场清点情况
app.get('/api/tourBoxes/:id/roster', (req, res, next) => {
  try {
    const box = loadTourBox(req);
    const items = boxAllBookings(box.id).map((booking) => {
      const item = loadRecord(booking.item_collection, booking.item_id);
      return {
        itemType: ITEM_TYPES[booking.item_collection].label,
        itemCollection: booking.item_collection,
        itemId: booking.item_id,
        name: item ? itemDisplayName(booking.item_collection, item) : null,
        bookingStatus: booking.status,
        result: booking.result,
        problem: booking.problem,
        lossReportId: booking.loss_report_id,
        packedAt: booking.packed_at,
        returnedAt: booking.returned_at,
        currentStatus: item ? item.status : null
      };
    });
    res.json({ box, items });
  } catch (error) {
    next(error);
  }
});

// 占用关系查询：?status=active(默认)/all&boxNo=&itemId=
app.get('/api/bookings', (req, res, next) => {
  try {
    const where = [];
    if ((req.query.status || 'active') !== 'all') where.push("status = 'active'");
    if (req.query.boxNo) where.push('box_no = ' + sqlValue(req.query.boxNo));
    if (req.query.itemId) where.push('item_id = ' + sqlValue(req.query.itemId));
    const rows = all(
      'SELECT * FROM bookings' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY packed_at ASC;'
    );
    res.json(rows.map((row) => ({
      id: row.id,
      tourBoxId: row.box_id,
      boxNo: row.box_no,
      itemCollection: row.item_collection,
      itemId: row.item_id,
      itemType: ITEM_TYPES[row.item_collection].label,
      status: row.status,
      result: row.result,
      problem: row.problem,
      lossReportId: row.loss_report_id,
      packedAt: row.packed_at,
      returnedAt: row.returned_at
    })));
  } catch (error) {
    next(error);
  }
});

// ---------------- 通用档案接口（带流程护栏） ----------------

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    itemTypes: ITEM_TYPES,
    examples: config.examples || []
  });
});

app.get('/api/:collection', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const rows = all(
      'SELECT * FROM records WHERE collection = ' + sqlValue(req.params.collection) + ' ORDER BY updated_at DESC;'
    ).map(toRecord);
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
    if (req.params.collection === 'tourBoxes') return createTourBox(req, res, next);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    assertStatus(collectionConfig, status);
    validate(collectionConfig, data);
    const createdId = transaction(() => createRecord(req.params.collection, data, {
      action: req.body.action || '创建',
      actor: req.body.actor,
      note: req.body.note
    }));
    res.status(201).json(loadRecord(req.params.collection, createdId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    const collectionName = req.params.collection;
    const collectionConfig = findCollection(collectionName);
    const record = loadRecord(collectionName, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });

    if (collectionName === 'tourBoxes') {
      for (const key of ['status', 'headIds', 'accessoryIds']) {
        if (req.body[key] !== undefined) {
          throw httpError(409, '箱子状态与成员只能通过装箱/出发/返场流程接口变更', { code: 'FLOW_ONLY' });
        }
      }
      if (req.body.boxNo !== undefined && req.body.boxNo !== record.boxNo) {
        const other = findBoxByNo(req.body.boxNo);
        if (other && other.id !== record.id) {
          throw httpError(409, '箱号 ' + req.body.boxNo + ' 已存在', { code: 'BOX_NO_TAKEN' });
        }
      }
    }

    if (ITEM_COLLECTIONS.includes(collectionName) && req.body.status !== undefined && req.body.status !== record.status) {
      assertStatus(collectionConfig, req.body.status);
      const booking = activeBooking(collectionName, req.params.id);
      if (booking) {
        throw httpError(409, '物资已装入巡演箱 ' + booking.box_no + '，状态须随返场登记流转', {
          code: 'ITEM_LOCKED',
          boxId: booking.box_id,
          boxNo: booking.box_no
        });
      }
    }

    const nextData = { ...record, ...req.body };
    const nextStatus = nextData.status || record.status;
    assertStatus(collectionConfig, nextStatus);
    nextData.status = nextStatus;
    transaction(() => {
      saveRecord(collectionName, req.params.id, stripMeta(nextData), nextStatus);
      insertEvent({
        recordId: req.params.id,
        collection: collectionName,
        action: req.body.action || '更新',
        status: nextStatus,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
    });
    res.json(loadRecord(collectionName, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collectionName = req.params.collection;
    const collectionConfig = findCollection(collectionName);
    const record = loadRecord(collectionName, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });

    if (collectionName === 'tourBoxes' && req.body.status && req.body.status !== record.status) {
      throw httpError(409, '箱子状态只能通过封箱/出发/返场/闭环接口流转', { code: 'FLOW_ONLY' });
    }
    if (
      ITEM_COLLECTIONS.includes(collectionName) &&
      req.body.status &&
      req.body.status !== record.status &&
      activeBooking(collectionName, req.params.id)
    ) {
      throw httpError(409, '物资在巡演箱占用中，状态须随返场登记流转', { code: 'ITEM_LOCKED' });
    }

    const status = req.body.status || record.status;
    assertStatus(collectionConfig, status);
    const nextData = { ...record, ...(req.body.fields || {}), status };
    transaction(() => {
      saveRecord(collectionName, req.params.id, stripMeta(nextData), status);
      insertEvent({
        recordId: req.params.id,
        collection: collectionName,
        action: req.body.action || status || '记录',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
    });
    res.json(loadRecord(collectionName, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    findCollection(req.params.collection);
    const record = loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = all(
      'SELECT * FROM events WHERE record_id = ' + sqlValue(req.params.id) + ' ORDER BY created_at ASC;'
    ).map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
    const booking = req.params.collection === 'tourBoxes' ? null : activeBooking(req.params.collection, req.params.id);
    res.json({
      record,
      occupiedIn: booking ? { tourBoxId: booking.box_id, boxNo: booking.box_no, packedAt: booking.packed_at } : null,
      events
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    const collectionName = req.params.collection;
    findCollection(collectionName);
    const record = loadRecord(collectionName, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });

    const runSqlDelete = () => {
      run('DELETE FROM records WHERE collection = ' + sqlValue(collectionName) + ' AND id = ' + sqlValue(req.params.id) + ';');
      run('DELETE FROM events WHERE record_id = ' + sqlValue(req.params.id) + ';');
    };

    if (collectionName === 'tourBoxes') {
      if (record.status !== '草稿') {
        throw httpError(409, '只有草稿箱可以删除（当前「' + record.status + '」）', { code: 'BOX_LOCKED' });
      }
      transaction(() => {
        for (const booking of boxActiveBookings(record.id)) {
          run('DELETE FROM bookings WHERE id = ' + sqlValue(booking.id) + ';');
          const { status, patch } = releaseStatus('完好', booking.item_collection);
          changeStatus(booking.item_collection, booking.item_id, status, patch, {
            action: '撤箱',
            data: { tourBoxId: record.id, boxNo: record.boxNo, reason: '装箱单删除' }
          });
        }
        runSqlDelete();
      });
    } else if (ITEM_COLLECTIONS.includes(collectionName)) {
      const booking = activeBooking(collectionName, req.params.id);
      if (booking) {
        throw httpError(409, '物资已装入巡演箱 ' + booking.box_no + '，请先撤出或返场', {
          code: 'ITEM_LOCKED',
          boxNo: booking.box_no
        });
      }
      transaction(() => runSqlDelete());
    } else {
      transaction(() => runSqlDelete());
    }

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const body = { error: error.message || 'server error' };
  for (const key of ['code', 'missing', 'conflicts', 'boxId', 'boxNo']) {
    if (error[key] !== undefined) body[key] = error[key];
  }
  res.status(error.status || 500).json(body);
});

initSqlJs({
  locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
}).then((SQL) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  initDb();
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}).catch((error) => {
  console.error('数据库初始化失败:', error);
  process.exit(1);
});
