const express = require('express');
const { randomUUID } = require('crypto');
const db = require('./db');
const store = require('./store');

const HEADS = 'puppetHeads';
const ACCESSORIES = 'accessories';
const BOXES = 'tourBoxes';
const LOSSES = 'lossReports';

// 装箱流程下的物资状态约定
const HEAD_USABLE_STATUS = '可演出';
const HEAD_PACKED_STATUS = '已装箱';
const HEAD_REPAIR_STATUS = '待修补';
const ACCESSORY_USABLE_STATUS = '在库';
const ACCESSORY_PACKED_STATUS = '已装箱';
const ACCESSORY_DAMAGED_STATUS = '缺损';
const ACCESSORY_LOST_STATUS = '遗失';

// 占用关系：held=草稿占用，locked=出发锁定，released=返场释放
const RETURN_RESULTS = {
  intact: '完好',
  damaged: '缺损',
  lost: '遗失'
};

const ITEM_COLLECTIONS = {
  puppetHead: HEADS,
  head: HEADS,
  偶头: HEADS,
  accessory: ACCESSORIES,
  配件: ACCESSORIES
};

function itemCollection(itemType) {
  return ITEM_COLLECTIONS[itemType];
}

function fail(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra);
}

function uniqueList(values) {
  return [...new Set((values || []).map((v) => String(v)).filter(Boolean))];
}

function loadBox(id) {
  const row = db.selectOne('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;', [BOXES, id]);
  if (!row) return null;
  return { row, record: store.toRecord(row) };
}

// 活跃占用：物资当前所在（或已锁定）的箱子。一物资同时只能有一条。
function activeOccupancy(collection, itemId) {
  return db.selectOne(
    `SELECT o.*, r.title AS box_title, r.data AS box_data
       FROM item_occupancy o
       JOIN records r ON r.id = o.box_id
      WHERE o.item_collection = ? AND o.item_id = ? AND o.state IN ('held', 'locked')
      LIMIT 1;`,
    [collection, itemId]
  );
}

function activeOccupancies(collection, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.select(
    `SELECT o.*, r.title AS box_title, r.data AS box_data
       FROM item_occupancy o
       JOIN records r ON r.id = o.box_id
      WHERE o.item_collection = ? AND o.state IN ('held', 'locked')
        AND o.item_id IN (${placeholders});`,
    [collection, ...ids]
  );
}

function getRecords(collection, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db
    .select(`SELECT * FROM records WHERE collection = ? AND id IN (${placeholders});`, [collection, ...ids])
    .map((row) => ({ row, record: store.toRecord(row) }));
}

// 逐件核对：可用状态 + 占用关系；已在别箱的直接报出所在箱号
function checkItems(config, headIds, accessoryIds, opts = {}) {
  const headCfg = config.collections[HEADS];
  const accCfg = config.collections[ACCESSORIES];
  const results = [];
  const accepted = [];

  const scan = (collection, ids, cfg, kind, packedStatus) => {
    const seen = new Set();
    const rows = new Map(getRecords(collection, ids).map((entry) => [entry.row.id, entry]));
    const occupied = new Map(
      activeOccupancies(collection, ids).map((occ) => [occ.item_id, occ])
    );
    for (const id of ids) {
      const item = { itemType: kind, itemId: id, ok: false };
      if (seen.has(id)) {
        item.reason = '装箱单内重复列出同一物资';
      } else {
        seen.add(id);
        const entry = rows.get(id);
        if (!entry) {
          item.reason = '物资档案不存在';
        } else {
          const usableStatus = collection === HEADS ? HEAD_USABLE_STATUS : ACCESSORY_USABLE_STATUS;
          item.itemName = store.titleFor(cfg, entry.record);
          const occ = occupied.get(id);
          // 本箱占用（用于建箱后再加件的复核）不算冲突
          if (occ && occ.box_id !== opts.selfBoxId) {
            const boxData = JSON.parse(occ.box_data || '{}');
            item.reason =
              '已装入巡演箱 ' + (boxData.boxNo || occ.box_title) +
              '（箱号 ' + (occ.box_id) + '），占用状态：' +
              (occ.state === 'locked' ? '已出发锁定' : '草稿占用');
            item.tourBoxId = occ.box_id;
          } else if (entry.record.status === packedStatus && !occ) {
            item.reason = '状态为已装箱但查不到占用关系，请联系班主核对';
          } else if (entry.record.status !== usableStatus) {
            item.reason = '当前状态「' + entry.record.status + '」，需为「' + usableStatus + '」才可装箱';
          } else {
            item.ok = true;
          }
        }
      }
      results.push(item);
      if (item.ok) accepted.push({ collection, id });
    }
  };

  scan(HEADS, headIds, headCfg, 'puppetHead', HEAD_PACKED_STATUS);
  scan(ACCESSORIES, accessoryIds, accCfg, 'accessory', ACCESSORY_PACKED_STATUS);
  return { results, accepted };
}

