# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 三类职责如何分开承担

- **占用关系（bookings 表）**：每件物资同一时刻只允许一条 `active` 占用，由数据库部分唯一索引
  `UNIQUE(item_collection, item_id) WHERE status = 'active'` 兜底，应用层核对之外再防一次双占。
  返场后占用转为 `returned/damaged/lost`，历史永久保留。
- **状态流转（records.status）**：偶头/配件/箱子的状态只能经装箱、撤箱、封箱、出发、返场流程接口变更；
  通用 PATCH/events 接口对占用中的物资和巡演箱子有护栏，直接改状态返回 409。
- **事件记录（events 表）**：每次变动在箱子和物资两侧各写一条事件，物资履历 `timeline`
  可查回箱号、出发、返场结果、问题描述和缺损单 ID。

## 装箱与返场流程

箱子状态：`草稿 → 已装箱 → 巡演中 → 返场清点中 → 已闭环`

1. **建箱前核对（可选，只读）**
   `POST /api/tourBoxes/check-items`，body 为 `{headIds, accessoryIds}`，逐件返回
   `available/code/reason`；物资在别箱时直接给出 `boxNo`（如「偶头已装入巡演箱 巡演箱-A01」），
   待修补偶头等不可用状态给出当前状态与原因。
2. **建箱**：`POST /api/tourBoxes`（需 `boxNo, showName, venue, play, headIds, accessoryIds`）。
   服务端再次逐件核对，任一冲突整箱拒绝（事务，不会留下半箱）。
3. **调整成员**（仅 `草稿/已装箱`）：
   - 追加 `POST /api/tourBoxes/:id/items`（支持 `itemType+itemIds` 或 `headIds/accessoryIds`）
   - 撤出 `POST /api/tourBoxes/:id/remove-items`，撤出物资恢复 `可演出/在库`
4. **封箱**：`POST /api/tourBoxes/:id/seal`（草稿 → 已装箱）
5. **出发**：`POST /api/tourBoxes/:id/depart`（→ 巡演中），出发后成员锁定，增删一律 409。
6. **返场按件登记**：`POST /api/tourBoxes/:id/return`
   - `{itemType, itemId, result: "完好"}`：偶头恢复「可演出」，配件恢复「在库」
   - `result: "缺损"`（必填 `problem`）：偶头回「待修补」并 `currentUsable=false`，
     配件标「缺损」，同时生成 lossReport
   - `result: "遗失"`（必填 `problem`）：偶头「不可演出」、配件「遗失」，缺损单为「确认为遗失」
   - 部分登记时箱子进入「返场清点中」，全部清点完自动「已闭环」
7. **查看**：`GET /api/tourBoxes/:id/roster`（成员及每件返场结果/缺损单）、
   `GET /api/bookings?status=active|all`（占用关系）、`GET /api/:collection/:id/timeline`（履历）。

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/tourBoxes/check-items` 建箱前逐件核对
- `POST /api/tourBoxes` / `…/:id/seal` / `…/:id/depart` / `…/:id/return`
- `POST /api/repairRecords`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`（标准 SQLite 格式，可用任意 SQLite 工具打开）。
