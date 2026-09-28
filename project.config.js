module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['boxNo', 'showName', 'venue', 'play'],
      titleFields: ['boxNo', 'showName'],
      defaults: { headIds: [], accessoryIds: [] }
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  // 箱内物资类型 -> 物资档案集合；允许建箱时逐件核对的状态
  itemTypes: {
    puppetHeads: { label: '偶头', packableStatus: '可演出' },
    accessories: { label: '配件', packableStatus: '在库' }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-2',
      status: '可演出',
      data: {
        role: '孙悟空',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '转眼机关正常',
        accessories: ['金箍棒'],
        boxNo: '木箱甲-01',
        currentUsable: true
      },
      note: '巡演主力偶头'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-3',
      status: '可演出',
      data: {
        role: '铁扇公主',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        accessories: ['绣花披风'],
        boxNo: '木箱甲-02',
        currentUsable: true
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-2',
      status: '在库',
      data: {
        name: '绣花披风',
        role: '铁扇公主',
        play: '火焰山',
        boxNo: '配件箱-03'
      }
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes/check-items 建箱前逐件核对可用状态与占用',
    'POST /api/tourBoxes 创建巡演装箱单（自动逐件核对，占用即拒绝并报箱号）',
    'POST /api/tourBoxes/:id/depart 箱子出发，成员锁定',
    'POST /api/tourBoxes/:id/return 返场按件登记完好/缺损/遗失',
    'GET /api/puppetHeads/:id/timeline 物资履历查回全部装箱与返场事件'
  ]
};