function nextBoxNo() {
  const rows = db.select("SELECT data FROM records WHERE collection = ?;", [BOXES]);
  let max = 0;
  for (const row of rows) {
    const boxNo = (JSON.parse(row.data || '{}').boxNo) || '';
    const match = /巡演箱-(\d+)/.exec(boxNo);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return '巡演箱-' + String(max + 1).padStart(3, '0');
}

function boxNoTaken(boxNo, exceptId) {
  const rows = db.select("SELECT id, data FROM records WHERE collection = ?;", [BOXES]);
  return rows.some((row) => row.id !== exceptId && JSON.parse(row.data || '{}').boxNo === boxNo);
}

function assertBoxStatus(box, ...allowed) {
  if (!allowed.includes(box.record.status)) {
    throw fail(
      409,
      '箱子当前状态为「' + box.record.status + '」，此操作要求状态：' + allowed.join(' / ')
    );
  }
}

function memberSnapshot(boxId) {
  const occ = db.select(
    "SELECT item_collection, item_id FROM item_occupancy WHERE box_id = ? AND state IN ('held', 'locked') ORDER BY created_at ASC;",
    [boxId]
  );
  return {
    headIds: occ.filter((o) => o.item_collection === HEADS).map((o) => o.item_id),
    accessoryIds: occ.filter((o) => o.item_collection === ACCESSORIES).map((o) => o.item_id)
  };
}

function writeBox(config, box, changes, action, actor, note) {
  const members = memberSnapshot(box.row.id);
  const data = {
    ...JSON.parse(box.row.data || '{}'),
    ...changes
  };
  const nextStatus = changes.status || box.record.status;
  // 成员清单只在草稿/封箱阶段随占用刷新；出发锁定后冻结，返场释放也不会抹掉封箱成员
  if (['草稿', '已装箱'].includes(nextStatus)) {
    data.headIds = members.headIds;
    data.accessoryIds = members.accessoryIds;
  }
  store.saveRecord(config.collections[BOXES], BOXES, box.row.id, data, nextStatus);
  store.insertEvent({
    recordId: box.row.id,
    collection: BOXES,
    action,
    status: nextStatus,
    actor,
    note,
    data: { ...changes, ...members }
  });
  box.row = store.loadRow(BOXES, box.row.id);
  box.record = store.toRecord(box.row);
}

function markPacked(entry) {
  const collection = entry.row.collection;
  const status = collection === HEADS ? HEAD_PACKED_STATUS : ACCESSORY_PACKED_STATUS;
  const record = { ...entry.record, status, currentUsable: false };
  delete record.id;
  delete record.collection;
  delete record.createdAt;
  delete record.updatedAt;
  return { record, status };
}

function packItems(config, boxId, boxNo, accepted, actor, action) {
  for (const { collection, id } of accepted) {
    const row = store.loadRow(collection, id);
    const entry = { row, record: store.toRecord(row) };
    const { record, status } = markPacked(entry);
    store.saveRecord(config.collections[collection], collection, id, record, status);
    db.run(
      "INSERT INTO item_occupancy (id, box_id, item_collection, item_id, state, created_at) VALUES (?, ?, ?, ?, 'held', ?);",
      [randomUUID(), boxId, collection, id, store.now()]
    );
    store.insertEvent({
      recordId: id,
      collection,
      action,
      status,
      actor,
      note: '已随巡演箱 ' + boxNo + ' 装箱',
      data: { tourBoxId: boxId, boxNo }
    });
  }
}

function unloadItems(config, boxId, collection, ids, actor, action, note, targetStatus) {
  for (const id of ids) {
    const row = store.loadRow(collection, id);
    const record = store.toRecord(row);
    const nextData = { ...record, status: targetStatus };
    if (collection === HEADS) nextData.currentUsable = targetStatus === HEAD_USABLE_STATUS;
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    store.saveRecord(config.collections[collection], collection, id, nextData, targetStatus);
    db.run(
      "UPDATE item_occupancy SET state = 'released', released_at = ? WHERE box_id = ? AND item_collection = ? AND item_id = ? AND state IN ('held', 'locked');",
      [store.now(), boxId, collection, id]
    );
    store.insertEvent({
      recordId: id,
      collection,
      action,
      status: targetStatus,
      actor,
      note,
      data: { tourBoxId: boxId }
    });
  }
}

// ---- 路由 ----

function createRouter(config) {
  const router = express.Router();

  // 通用写接口禁止直接打这两个集合：装箱流程必须走专用路由
  router.post('/', (req, res, next) => {
    next(fail(405, '巡演装箱单请使用 POST /api/tourBoxes/create 建箱，以便逐件核对占用关系'));
  });
  router.patch('/:id', (req, res, next) => {
    next(fail(405, '巡演装箱单的状态流转请使用 seal/depart/returnRegister/close 专用接口'));
  });
  router.post('/:id/events', (req, res, next) => {
    next(fail(405, '巡演装箱单不接受通用事件写入，请使用流程接口'));
  });

  // 建箱前预校验（不落库）
  router.post('/checkItems', (req, res, next) => {
    try {
      const headIds = uniqueList(req.body.headIds);
      const accessoryIds = uniqueList(req.body.accessoryIds);
      const { results, accepted } = checkItems(config, headIds, accessoryIds);
      res.json({
        ok: results.every((r) => r.ok),
        checkedCount: results.length,
        acceptedCount: accepted.length,
        results
      });
    } catch (error) {
      next(error);
    }
  });

  // 建立箱子：逐件核对，全部通过才成箱，占用落账
  router.post('/create', (req, res, next) => {
    try {
      const { showName, venue, play } = req.body;
      const missing = ['showName', 'venue', 'play']
        .filter((field) => req.body[field] === undefined || req.body[field] === '');
      if (missing.length) throw fail(400, 'missing required fields: ' + missing.join(', '));

      const headIds = uniqueList(req.body.headIds);
      const accessoryIds = uniqueList(req.body.accessoryIds);
      const { results, accepted } = checkItems(config, headIds, accessoryIds);
      const rejected = results.filter((r) => !r.ok);
      if (rejected.length) {
        throw fail(409, '存在不可装箱的物资，已逐件说明原因', { details: rejected });
      }

      const boxNo = req.body.boxNo || nextBoxNo();
      if (boxNoTaken(boxNo)) throw fail(409, '箱号已存在：' + boxNo);

      const actor = req.body.actor || '';
      const boxId = randomUUID();
      const status = '草稿';
      const data = {
        showName,
        venue,
        play,
        boxNo,
        headIds,
        accessoryIds,
        tourDate: req.body.tourDate || '',
        note: req.body.note || ''
      };

      db.transaction(() => {
        store.insertRecord(config.collections[BOXES], BOXES, { id: boxId, status, data });
        store.insertEvent({
          recordId: boxId,
          collection: BOXES,
          action: '建箱',
          status,
          actor,
          note: '逐件核对 ' + accepted.length + ' 件物资，全部可用',
          data: { boxNo, headIds, accessoryIds }
        });
        packItems(config, boxId, boxNo, accepted, actor, '装箱');
      });

      res.status(201).json({ box: store.loadRecord(BOXES, boxId), checked: results });
    } catch (error) {
      next(error);
    }
  });

  // 草稿加件
  router.post('/:id/items', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (!box) throw fail(404, 'not found');
      assertBoxStatus(box, '草稿');

      const headIds = uniqueList(req.body.headIds);
      const accessoryIds = uniqueList(req.body.accessoryIds);
      if (!headIds.length && !accessoryIds.length) throw fail(400, 'headIds/accessoryIds 至少提供一件');

      const existing = memberSnapshot(box.row.id);
      const skipOwn = new Set([
        ...existing.headIds.map((id) => HEADS + ':' + id),
        ...existing.accessoryIds.map((id) => ACCESSORIES + ':' + id)
      ]);
      const { results } = checkItems(config, headIds, accessoryIds, { selfBoxId: box.row.id });
      const toAdd = results
        .filter((r) => r.ok && !skipOwn.has(itemCollection(r.itemType) + ':' + r.itemId))
        .map((r) => ({ collection: itemCollection(r.itemType), id: r.itemId }));
      const rejected = results.filter((r) => !r.ok);
      if (rejected.length) throw fail(409, '部分物资不可加入', { details: rejected });

      const actor = req.body.actor || '';
      db.transaction(() => {
        packItems(config, box.row.id, box.record.boxNo, toAdd, actor, '装箱');
        writeBox(config, box, {}, '加件', actor, '加件 ' + toAdd.length + ' 件');
      });
      res.json({ box: box.record, checked: results });
    } catch (error) {
      next(error);
    }
  });

  // 草稿移除件
  router.delete('/:id/items/:itemType/:itemId', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (!box) throw fail(404, 'not found');
      assertBoxStatus(box, '草稿');
      const collection = itemCollection(req.params.itemType);
      if (!collection) throw fail(400, 'itemType 应为 puppetHead 或 accessory');

      const occ = db.selectOne(
        "SELECT * FROM item_occupancy WHERE box_id = ? AND item_collection = ? AND item_id = ? AND state = 'held';",
        [box.row.id, collection, req.params.itemId]
      );
      if (!occ) throw fail(404, '该物资不在本箱内或已不可移除');

      const actor = req.query.actor || '';
      const usableStatus = collection === HEADS ? HEAD_USABLE_STATUS : ACCESSORY_USABLE_STATUS;
      db.transaction(() => {
        unloadItems(
          config, box.row.id, collection, [req.params.itemId], actor,
          '撤出箱子', '从草稿箱 ' + box.record.boxNo + ' 撤出，恢复可用', usableStatus
        );
        writeBox(config, box, {}, '移除件', actor, '移除 1 件');
      });
      res.json({ box: box.record });
    } catch (error) {
      next(error);
    }
  });

  // 封箱核对：成员锁定前最后一次逐件对账
  router.post('/:id/seal', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (!box) throw fail(404, 'not found');
      assertBoxStatus(box, '草稿');
      const members = memberSnapshot(box.row.id);
      if (!members.headIds.length && !members.accessoryIds.length) {
        throw fail(409, '空箱不能封箱');
      }
      const actor = req.body.actor || '';
      db.transaction(() => {
        db.run(
          "UPDATE item_occupancy SET state = 'locked', locked_at = ? WHERE box_id = ? AND state = 'held';",
          [store.now(), box.row.id]
        );
        writeBox(config, box, { status: '已装箱' }, '封箱', actor, '成员核对无误，封箱待发');
      });
      res.json({ box: box.record, members });
    } catch (error) {
      next(error);
    }
  });

  // 出发：成员锁定，箱上巡演
  router.post('/:id/depart', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (!box) throw fail(404, 'not found');
      assertBoxStatus(box, '已装箱');
      const actor = req.body.actor || '';
      db.transaction(() => {
        writeBox(
          config,
          box,
          { status: '巡演中', departedAt: store.now() },
          '出发',
          actor,
          '箱子出发，成员锁定'
        );
      });
      res.json({ box: box.record });
    } catch (error) {
      next(error);
    }
  });

  // 箱子回库：进入返场清点
  router.post('/:id/return', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (!box) throw fail(404, 'not found');
      assertBoxStatus(box, '巡演中');
      const actor = req.body.actor || '';
      db.transaction(() => {
        writeBox(
          config,
          box,
          { status: '返场清点中', returnedAt: store.now() },
          '返场',
          actor,
          '箱子回库，开始按件清点'
        );
      });
      res.json({ box: box.record });
    } catch (error) {
      next(error);
    }
  });

  // 返场按件登记：完好恢复可用；缺损偶头回待修补、配件标缺损（并开缺损单）；遗失同理
  router.post('/:id/returnRegister', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (!box) throw fail(404, 'not found');
      assertBoxStatus(box, '巡演中', '返场清点中');

      const items = Array.isArray(req.body.items) ? req.body.items : [req.body].filter((b) => b && b.itemId);
      if (!items.length) throw fail(400, '请提供按件登记 items: [{ itemType, itemId, result, problem }]');

      const prepared = [];
      const seen = new Set();
      for (const item of items) {
        const collection = itemCollection(item.itemType);
        if (!collection) throw fail(400, 'itemType 应为 puppetHead 或 accessory：' + item.itemType);
        const resultKey = String(item.result || '').toLowerCase();
        const resultLabel = RETURN_RESULTS[resultKey] || item.result;
        if (!resultLabel) throw fail(400, 'result 应为 intact / damaged / lost');
        const key = collection + ':' + item.itemId;
        if (seen.has(key)) throw fail(400, '同一物资在本次登记中重复：' + item.itemId);
        seen.add(key);

        const occ = db.selectOne(
          "SELECT * FROM item_occupancy WHERE box_id = ? AND item_collection = ? AND item_id = ? AND state = 'locked';",
          [box.row.id, collection, item.itemId]
        );
        if (!occ) {
          const returned = db.selectOne(
            "SELECT * FROM item_returns WHERE box_id = ? AND item_collection = ? AND item_id = ?;",
            [box.row.id, collection, item.itemId]
          );
          if (returned) throw fail(409, '该件已登记返场，结果为「' + returned.result_label + '」，不能重复登记');
          throw fail(404, '该物资不在本箱锁定成员中：' + item.itemId);
        }
        if (resultKey !== 'intact' && !item.problem) {
          throw fail(400, resultLabel + '件必须填写 problem：' + item.itemId);
        }
        const row = store.loadRow(collection, item.itemId);
        prepared.push({ collection, item, resultKey, resultLabel, row });
      }

      const actor = req.body.actor || '';
      const createdLossIds = [];
      const registered = [];
      db.transaction(() => {
        if (box.record.status === '巡演中') {
          writeBox(config, box, { status: '返场清点中', returnedAt: store.now() }, '返场', actor, '首件返场登记，箱子进入清点');
        }

        for (const entry of prepared) {
          const { collection, item, resultKey, resultLabel, row } = entry;
          const isHead = collection === HEADS;
          let nextStatus;
          if (resultKey === 'intact') {
            nextStatus = isHead ? HEAD_USABLE_STATUS : ACCESSORY_USABLE_STATUS;
          } else if (resultKey === 'damaged') {
            nextStatus = isHead ? HEAD_REPAIR_STATUS : ACCESSORY_DAMAGED_STATUS;
          } else {
            nextStatus = isHead ? HEAD_REPAIR_STATUS : ACCESSORY_LOST_STATUS;
          }

          const record = store.toRecord(row);
          const nextData = {
            ...record,
            status: nextStatus,
            currentUsable: isHead ? nextStatus === HEAD_USABLE_STATUS : record.currentUsable
          };
          delete nextData.id;
          delete nextData.collection;
          delete nextData.createdAt;
          delete nextData.updatedAt;
          store.saveRecord(config.collections[collection], collection, item.itemId, nextData, nextStatus);

          // 释放占用
          db.run(
            "UPDATE item_occupancy SET state = 'released', released_at = ? WHERE box_id = ? AND item_collection = ? AND item_id = ? AND state = 'locked';",
            [store.now(), box.row.id, collection, item.itemId]
          );

          // 按件返场记录
          db.run(
            `INSERT INTO item_returns (id, box_id, item_collection, item_id, result_label, problem, actor, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
            [randomUUID(), box.row.id, collection, item.itemId, resultLabel, item.problem || '', actor, store.now()]
          );

          // 缺损/遗失：开缺损追踪单（事件挂在缺损单与物资双方履历上）
          if (resultKey !== 'intact') {
            const lossId = randomUUID();
            const lossData = {
              tourBoxId: box.row.id,
              boxNo: box.record.boxNo,
              itemType: isHead ? 'puppetHead' : 'accessory',
              itemId: item.itemId,
              itemName: store.titleFor(config.collections[collection], record),
              problem: item.problem,
              result: resultLabel
            };
            const lossStatus = '待处理';
            store.insertRecord(config.collections[LOSSES], LOSSES, { id: lossId, status: lossStatus, data: lossData });
            store.insertEvent({
              recordId: lossId,
              collection: LOSSES,
              action: '返场' + resultLabel + '登记',
              status: lossStatus,
              actor,
              note: '巡演箱 ' + box.record.boxNo + ' 返场发现',
              data: lossData
            });
            store.insertEvent({
              recordId: item.itemId,
              collection,
              action: '返场' + resultLabel,
              status: nextStatus,
              actor,
              note: resultLabel + (item.problem ? '：' + item.problem : '') + '（巡演箱 ' + box.record.boxNo + '，缺损单 ' + lossId + '）',
              data: { tourBoxId: box.row.id, lossReportId: lossId }
            });
            createdLossIds.push(lossId);
          } else {
            store.insertEvent({
              recordId: item.itemId,
              collection,
              action: '返场完好',
              status: nextStatus,
              actor,
              note: '巡演箱 ' + box.record.boxNo + ' 返场清点完好，恢复可用',
              data: { tourBoxId: box.row.id }
            });
          }
          registered.push({ itemType: isHead ? 'puppetHead' : 'accessory', itemId: item.itemId, result: resultLabel, nextStatus });
        }

        writeBox(config, box, {}, '返场登记', actor, '按件登记 ' + prepared.length + ' 件');
      });

      const members = memberSnapshot(box.row.id);
      const pendingCount = members.headIds.length + members.accessoryIds.length;
      const returnedRows = db.select(
        'SELECT item_collection, item_id, result_label, problem FROM item_returns WHERE box_id = ? ORDER BY created_at ASC;',
        [box.row.id]
      );
      res.json({
        box: box.record,
        registered,
        lossReportIds: createdLossIds,
        pendingCount,
        allReturned: pendingCount === 0,
        returns: returnedRows
      });
    } catch (error) {
      next(error);
    }
  });

  // 闭环：所有成员必须已按件登记
  router.post('/:id/close', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (!box) throw fail(404, 'not found');
      assertBoxStatus(box, '返场清点中');
      const members = memberSnapshot(box.row.id);
      const pendingCount = members.headIds.length + members.accessoryIds.length;
      if (pendingCount > 0) throw fail(409, '尚有 ' + pendingCount + ' 件未完成返场登记，不能闭环');
      const actor = req.body.actor || '';
      db.transaction(() => {
        writeBox(config, box, { status: '已闭环', closedAt: store.now() }, '闭环', actor, '全部成员按件清点完毕');
      });
      res.json({ box: box.record });
    } catch (error) {
      next(error);
    }
  });

  // 装箱清单（含占用状态与返场结果）
  router.get('/:id/manifest', (req, res, next) => {
    try {
      const box = loadBox(req.params.id);
      if (!box) throw fail(404, 'not found');
      const occ = db.select(
        "SELECT * FROM item_occupancy WHERE box_id = ? AND (locked_at IS NOT NULL OR state = 'held') ORDER BY created_at ASC;",
        [box.row.id]
      );
      const withdrawn = db.select(
        "SELECT item_collection, item_id, released_at FROM item_occupancy WHERE box_id = ? AND state = 'released' AND locked_at IS NULL ORDER BY released_at ASC;",
        [box.row.id]
      );
      const returns = db.select('SELECT * FROM item_returns WHERE box_id = ?;', [box.row.id]);
      const returnMap = new Map(returns.map((r) => [r.item_collection + ':' + r.item_id, r]));
      const describe = (row) => {
        const collection = row.item_collection;
        const record = store.loadRecord(collection, row.item_id);
        const ret = returnMap.get(collection + ':' + row.item_id);
        return {
          itemType: collection === HEADS ? 'puppetHead' : 'accessory',
          itemId: row.item_id,
          itemName: record ? (record.role ? record.role + ' / ' + record.play : record.name) : '',
          currentStatus: record ? record.status : null,
          occupancyState: row.state,
          lockedAt: row.locked_at,
          releasedAt: row.released_at,
          returnResult: ret ? ret.result_label : null,
          problem: ret ? ret.problem : null
        };
      };
      res.json({
        box: box.record,
        heads: occ.filter((o) => o.item_collection === HEADS).map(describe),
        accessories: occ.filter((o) => o.item_collection === ACCESSORIES).map(describe),
        withdrawnBeforeSeal: withdrawn.map((r) => ({
          itemType: r.item_collection === HEADS ? 'puppetHead' : 'accessory',
          itemId: r.item_id,
          withdrawnAt: r.released_at
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// 通用接口的写保护：偶头/配件在活跃占用中不得直接改状态或删除
function assertItemWritable(collection, id) {
  const occ = activeOccupancy(collection, id);
  if (occ) {
    const boxData = JSON.parse(occ.box_data || '{}');
    throw fail(
      409,
      '该物资正随巡演箱 ' + (boxData.boxNo || occ.box_title) + ' 在箱（' +
      (occ.state === 'locked' ? '已锁定' : '草稿占用') +
      '），请先在装箱流程中撤出或完成返场登记'
    );
  }
}

// 删除草稿箱（释放其全部占用）
function discardDraftBox(config, id, actor) {
  const box = loadBox(id);
  if (!box) throw fail(404, 'not found');
  assertBoxStatus(box, '草稿');
  const members = memberSnapshot(id);
  db.transaction(() => {
    unloadItems(config, id, HEADS, members.headIds, actor, '撤箱', '草稿箱 ' + box.record.boxNo + ' 作废，物资恢复可用', HEAD_USABLE_STATUS);
    unloadItems(config, id, ACCESSORIES, members.accessoryIds, actor, '撤箱', '草稿箱 ' + box.record.boxNo + ' 作废，物资恢复可用', ACCESSORY_USABLE_STATUS);
    db.run('DELETE FROM records WHERE collection = ? AND id = ?;', [BOXES, id]);
  });
}

module.exports = {
  HEADS,
  ACCESSORIES,
  BOXES,
  LOSSES,
  createRouter,
  assertItemWritable,
  discardDraftBox,
  activeOccupancy,
  fail
};
