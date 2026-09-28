# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

SQLite 数据库文件会在首次启动时创建到 `data/app.db`（通过纯 WASM 的 sql.js 驱动，无需本地 sqlite3）。

## 装箱—返场流程

装箱单不能再随意 POST 创建，必须走专用流程；建箱时逐件核对可用状态与占用关系：

1. `POST /api/tourBoxes/checkItems` —— 建箱前预校验（不落库），逐件返回是否可装
2. `POST /api/tourBoxes/create` —— 逐件核对后建箱（状态`草稿`，物资转`已装箱`、占用记为 held）
   - 任一件不可装则整箱不建立，响应 `details` 逐件说明原因；已在别箱的物资直接报出**所在箱号**，待修补偶头报当前状态
3. `POST /api/tourBoxes/:id/items` / `DELETE /api/tourBoxes/:id/items/:itemType/:itemId` —— 仅草稿阶段可加件/撤件，撤件恢复可用
4. `POST /api/tourBoxes/:id/seal` —— 封箱（占用 locked）
5. `POST /api/tourBoxes/:id/depart` —— 出发，状态`巡演中`，**成员锁定**，不可再加撤
6. `POST /api/tourBoxes/:id/returnRegister` —— 返场按件登记（首件自动转入`返场清点中`）：
   - `intact` 完好：偶头回`可演出`、配件回`在库`，释放占用
   - `damaged` 缺损：偶头回`待修补`、配件标`缺损`，自动开立缺损追踪单
   - `lost` 遗失：配件标`遗失`，自动开立缺损追踪单
   - 同一件只能登记一次；缺损/遗失必须填写 `problem`
7. `POST /api/tourBoxes/:id/close` —— 全部成员登记完毕才可`已闭环`
8. `GET /api/tourBoxes/:id/manifest` —— 装箱清单：当前状态、占用状态（held/locked/released）、返场结果

在箱（held 或 locked）的偶头/配件禁止通过通用 `PATCH`/`DELETE`/events 改状态或删除；缺损追踪单只能由返场登记产生；`DELETE /api/tourBoxes/:id` 仅允许作废草稿箱并释放全部占用。

## 其他常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `GET /api/lossReports`
- `GET /api/:collection/:id/timeline` —— 物资履历：创建、装箱（带箱号/箱ID）、撤出、返场完好/缺损、修复等全部变动均可查回

## 分层设计

- **占用关系**：`item_occupancy` 表（held 草稿占用 / locked 出发锁定 / released 已释放），带部分唯一索引，一件物资任意时刻至多一条活跃占用
- **状态流转**：`records.status` 只表达物资/箱子当前状态，由流程接口统一驱动
- **事件记录**：`events` 表追加不可变，箱子、物资、缺损单各自留痕；`item_returns` 表按件保存返场登记结果
- 所有多步变动在单个数据库事务内提交，失败整体回滚
