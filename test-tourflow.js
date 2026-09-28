const API = 'http://localhost:3914/api';

let pass = 0;
let fail = 0;

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

function assert(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

(async () => {
  // ---- 准备物资 ----
  console.log('准备物资');
  const h1 = (await call('POST', '/puppetHeads', { role: '孙悟空', play: '火焰山', paintStatus: '完好', mechanism: '正常', boxNo: '木箱甲-01', actor: 'tester' })).json;
  const h2 = (await call('POST', '/puppetHeads', { role: '猪八戒', play: '火焰山', paintStatus: '完好', mechanism: '正常', boxNo: '木箱甲-02' })).json;
  const h3 = (await call('POST', '/puppetHeads', { role: '唐僧', play: '火焰山', paintStatus: '帽翅松脱', mechanism: '正常', boxNo: '木箱甲-03' })).json;
  // 将 h3 正式置为待修补（无占用时允许状态流转）
  await call('POST', '/puppetHeads/' + h3.id + '/events', { status: '待修补', action: '检修登记', actor: '老师傅' });
  // 待修补偶头（沿用种子 head-seed-1）
  const repairHead = (await call('GET', '/puppetHeads/head-seed-1')).json;
  const a1 = (await call('POST', '/accessories', { name: '凤翅紫金冠', role: '孙悟空', play: '火焰山', boxNo: '配件箱-01' })).json;
  const a2 = (await call('POST', '/accessories', { name: '九环锡杖', role: '唐僧', play: '火焰山', boxNo: '配件箱-01' })).json;

  // ---- 1. 建箱核对：含待修补头 -> 409 并说明原因 ----
  console.log('\n1) 建箱核对拦截');
  let r = await call('POST', '/tourBoxes/create', {
    showName: '泉州专场', venue: '泉州戏院', play: '火焰山',
    headIds: [h1.id, repairHead.id], accessoryIds: [a1.id], actor: '班主'
  });
  assert(r.status === 409, '待修补偶头被拦截', r.json);
  assert(
    r.json.details &&
    r.json.details.some((d) => d.itemId === repairHead.id && d.reason.includes('待修补')),
    '逐件说明不可用原因（待修补）', r.json.details
  );

  // 不存在的档案
  r = await call('POST', '/tourBoxes/create', {
    showName: '泉州专场', venue: '泉州戏院', play: '火焰山',
    headIds: ['nope'], accessoryIds: []
  });
  assert(r.status === 409 && r.json.details[0].reason.includes('不存在'), '不存在档案逐件报错', r.json);

  // 合法建箱
  r = await call('POST', '/tourBoxes/create', {
    showName: '泉州专场', venue: '泉州戏院', play: '火焰山',
    headIds: [h1.id, h2.id], accessoryIds: [a1.id], actor: '班主'
  });
  assert(r.status === 201, '全部可用时建箱成功', r.status);
  const box1 = r.json.box;
  assert(box1.boxNo && box1.boxNo.startsWith('巡演箱-'), '自动生成箱号 ' + box1.boxNo);
  assert(box1.headIds.length === 2 && box1.accessoryIds.length === 1, '成员写入箱单');

  // 物资状态变已装箱
  const packedHead = (await call('GET', '/puppetHeads/' + h1.id)).json;
  assert(packedHead.status === '已装箱' && packedHead.currentUsable === false, '偶头状态->已装箱/currentUsable=false');

  // ---- 2. 同时进多个箱子：第二箱直接说明所在箱号 ----
  console.log('\n2) 占用冲突报告所在箱号');
  r = await call('POST', '/tourBoxes/create', {
    showName: '厦门专场', venue: '厦门戏台', play: '火焰山',
    headIds: [h1.id], accessoryIds: [a1.id, a2.id], actor: '班主'
  });
  assert(r.status === 409, '重复装箱被整体拒绝（第二箱不建立）', r.json);
  const d1 = r.json.details.find((d) => d.itemId === h1.id);
  assert(d1 && d1.reason.includes(box1.boxNo) && d1.tourBoxId === box1.id, '说明所在箱号与箱ID', d1);
  const d2 = r.json.details.find((d) => d.itemId === a1.id);
  assert(d2 && d2.reason.includes(box1.boxNo), '配件同样报告所在箱号', d2);

  // checkItems 预检接口
  r = await call('POST', '/tourBoxes/checkItems', { headIds: [h1.id, h3.id], accessoryIds: [] });
  assert(r.status === 200 && r.json.ok === false && r.json.results.length === 2, '预检接口逐件返回', r.json);

  // ---- 3. 占用期间通用写保护 ----
  console.log('\n3) 在箱物资写保护');
  r = await call('PATCH', '/puppetHeads/' + h1.id, { paintStatus: '被乱改' });
  assert(r.status === 409 && r.json.error.includes(box1.boxNo), 'PATCH 在箱偶头被拒并报箱号', r.json);
  r = await call('DELETE', '/accessories/' + a1.id, {});
  assert(r.status === 409, 'DELETE 在箱配件被拒', r.json);
  r = await call('POST', '/tourBoxes', {});
  assert(r.status === 405, '通用 POST /tourBoxes 被引导到 create', r.json);
  r = await call('POST', '/lossReports', {});
  assert(r.status === 405, '缺损单不能手工 POST', r.json);

  // ---- 4. 草稿加件/撤件 ----
  console.log('\n4) 草稿加件撤件');
  r = await call('POST', '/tourBoxes/' + box1.id + '/items', { accessoryIds: [a2.id], actor: '小管' });
  assert(r.status === 200 && r.json.box.accessoryIds.length === 2, '草稿加件成功');
  r = await call('POST', '/tourBoxes/' + box1.id + '/items', { headIds: [h3.id] });
  assert(r.status === 409 && r.json.details[0].reason.includes('待修补'), '加件同样核对可用状态', r.json);
  r = await call('DELETE', '/tourBoxes/' + box1.id + '/items/accessory/' + a2.id + '?actor=小管');
  assert(r.status === 200 && r.json.box.accessoryIds.length === 1, '草稿撤件成功');
  const a2back = (await call('GET', '/accessories/' + a2.id)).json;
  assert(a2back.status === '在库', '撤出后配件恢复在库');

  // ---- 5. 封箱/出发/锁定后不可改成员 ----
  console.log('\n5) 封箱出发锁定');
  r = await call('POST', '/tourBoxes/' + box1.id + '/seal', { actor: '班主' });
  assert(r.status === 200 && r.json.box.status === '已装箱', '封箱');
  r = await call('POST', '/tourBoxes/' + box1.id + '/items', { accessoryIds: [a2.id] });
  assert(r.status === 409, '已封箱不能加件', r.json);
  r = await call('DELETE', '/tourBoxes/' + box1.id + '/items/puppetHead/' + h2.id);
  assert(r.status === 409, '已封箱不能撤件', r.json);
  // 重复封箱
  r = await call('POST', '/tourBoxes/' + box1.id + '/seal', {});
  assert(r.status === 409, '重复封箱拒绝', r.json);
  r = await call('POST', '/tourBoxes/' + box1.id + '/depart', { actor: '班主' });
  assert(r.status === 200 && r.json.box.status === '巡演中', '出发->巡演中（成员锁定）');
  // 此时第二箱再装 h1，应报已出发锁定
  r = await call('POST', '/tourBoxes/checkItems', { headIds: [h1.id] });
  assert(r.json.results[0].reason.includes('已出发锁定'), '锁定占用原因明确', r.json.results[0]);
  // 巡演中不能封箱/删除箱
  r = await call('DELETE', '/tourBoxes/' + box1.id);
  assert(r.status === 409, '巡演中箱子不可删除', r.json);

  // ---- 6. 返场按件登记 ----
  console.log('\n6) 返场登记');
  // 未返场前不能登记（其实可以：巡演中首件自动进入清点）
  r = await call('POST', '/tourBoxes/' + box1.id + '/returnRegister', {
    items: [{ itemType: 'puppetHead', itemId: h2.id, result: 'intact' }],
    actor: '小管'
  });
  assert(r.status === 200, '巡演中首件登记自动进入返场清点', r.json);
  assert(r.json.box.status === '返场清点中', '箱子状态->返场清点中');
  const h2back = (await call('GET', '/puppetHeads/' + h2.id)).json;
  assert(h2back.status === '可演出' && h2back.currentUsable === true, '完好偶头恢复可演出');
  assert(r.json.pendingCount === 2, '剩余待清点 2 件', r.json.pendingCount);

  // 重复登记
  r = await call('POST', '/tourBoxes/' + box1.id + '/returnRegister', {
    items: [{ itemType: 'puppetHead', itemId: h2.id, result: 'damaged', problem: 'x' }]
  });
  assert(r.status === 409 && r.json.error.includes('已登记返场'), '同件不能重复登记', r.json);

  // 缺损件必须填 problem
  r = await call('POST', '/tourBoxes/' + box1.id + '/returnRegister', {
    items: [{ itemType: 'puppetHead', itemId: h1.id, result: 'damaged' }]
  });
  assert(r.status === 400, '缺损不填原因被拒', r.json);

  // 缺损偶头 -> 待修补 + 缺损单；缺损配件 -> 缺损 + 缺损单
  r = await call('POST', '/tourBoxes/' + box1.id + '/returnRegister', {
    items: [
      { itemType: 'puppetHead', itemId: h1.id, result: 'damaged', problem: '开口机关失灵' },
      { itemType: 'accessory', itemId: a1.id, result: 'damaged', problem: '绒球脱落' }
    ],
    actor: '小管'
  });
  assert(r.status === 200, '缺损登记成功', r.json);
  assert(r.json.allReturned === true && r.json.pendingCount === 0, '全部清点完毕');
  assert(r.json.lossReportIds.length === 2, '自动开立 2 张缺损单', r.json.lossReportIds);
  const lossIdForH1 = r.json.lossReportIds[0];
  const h1damaged = (await call('GET', '/puppetHeads/' + h1.id)).json;
  assert(h1damaged.status === '待修补' && h1damaged.currentUsable === false, '缺损偶头->待修补');
  const a1damaged = (await call('GET', '/accessories/' + a1.id)).json;
  assert(a1damaged.status === '缺损', '缺损配件->缺损');

  // ---- 7. 闭环 ----
  console.log('\n7) 闭环');
  r = await call('POST', '/tourBoxes/' + box1.id + '/close', { actor: '班主' });
  assert(r.status === 200 && r.json.box.status === '已闭环', '全部登记后闭环');
  assert(
    r.json.box.headIds.length === 2 && r.json.box.accessoryIds.length === 1,
    '闭环后箱档案仍保留封箱成员清单'
  );

  // 未清点完不能闭环（再造一箱走一半）
  const r2 = await call('POST', '/tourBoxes/create', {
    showName: '漳州专场', venue: '漳州戏台', play: '火焰山',
    headIds: [h2.id], accessoryIds: [a2.id], actor: '班主'
  });
  const box2 = r2.json.box;
  await call('POST', '/tourBoxes/' + box2.id + '/seal', { actor: '班主' });
  await call('POST', '/tourBoxes/' + box2.id + '/depart', { actor: '班主' });
  await call('POST', '/tourBoxes/' + box2.id + '/return', { actor: '班主' });
  r = await call('POST', '/tourBoxes/' + box2.id + '/close', {});
  assert(r.status === 409 && r.json.error.includes('2 件'), '有未登记件时不能闭环', r.json);
  // 遗失路径
  r = await call('POST', '/tourBoxes/' + box2.id + '/returnRegister', {
    items: [
      { itemType: 'puppetHead', itemId: h2.id, result: 'intact' },
      { itemType: 'accessory', itemId: a2.id, result: 'lost', problem: '运输途中遗失' }
    ],
    actor: '小管'
  });
  assert(r.status === 200, '遗失登记成功');
  const a2lost = (await call('GET', '/accessories/' + a2.id)).json;
  assert(a2lost.status === '遗失', '遗失配件->遗失');
  r = await call('POST', '/tourBoxes/' + box2.id + '/close', { actor: '班主' });
  assert(r.status === 200 && r.json.box.status === '已闭环', '第二箱闭环');

  // ---- 8. 履历可查回 ----
  console.log('\n8) 履历可查回');
  const tl = (await call('GET', '/puppetHeads/' + h1.id + '/timeline')).json;
  const actions = tl.events.map((e) => e.action);
  assert(actions.includes('装箱'), '履历含装箱事件', actions);
  assert(actions.includes('返场缺损'), '履历含返场缺损事件', actions);
  const packEvt = tl.events.find((e) => e.action === '装箱');
  assert(packEvt.data.tourBoxId === box1.id && packEvt.note.includes(box1.boxNo), '装箱事件带箱号箱ID');
  const lossTl = (await call('GET', '/lossReports/' + lossIdForH1 + '/timeline')).json;
  assert(lossTl.events[0].note.includes(box1.boxNo), '缺损单履历可回溯到巡演箱');

  // 清单接口
  const manifest = (await call('GET', '/tourBoxes/' + box1.id + '/manifest')).json;
  assert(manifest.heads.length === 2 && manifest.accessories.length === 1, '清单含全部成员');
  const h1m = manifest.heads.find((m) => m.itemId === h1.id);
  assert(h1m.occupancyState === 'released' && h1m.returnResult === '缺损' && h1m.problem === '开口机关失灵', '清单带占用状态与返场结果', h1m);

  // ---- 9. 缺损头修好后可再装箱；闭环箱物资恢复自由 ----
  console.log('\n9) 二次流转');
  // 模拟修补完成
  r = await call('POST', '/puppetHeads/' + h1.id + '/events', { status: '修补中', action: '送修', actor: '老师傅' });
  assert(r.status === 200, '释放占用后可重新走修补状态', r.json);
  r = await call('POST', '/puppetHeads/' + h1.id + '/events', { status: '可演出', action: '修复验收', actor: '老师傅' });
  assert(r.status === 200, '修复后回到可演出');
  const r3 = await call('POST', '/tourBoxes/create', {
    showName: '福州专场', venue: '福州大戏院', play: '火焰山',
    headIds: [h1.id], accessoryIds: [], actor: '班主'
  });
  assert(r3.status === 201, '修复后的偶头可再入新箱（箱号自动递增）', r3.status);
  assert(r3.json.box.boxNo !== box1.boxNo, '新箱箱号不同: ' + r3.json.box.boxNo);

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
