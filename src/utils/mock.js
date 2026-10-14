/**
 * 本地 Mock 数据源（只保留「产品内容与配置」，不含任何示例用户数据）
 *
 * 这里曾经内置过 5 只示例持仓、示例昵称 / 会员信息与分红日历事件，上线前已全部清空：
 * 用户的持仓、分红记录、资料一律来自「用户自己录入 + 行情接口 + 云端快照」，
 * 全新用户进来看到的是干净的空白状态，而不是别人的资产。
 *
 * 保留下来的都是与具体用户无关的内容：市场元数据、支出预设目录、发现页内容、
 * 排序 / 分组选项等。
 */

// 默认资料。昵称与头像在登录后按账号填入，这里只给中性默认值，不放任何示例身份信息。
// App 端是账号密码登录、不收集手机号，所以没有 phone / isPro 这类字段
// （会员档位的权威值在服务端 membership 表，不在这里）。
const user = {
  nickName: '收息佬用户',
  slogan: '让每一分红利，覆盖你的生活',
  avatar: '👤'
}

/* ---------------- 支出项（覆盖目标） ---------------- */
// sort 决定「我的支出」列表顺序，与参考图一致
const expenses = [
  { id: 'grocery', name: '买菜', icon: '🛒', amount: 2000, period: '月', sort: 1 },
  { id: 'property', name: '物业费', icon: '🏠', amount: 300, period: '月', sort: 2 },
  { id: 'fuel', name: '加油', icon: '⛽', amount: 1000, period: '月', sort: 3 },
  { id: 'phone', name: '话费', icon: '📱', amount: 100, period: '月', sort: 4 },
  { id: 'utility', name: '水电燃气', icon: '💡', amount: 400, period: '月', sort: 5 },
  { id: 'mortgage', name: '房贷/房租', icon: '🔑', amount: 8000, period: '月', sort: 6 },
  { id: 'tuition', name: '孩子学费', icon: '🏫', amount: 3000, period: '月', sort: 7 },
  { id: 'lunch', name: '午餐', icon: '🍱', amount: 1500, period: '月', sort: 8 },
  { id: 'coffee', name: '咖啡', icon: '☕', amount: 600, period: '月', sort: 9 },
  { id: 'music', name: '音乐会员', icon: '🎵', amount: 15, period: '月', sort: 10 }
]

/* ---------------- 自定义支出可选图标 ----------------
 *
 * life 覆盖「日常开销」的各个角落，按主题大致分组排布（居家 / 餐饮 / 健康 /
 * 学习娱乐 / 通讯订阅 / 人情），这样挑图标时是顺着类别扫，而不是在一堆
 * 随机 emoji 里找。数量给足是因为自定义支出的差异极大 —— 早教、宠物、
 * 健身、订阅服务都有人记，图标池太小会逼着人选一个不贴切的。
 *
 * 渲染端不截断（见 LifeExpense 的图标行），所以这里的长度直接决定可选数量。
 */
const expenseIcons = {
  life: [
    // 居家日用
    '📌', '🛏️', '🧹', '🧺', '🪑', '💡', '🧯', '🧻', '🪥', '🧽',
    // 衣帽洗护
    '👕', '👗', '👟', '🧴', '💄', '✂️', '🛁', '🚿',
    // 餐饮
    '🥢', '🍚', '☕', '🍎', '🥗', '🍼',
    // 健康
    '🏥', '💊', '🦷', '👓', '🏋️', '🧘',
    // 学习与娱乐
    '🎓', '📚', '🎨', '🎵', '🎬', '🎮', '🎲', '📺', '🧸',
    // 通讯与订阅
    '📱', '📶', '💻', '☁️',
    // 人情与其他
    '🎁', '🧧', '💐', '🐱', '🐶', '🐰', '🐟', '🌵', '🌷', '🌸', '🐝', '💰'
  ],
  travel: [
    '🚗', '🚕', '🚌', '🚇', '🚄', '🚲', '🛴',
    '✈️', '🚢', '⛽', '🅿️', '🚧', '🚏', '🛍️',
    '🗺️', '🚀', '🎫', '🏨', '🏕️', '🎡'
  ]
}

// 已选中的 8 项（年化合计 195600）
const selectedExpenseIds = [
  'phone', 'property', 'utility', 'fuel', 'lunch', 'grocery', 'tuition', 'mortgage'
]

// 覆盖状态不写死：由 utils/api.js 的 coverageSource() 按「金额从小到大依次覆盖」推导
// 成长阶段与节点：见 utils/api.js 的 STAGE_NAMES / STAGE_STEPS，按已覆盖金额占比递进
// 成长日志不写死：由 utils/api.js 的 growthLogsVM() 按覆盖进度推导

/* ---------------- 添加持仓：市场分类与可搜索股票池 ---------------- */
// 市场清单，同时是全项目市场元数据的唯一来源：
//   label 切换标签文案 / dot 标签前的圆点色 / tag + cls 持仓卡上的市场徽标
const stockMarkets = [
  { label: 'A股', key: 'A', dot: 'dot-a', tag: 'A', cls: 'tag-green' },
  { label: 'ETF', key: 'ETF', dot: 'dot-etf', tag: 'E', cls: 'tag-gold' },
  { label: '基金', key: 'FUND', dot: 'dot-fund', tag: '基', cls: 'tag-gold' },
  { label: '港股', key: 'HK', dot: 'dot-hk', tag: '港', cls: 'tag-blue' },
  { label: '美股', key: 'US', dot: 'dot-us', tag: '美', cls: 'tag-orange' }
]

// 标的池：本地已知的标的清单，只在「只拿到代码需要判断所属市场」这类辅助场景使用。
// 价格、涨跌、历史分红一律实时取自接口（utils/quote.js），本地不再保存任何行情数据。
//   dps = 近 1 年每股分红（元），仅作接口不可用时的兜底基数
const stockPool = [
  /* ---- A股 ---- */
  { code: '601398', name: '工商银行', market: 'A', dps: 0.346 },
  { code: '601288', name: '农业银行', market: 'A', dps: 0.2309 },
  { code: '601939', name: '建设银行', market: 'A', dps: 0.4 },
  { code: '600036', name: '招商银行', market: 'A', dps: 1.972 },
  { code: '601328', name: '交通银行', market: 'A', dps: 0.375 },
  { code: '601988', name: '中国银行', market: 'A', dps: 0.2364 },
  { code: '600398', name: '海澜之家', market: 'A', dps: 0.68 },
  { code: '600887', name: '伊利股份', market: 'A', dps: 1.2 },
  { code: '600519', name: '贵州茅台', market: 'A', dps: 30.876 },
  { code: '000858', name: '五粮液', market: 'A', dps: 4.67 },
  { code: '000895', name: '双汇发展', market: 'A', dps: 1.5 },
  { code: '601088', name: '中国神华', market: 'A', dps: 2.26 },
  { code: '600028', name: '中国石化', market: 'A', dps: 0.31 },
  { code: '601857', name: '中国石油', market: 'A', dps: 0.23 },
  { code: '600900', name: '长江电力', market: 'A', dps: 0.82 },
  { code: '601006', name: '大秦铁路', market: 'A', dps: 0.48 },
  { code: '600066', name: '宇通客车', market: 'A', dps: 1.5 },
  { code: '601668', name: '中国建筑', market: 'A', dps: 0.27 },

  /* ---- 港股 ---- */
  { code: '06049', name: '保利物业', market: 'HK', dps: 0.9923 },
  { code: '00506', name: '中国食品', market: 'HK', dps: 0.3279 },
  { code: '00941', name: '中国移动', market: 'HK', dps: 4.7139 },
  { code: '00700', name: '腾讯控股', market: 'HK', dps: 4.5 },
  { code: '09988', name: '阿里巴巴-W', market: 'HK', dps: 0 },
  { code: '00939', name: '建设银行', market: 'HK', dps: 0.44 },
  { code: '01398', name: '工商银行', market: 'HK', dps: 0.33 },
  { code: '03988', name: '中国银行', market: 'HK', dps: 0.24 },
  { code: '00762', name: '中国联通', market: 'HK', dps: 0.29 },
  { code: '00883', name: '中国海洋石油', market: 'HK', dps: 1.4 },
  { code: '01088', name: '中国神华', market: 'HK', dps: 2.26 },
  { code: '00386', name: '中国石油化工股份', market: 'HK', dps: 0.33 },
  { code: '01138', name: '中远海能', market: 'HK', dps: 0.35 },
  { code: '00902', name: '华能国际电力股份', market: 'HK', dps: 0.2 },

  /* ---- ETF ---- */
  { code: '510300', name: '沪深300ETF', market: 'ETF', dps: 0.085 },
  { code: '510880', name: '红利ETF', market: 'ETF', dps: 0.2 },
  { code: '515180', name: '红利ETF易方达', market: 'ETF', dps: 0.15 },
  { code: '563020', name: '红利低波ETF', market: 'ETF', dps: 0.12 },
  { code: '512880', name: '证券ETF', market: 'ETF', dps: 0.032 },
  { code: '513100', name: '纳指ETF', market: 'ETF', dps: 0 },

  /* ---- 基金 ---- */
  { code: '000756', name: '建信潜力新蓝筹股票-A', market: 'FUND', dps: 0 },
  { code: '001267', name: '宏利蓝筹价值混合', market: 'FUND', dps: 0 },
  { code: '002620', name: '中邮未来新蓝筹灵活配置混合', market: 'FUND', dps: 0 },
  { code: '000327', name: '南方潜力新蓝筹混合-A', market: 'FUND', dps: 0 },
  { code: '001162', name: '前海开源优势蓝筹股票-A', market: 'FUND', dps: 0 },
  { code: '001638', name: '前海开源优势蓝筹股票-C', market: 'FUND', dps: 0 },
  { code: '110022', name: '易方达消费行业', market: 'FUND', dps: 0 },
  { code: '161725', name: '招商中证白酒', market: 'FUND', dps: 0.15 },
  { code: '161723', name: '招商中证银行指数', market: 'FUND', dps: 0.08 },
  { code: '001594', name: '天弘中证银行ETF联接-A', market: 'FUND', dps: 0.06 },

  /* ---- 美股 ---- */
  { code: 'AAPL', name: '苹果', market: 'US', dps: 1.0 },
  { code: 'MSFT', name: '微软', market: 'US', dps: 3.0 },
  { code: 'KO', name: '可口可乐', market: 'US', dps: 1.94 },
  { code: 'JNJ', name: '强生', market: 'US', dps: 4.76 },
  { code: 'PG', name: '宝洁', market: 'US', dps: 4.03 },
  { code: 'XOM', name: '埃克森美孚', market: 'US', dps: 3.8 },
  { code: 'T', name: 'AT&T', market: 'US', dps: 1.11 },
  { code: 'VZ', name: '威瑞森', market: 'US', dps: 2.71 },
  { code: 'PEP', name: '百事可乐', market: 'US', dps: 5.42 }
]

/* ---------------- 持仓 ---------------- */
// 不再内置示例持仓：列表完全来自用户自己录入（存进云端快照 / 本地快照），
// 价格与每股派息由 utils/api.js 的 refreshHoldingQuotes 按实时接口回写。
const holdings = []

// 分红日历里待除权的预告
// ⚠️ 这两块（预告 + 下方的事件）目前没有真实数据源 —— 原先靠写死的示例事件撑着，
// 上线前已清空，因此日历页在接入真实除权除息日之前会一直是空的。
// 真实数据可以从分红档案里的 exDate / payDate 推出来（见 utils/api.js 的 getStockDetail）。
const dividendNotice = { count: 0, amount: 0 }

/* ---------------- 分红日历事件 ---------------- */
// 结构：{ 'yyyy-MM-dd': [{ code, name, type, amount }] }，type 取日历图例里的三种
const calendarEvents = {}

/* ---------------- 年度总览 ---------------- */
// months 需要按真实分红记录逐月汇总后填充，这里只提供当年年份 + 空图
const yearOverview = {
  year: new Date().getFullYear(),
  received: 0,
  months: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}

/* ---------------- 发现页 ---------------- */
const discoverTools = [
  { id: 't1', name: '复利计算器', icon: '📈', desc: '算算 10 年后', bg: 'icon-soft-green' },
  { id: 't2', name: '分红日历', icon: '📅', desc: '下一笔到账', bg: 'icon-soft-gold' },
  { id: 't3', name: '息率对比', icon: '⚖️', desc: '挑高股息', bg: 'icon-soft-orange' },
  { id: 't4', name: '定投回测', icon: '🔁', desc: '历史收益', bg: 'icon-soft-gray' }
]

const discoverRanks = [
  { id: 'r1', name: '高股息榜', desc: '按最新股价息率排序', icon: '🏆', badge: '实时更新' },
  { id: 'r2', name: '连续分红榜', desc: '连续分红年数由真实记录统计', icon: '🎖️', badge: '长期主义' },
  { id: 'r3', name: '红利指数', desc: '一篮子高息资产', icon: '🧺', badge: '组合' }
]

const discoverArticles = [
  {
    id: 'a1',
    title: '为什么说分红才是长线投资者真正的现金流',
    tag: '理念',
    read: '3 分钟',
    icon: '💡'
  },
  {
    id: 'a2',
    title: '港股分红要扣 28% 的税，还值得买吗？',
    tag: '税务',
    read: '4 分钟',
    icon: '🧾'
  },
  {
    id: 'a3',
    title: '把分红再投入，你的资产会滚多大一颗雪球',
    tag: '复利',
    read: '5 分钟',
    icon: '⛄'
  }
]

/* ---------------- 引导页示例数据 ---------------- */
// 引导流演示数据：金额一律存人民币基准数值，文案由 api 层按当前显示货币产出
const onboardingDemo = {
  slogan: '不盯股价涨跌，只关心分红到账多少钱',
  preview: {
    name: '工商银行',
    icon: '工',
    market: 'A',
    shares: 10000,
    cost: 5.12,
    yield: 6.8,
    dividend: 3460
  },
  predictCard: {
    total: 18720,
    received: 6240,
    yield: 5.8,
    nextPay: '7月15日'
  },
  litChips: ['☕ 咖啡', '📱 话费', '🎵 音乐会员'],
  unlitChips: ['🍱 午餐', '🏠 物业'],
  litCount: 3,
  chipTotal: 5,
  nextChip: '午餐',
  compound: {
    now: 18000,
    future: 180000,
    years: 10,
    multiple: 10
  },
  tip: '你的第一笔分红，可能只够买杯奶茶，但那是起点',
  planFooter: { principal: 150000, monthly: 3500, rate: 5 }
}

/* ---------------- 会员：收息佬会员 ----------------
 * 权益矩阵与额度的「单一数据源」：会员中心的对比表、各功能的门禁都读这里，
 * 调档位权限只需要改这一个文件。
 *
 * ready: false 表示该功能还没上线 —— 对比表会标注「即将上线」，
 * 避免出现「卖了会员却用不了功能」这种投诉。
 */
const membershipTiers = [
  { key: 'free', name: '免费' },
  { key: 'lite', name: 'Lite' },
  { key: 'pro', name: 'Pro' }
]

const membershipFeatures = [
  { name: '分红预测 / 日历', free: '✓', lite: '✓', pro: '✓' },
  { name: '分红到账记录', free: '✓', lite: '✓', pro: '✓' },
  { name: '交易 / 分红记录', free: '无限', lite: '无限', pro: '无限' },
  { name: '个股分红档案', free: '✓', lite: '✓', pro: '✓' },
  { name: '息愿生活 / 展望未来', free: '✓', lite: '✓', pro: '✓' },
  { name: 'A股、ETF、基金持仓', free: '≤ 3 只', lite: '无限', pro: '无限' },
  { name: '港股、美股持仓', free: '不支持', lite: '不支持', pro: '✓' },
  { name: '截图导入', free: '5次/月', lite: '5次/月', pro: '无限', ready: false },
  { name: '基金定投计划', free: '≤ 3 个', lite: '≤ 3 个', pro: '无限', ready: false },
  { name: '股票基本面', free: '5次/月', lite: '5次/月', pro: '无限', ready: false },
  { name: '账户分析', free: '不支持', lite: '不支持', pro: '✓', ready: false },
  { name: '自选盯盘', free: '≤ 5只', lite: '≤ 5只', pro: '无限', ready: false },
  { name: '多投资账户', free: '1个', lite: '1个', pro: '10个' },
  { name: '股票筛选器', free: '5次/月', lite: '5次/月', pro: '无限', ready: false, soon: true }
]

// 各档位的额度。值为 -1 表示不限
//
// ⚠️ 改这里的数字时，**必须同步改上面 membershipFeatures 里对应那行的展示文案**
// （free/lite/pro 三列是写死的字符串，不会跟着这里变）。两处不一致的后果是
// 「权益表说 ≤ 3 只、实际却拦在 6 只」——用户会认为是 bug，而排查时容易只
// 盯着其中一处看。
const membershipLimits = {
  free: {
    // 免费体验额度：3 只（曾为 6）。这是免费与付费最主要的差别，
    // 定稿时要同时确认：拦截文案、权益表、我的页的 freeText 三处口径一致。
    holdings: 3,
    overseas: false,
    accounts: 1,
    ocr: 5,
    plans: 3,
    fundamental: 5,
    watch: 5,
    analysis: false,
    screener: 5
  },
  lite: {
    holdings: -1,
    overseas: false,
    accounts: 1,
    ocr: 5,
    plans: 3,
    fundamental: 5,
    watch: 5,
    analysis: false,
    screener: 5
  },
  pro: {
    holdings: -1,
    overseas: true,
    accounts: 10,
    ocr: -1,
    plans: -1,
    fundamental: -1,
    watch: -1,
    analysis: true,
    screener: -1
  }
}

// 方案只写「时长 + 实付」两个事实值，划线价 / 省多少 / 每天多少 / 几折
// 全部由 api 层按 ORIGIN_PER_YEAR 现算 —— 手写的那几个数字很容易互相矛盾。
const membershipOriginPerYear = 138

const membershipPlans = [
  {
    key: 'lite-1m',
    tier: 'lite',
    name: 'Lite 月卡',
    months: 1,
    price: 5.5,
    badge: '轻量体验',
    note: '仅解锁无限持仓（不含港股美股）'
  },
  { key: 'pro-1y', tier: 'pro', name: 'Pro · 1年', months: 12, price: 98 },
  { key: 'pro-2y', tier: 'pro', name: 'Pro · 2年', months: 24, price: 168 },
  {
    key: 'pro-3y',
    tier: 'pro',
    name: 'Pro · 3年',
    months: 36,
    price: 198,
    badge: '热门',
    hot: true,
    tip: '每年只要 2 杯星巴克的钱，管好你一整年的分红'
  },
  {
    key: 'pro-5y',
    tier: 'pro',
    name: 'Pro · 5年',
    months: 60,
    price: 298,
    badge: '最超值',
    best: true
  }
]

const membershipNotes = ['永远没有广告', '到期后数据不丢失', '已有会员会自动顺延时长']

/* ---------------- 菜单配置 ---------------- */
const profileMenus = {
  group1: [
    // value 由 api.getProfile() 按当前档位实时回填，不写死
    { key: 'member', icon: '👑', name: '收息佬会员', value: '' },
    // value 由 api.getProfile() 按当前显示货币实时回填，不写死
    { key: 'currency', icon: '💱', name: '显示货币', value: '' },
    // value 由 api.getProfile() 回填当前登录用户名（App 端不收集手机号）
    { key: 'username', icon: '🆔', name: '登录账号', value: '' },
    { key: 'account', icon: '💼', name: '多账户管理', value: '' },
    // 已清仓标的的复盘台：卖出至今的涨跌 + 每笔决策的想法
    { key: 'archive', icon: '📦', name: '投资档案', value: '' },
    { key: 'standard', icon: '📋', name: '数据口径说明', value: '' },
    { key: 'contact', icon: '❤️', name: '联系我们', value: '' }
  ],
  group2: [
    { key: 'disclaimer', icon: '⚠️', name: '免责声明' },
    { key: 'agreement', icon: '📄', name: '用户协议' },
    { key: 'privacy', icon: '🔒', name: '隐私政策' }
  ]
}

const holdingMenus = [
  { key: 'trade', icon: '📋', name: '交易明细', desc: '支持记录买入、卖出、送股、分红复投', action: '添加' },
  { key: 'dividend', icon: '💰', name: '分红记录', desc: '累计已获分红', action: '添加' },
  { key: 'edit', icon: '⚙️', name: '编辑持仓', desc: '修改股数、成本与持股天数', action: '' },
  { key: 'file', icon: '📊', name: '分红档案', desc: '该持仓的历史分红方案与到账记录', action: '' },
  // 手动改过股数、又记过交易时用它把当前持仓定为新起点，避免重算时重复叠加
  { key: 'reseed', icon: '🎯', name: '校准持仓起点', desc: '把当前持仓当作新起点，已有交易只作流水', action: '' },
  // 与「删除」刻意分开：归档是留下记录，删除是抹掉记录
  { key: 'archive', icon: '📦', name: '清仓归档', desc: '移到投资档案，流水与当时的想法都保留', action: '' },
  { key: 'del', icon: '🗑', name: '删除持仓', desc: '删除后不可恢复', action: '', danger: true }
]

/* ---------------- 汇总指标（持仓页顶部汇总区） ---------------- */
// def: true 表示"恢复默认"时选中的 6 项
const metricCatalog = [
  { key: 'received', name: '今年已收', desc: '当年已入账分红总额', def: true },
  { key: 'cost', name: '总成本', desc: '各股买入成本 × 数量之和', def: true },
  { key: 'marketValue', name: '总市值', desc: '最新价 × 数量之和', def: true },
  { key: 'costYield', name: '成本息率', desc: '预测年分红 ÷ 总成本', def: true },
  { key: 'marketYield', name: '市值息率', desc: '预测年分红 ÷ 总市值', def: true },
  { key: 'monthly', name: '月均预测分红', desc: '预测年分红 ÷ 12', def: true },
  { key: 'daily', name: '日均预测分红', desc: '预测年分红 ÷ 365', def: false },
  { key: 'floatPnl', name: '浮动盈亏', desc: '总市值 - 总成本', def: false, tone: 'up' },
  { key: 'floatRate', name: '盈亏率', desc: '浮动盈亏 ÷ 总成本', def: false, tone: 'up' },
  { key: 'totalReceived', name: '累计收息', desc: '历史已收分红总额（不限当年）', def: false },
  { key: 'netInvest', name: '净投入', desc: '买入总额 - 卖出总额', def: false },
  { key: 'holdCount', name: '持仓只数', desc: '当前持有标的数量', def: false }
]

const METRIC_MAX = 6

/* ---------------- 我的持仓：排序 / 分组 ---------------- */
// default 保持录入顺序，与参考图一致；其余按对应数值降序
const holdingSorts = [
  { key: 'default', desc: '默认排序（录入顺序）' },
  { key: 'dividend', desc: '按预测分红：高 → 低' },
  { key: 'priceYield', desc: '按股价息率：高 → 低' },
  { key: 'costYield', desc: '按成本息率：高 → 低' },
  { key: 'marketValue', desc: '按持仓市值：高 → 低' }
]

const holdingGroups = [
  { key: 'none', desc: '不分组' },
  { key: 'yield', desc: '按息率档位：高息 / 中息 / 低息' },
  { key: 'contribution', desc: '按分红贡献：主力仓 / 次要仓 / 小额仓' },
  { key: 'position', desc: '按仓位大小：重仓 / 中仓 / 轻仓' }
]

/* ---------------- 日历图例 / 月份 ---------------- */
const calendarLegend = [
  { key: 'reg', label: '股权登记', color: 'blue' },
  { key: 'ex', label: '除权除息', color: 'orange' },
  { key: 'pay', label: '派息日', color: 'green' }
]

const yearMonths = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

/* ---------------- 币种 ---------------- */
/* rate = 「1 元人民币 = rate 个该币种」，两个方向的换算都从它推：
 *   人民币  -> 显示货币：v * rate   （api.js 的 conv，用于资产类金额展示）
 *   股票本币 -> 人民币：  v / rate   （api.js 的 cnyPerUnit / toCny，录入时统一折成人民币存）
 *
 * 注意 USD 曾经填成 7.25 —— 那是「1 美元 ≈ 7.25 元」的写法，方向正好相反，
 * 会让选美元展示时金额被放大 7 倍多，同时在按本币折算时把美元算成 1/7。
 */
const currencyOptions = [
  { code: 'CNY', name: '人民币', symbol: '¥', rate: 1 },
  { code: 'HKD', name: '港币', symbol: 'HK$', rate: 1.08 },
  { code: 'USD', name: '美元', symbol: '$', rate: 0.1379 }
]

/* ---------------- 多账户 ---------------- */
// holder 是账户归属人，用中性占位 —— 不写任何示例身份信息
const accounts = [
  { id: 'acc-main', name: '主账户', broker: 'A股 / 港股 通用', holder: '本人', active: true },
  { id: 'acc-etf', name: 'ETF 账户', broker: '场内基金专用', holder: '本人', active: false },
  { id: 'acc-kid', name: '孩子教育金', broker: '独立记账', holder: '本人', active: false }
]

/* ---------------- 我的：数据口径说明 ---------------- */
const standardRows = [
  { name: '分红口径', desc: '默认取最近 1 年的每股派息；可在添加持仓时改为近 3 年 / 近 5 年平均或手填' },
  { name: '成本口径', desc: '支持分红摊薄、摊薄成本、加权平均三种；负成本表示本金已通过卖出全部收回' },
  { name: '息率口径', desc: '成本息率 = 预测年分红 ÷ 持仓成本；股价息率 = 预测年分红 ÷ 最新市值' },
  { name: '税率处理', desc: '港股分红按 28% 预扣，A股 / ETF / 基金按 0% 计，预测分红均为税后金额' },
  { name: '行情时效', desc: '价格、涨跌与分红记录实时取自东方财富公开接口，进入页面时自动刷新' },
  { name: '分红预测', desc: '基于历史派息记录推算，不构成任何投资建议' }
]

const contactInfo = {
  title: '联系我们',
  rows: [
    { label: '邮箱', value: 'hi@xiji.app' },
    { label: '微信公众号', value: '收息佬' },
    { label: '用户反馈', value: '我的 → 联系我们 → 提交问题' },
    { label: '服务时间', value: '工作日 10:00 - 19:00' }
  ]
}

/* ---------------- 应用信息 ---------------- */
/**
 * ICP 备案号。
 * 这里之前放的是模板里的示例备案号（不是本项目的），已经清空 ——
 * 自己的小程序备案下来后填在这里（形如「浙ICP备2026xxxxxx号-1X」），
 * 「我的」页底部会自动显示；留空则整行不渲染。
 *
 * 别填别人的备案号：备案主体要和小程序主体一致，填错审核过不了。
 */
const appInfo = {
  icpNo: ''
}

/* ---------------- 我的：协议 / 隐私 / 免责声明 ---------------- */
// 三类文档共用一套结构：标题 + 段落数组
const legalDocs = {
  disclaimer: {
    title: '免责声明',
    updated: '2026-08-01',
    paras: [
      '本应用提供的所有数据、图表与预测结果，均基于公开信息与历史分红记录推算，仅供个人记账与学习参考。',
      '预测年分红不等于实际到手分红。上市公司可能调整、取消分红方案，也可能因汇率、税率变化导致到账金额与预测不一致。',
      '成本息率、股价息率等指标是数学计算结果，不代表未来收益，也不构成任何买入、卖出或持有建议。',
      '本应用为本地记账工具，不提供证券开户、交易代理、投资顾问等任何持牌服务，也不接入任何券商交易通道。',
      '因使用或依赖本应用内容而做出的任何投资决策，风险与后果由用户自行承担。'
    ]
  },
  agreement: {
    title: '用户协议',
    updated: '2026-09-16',
    paras: [
      '欢迎使用收息佬。在使用本应用前，请阅读并同意本协议的全部条款。',
      '一、服务内容。本应用提供持仓记录、分红预测、分红日历、覆盖进度统计等个人记账功能。所有数值仅作个人参考，不构成任何投资建议，据此操作的风险由你自行承担。',
      '二、账号与数据。你注册账号后，持仓、分红记录、支出偏好等数据会同步到服务器，以便换设备或重装后恢复。数据按账号隔离，其他用户无法看到。你可以在「我的 → 注销账号」中随时删除全部数据。',
      '三、使用规范。你应保证录入信息的真实性，不得利用本应用从事任何违法违规活动，不得批量抓取或转售本应用展示的行情数据。',
      '四、服务变更。我们可能对功能进行升级、调整或下线，重大变更会提前在应用内提示。',
      '五、协议更新。本协议更新后继续使用本应用，即视为接受更新后的条款。'
    ]
  },
  privacy: {
    title: '隐私政策',
    updated: '2026-09-16',
    paras: [
      '我们非常重视你的隐私。本政策说明本应用会收集什么、怎么使用，以及你如何删除。',
      '一、不采集的部分。本应用不收集手机号，也不读取通讯录、短信、相册、地理位置，不做通讯记录分析。',
      '二、登录账号。你注册时设置的用户名用于登录与区分账号；密码只保存加密后的哈希值（不可逆），我们看不到也无法还原你的明文密码。',
      '三、登录状态。登录成功后会在服务器生成一个有效期 30 天的登录凭证，保存在你的设备上用于免登录；你可以在「我的 → 退出登录」中随时让它失效。',
      '四、业务数据。你录入的持仓、分红记录、支出与设置等数据，会同步保存在我们部署于腾讯云（上海）的服务器上，用于换设备恢复与数据统计。',
      '五、行情数据。为展示实时行情与分红信息，服务端会向公开行情接口查询你所关注标的的代码，查询内容不包含你的个人信息。',
      '六、第三方。本应用不嵌入第三方广告或数据分析 SDK。',
      '七、你的权利。你可以随时在「我的 → 注销账号」中删除服务器与本机的全部数据，删除后不可恢复。'
    ]
  }
}

/* ---------------- 发现：榜单详情 ---------------- */
// 榜单的「成员」是编辑侧决定的精选清单；「数值」一律不落本地，
// 由 utils/api.js 按 codes 拉实时行情 + 真实分红记录现算：
//   metric: 'yield'    税后股价息率（%）
//   metric: 'years'    连续分红年数（年）
//   metric: 'weight'   自由流通市值加权占比（%）
const rankBoards = {
  r1: {
    id: 'r1',
    name: '高股息榜',
    icon: '🏆',
    badge: '实时更新',
    unit: '%',
    metric: 'yield',
    note: '股价息率 = 上一个完整年度的每股派息 ÷ 最新股价，港股按默认 20% 红利税折算（持仓里可逐只调整）。数值随行情实时计算。',
    codes: ['00883', '00941', '01138', '601006', '601398', '601088', '600028', '01398', '600900']
  },
  r2: {
    id: 'r2',
    name: '连续分红榜',
    icon: '🎖️',
    badge: '长期主义',
    unit: '年',
    metric: 'years',
    note: '统计样本为公司连续实施现金分红的完整会计年度数，中断一年即重新计数，按真实历史分红记录统计。',
    codes: ['600900', '601398', '601939', '601006', '601988', '601088', '600028', '00941']
  },
  r3: {
    id: 'r3',
    name: '红利指数',
    icon: '🧺',
    badge: '组合',
    unit: '%',
    metric: 'weight',
    note: '以「一篮子高息资产」的方式分散持有，按自由流通市值加权（港股按汇率折算人民币）。',
    codes: ['601398', '601088', '600028', '601006', '600900', '00941', '600036', '00883']
  }
}

/* ---------------- 发现：文章正文 ---------------- */
// body 为块数组：h=小标题，p=段落，q=引用
const articleBodies = {
  a1: {
    tag: '理念',
    read: '3 分钟',
    body: [
      { t: 'p', v: '很多人看账户只看一个数字：总市值。涨了开心，跌了焦虑，一天要打开十几次行情。' },
      {
        t: 'p',
        v: '但如果你买的是高息资产，真正决定你能不能安稳拿住的，其实是另一件事——每年有多少现金真的进了你的银行卡。'
      },
      { t: 'h', v: '股价是别人的报价，分红是公司的付账' },
      {
        t: 'p',
        v: '股价每秒钟都在变，它反映的是市场情绪、资金流向、短期预期，和你持有的公司今年赚没赚钱没有直接关系。'
      },
      {
        t: 'p',
        v: '分红不一样。它是公司从真实利润里拿出来、按持股比例打到你账户上的现金。这笔钱到账后不会因为明天股价跌了 3% 就缩水。'
      },
      { t: 'h', v: '为什么现金流更适合长线' },
      {
        t: 'p',
        v: '假设你持有的组合每年能稳定派出 6 万元分红，那么无论股价怎么波动，这 6 万元都能覆盖你一年的开销。股价跌了，你反而可以用同样的分红买到更多股数。'
      },
      { t: 'q', v: '真正让你拿不住的，从来不是下跌，而是没有现金流还要硬扛下跌。' },
      {
        t: 'p',
        v: '所以与其每天盯着总市值涨跌，不如把注意力放在两件事上：每股派息有没有稳定增长，以及你的持仓成本有没有被历年分红逐步摊薄。'
      },
      {
        t: 'p',
        v: '收息佬的「分红覆盖」就是把这两个数字翻译成一句人话——你的分红，已经能替你付掉几项生活账单。'
      }
    ]
  },
  a2: {
    tag: '税务',
    read: '4 分钟',
    body: [
      { t: 'p', v: '港股通分红的 28% 扣税，是很多人在港股和 A股 之间反复纠结的原因。这笔税到底吃掉多少收益？' },
      { t: 'h', v: '先算清楚这笔账' },
      {
        t: 'p',
        v: '假设某只港股每10股派 10 港元，你持有 10000 股，名义分红 10000 港元。按 28% 预扣后，实际到手是 7200 港元。'
      },
      {
        t: 'p',
        v: '如果同一家公司在 A股 也上市，A股 的股息红利税按持股期限计：持有满 1 年免征，1 个月至 1 年按 10%，1 个月以内按 20%。'
      },
      { t: 'h', v: 'A/H 溢价的抵消作用' },
      {
        t: 'p',
        v: '同一家公司 A股 与 H股 的价格通常不同。多数情况下 H股 相对 A股 存在折价，也就是同样的分红，港股买入成本更低。'
      },
      {
        t: 'p',
        v: '这个折价是长期存在的。只要折价幅度大于税负差距，港股在「同样的每股派息」下其实能拿到更高的实际息率。'
      },
      { t: 'q', v: '不要只看 28% 这个数字，要看你买入价的折价有没有把这 28% 赚回来。' },
      { t: 'h', v: '几个实操上的判断' },
      {
        t: 'p',
        v: '一、把「税后息率」算出来再对比，而不是拿税前息率比。收息佬的预测分红默认就是税后口径。'
      },
      { t: 'p', v: '二、A/H 同时上市且折价长期偏低的标的，优先考虑 A股，税负和汇率都更省心。' },
      { t: 'p', v: '三、港股持仓要额外算汇率波动，人民币升值会侵蚀以人民币计价的实际收益。' }
    ]
  },
  a3: {
    tag: '复利',
    read: '5 分钟',
    body: [
      { t: 'p', v: '分红有两种用法：花掉，或者再买回去。两种用法在头几年差别很小，但拉到 20 年，差距会大到不像同一笔钱。' },
      { t: 'h', v: '一个具体的例子' },
      {
        t: 'p',
        v: '初始 10 万元买入一组平均息率 6% 的资产，每月再定投 3000 元，分红全部再投入。'
      },
      { t: 'p', v: '第 1 年：分红约 6000 元，本金投入 3.6 万元。' },
      { t: 'p', v: '第 5 年：分红约 1.4 万元，累计投入 28 万元，账户市值约 34 万元。' },
      { t: 'p', v: '第 10 年：分红约 3.2 万元，累计投入 46 万元，账户市值约 72 万元。' },
      {
        t: 'p',
        v: '第 20 年：分红约 8.6 万元，累计投入 82 万元，账户市值约 210 万元。'
      },
      { t: 'h', v: '雪球是从哪一年开始变大的' },
      {
        t: 'p',
        v: '前 5 年，分红贡献只占新增资金的三分之一左右，你会觉得复利没什么用。第 8 到第 10 年，分红开始接近你每年的定投额。'
      },
      { t: 'p', v: '到第 15 年之后，分红再投入的金额会超过你的定投额——从这一刻起，滚雪球的主力就变成了雪球本身。' },
      { t: 'q', v: '复利的门槛从来不是收益率，而是你愿不愿意在前 5 年做那件看起来没什么用的事。' },
      {
        t: 'p',
        v: '这也是「分红覆盖」这个功能想表达的：先把一小项账单覆盖掉，再让覆盖的部分继续滚下去。'
      }
    ]
  }
}

/* ---------------- 发现：息率对比（工具 t3） / 定投回测候选池（工具 t4） ---------------- */
// 只保存成员代码；税后股价息率由 api 层按实时行情 + 真实分红现算
const yieldCompareCodes = [
  '00883', '00941', '01138', '601006', '601398',
  '601088', '600028', '510880', '600900', '510300'
]

/* ---------------- 复利 / 定投回测默认参数 ---------------- */
const compoundDefaults = {
  principal: 100000,
  monthly: 3000,
  rate: 6,
  years: 20,
  maxYears: 40
}

// 息率不写死：由 api.previewDca 从实时行情 + 真实分红算出
const dcaDefaults = {
  code: '601398',
  monthly: 3000,
  years: 10,
  priceGrowth: 3
}

/* ---------------- 社区 ----------------
 *
 * 一个 UGC 信息流。三种卡片形态对应三种真实内容：
 *
 *   post    用户动态 —— 头像 + 昵称 + 配图 + 短文字。社区里数量最多的一种，
 *                      门槛最低（拍张持仓截图就能发），是 UGC 的基本盘。
 *   article 长文     —— 有标题、摘要、封面，点进去是完整文章。
 *                      数量少但撑门面，也是被转发最多的一类。
 *   poll    投票     —— 一道选择题。价值不在题目本身，而在于它能把
 *                      「不想写字的沉默用户」也变成参与者 —— 一次点击即内容。
 *
 * ⚠️ 配图和头像**都没有真实素材**（assets 里只有 App 图标和底图），
 * 一律用「emoji + 浅色底」的占位块表示 —— 是刻意的占位，不是没加载出来的破图。
 * 以后接了真实上传，把 images / cover 换成 { uri } 即可，渲染那层只认字段。
 */

// 顶部话题标签条（可横滑）。挑的是「新手也敢答」的话题 ——
// 太专业的话题（比如「红利再投资复利测算」）只有老手能发，会把新人挡在门外。
const communityTopics = ['分红实录', '持仓晒单', '高股息', '新手提问', '复盘', '保险']

// 顶部主推卡。参照 App 用米黄大卡 + 一行四格入口，这里同样：
// 一句主张（本周分红日历已更新）+ 四个"点一下就有东西看"的入口。
const communityPromo = {
  title: '本周分红日历已更新',
  sub: '共 18 只标的将除息',
  entries: [
    { id: 'e1', emoji: '📅', name: '分红日历', url: '/pages/calendar/calendar' },
    { id: 'e2', emoji: '🔥', name: '高股息榜', url: '/pages/rank/rank?type=r1' },
    // 「持仓晒单」是**话题筛选**，不是跳页：点一下把信息流收窄到该话题。
    // 比跳一个空列表页有用 —— 用户想看的其实就是那几条内容。
    { id: 'e3', emoji: '🧾', name: '持仓晒单', topic: '持仓晒单' },
    // 「更多工具」兜住原来「发现」页那三个工具（复利计算器 / 息率对比 / 定投回测）。
    // 发现页只是从底部栏撤下，页面还在，从这里进 —— 否则那几个工具就成了
    // 谁也点不到的孤儿。名字没叫「发现」，因为用户找的是工具而不是那个 tab。
    // （「新手提问」不必占一格：它已经在下面的话题标签条里了。）
    { id: 'e4', emoji: '🧰', name: '更多工具', url: '/pages/discover/discover' }
  ]
}

// 打卡条。作用是给"沉默的大多数"一个不用写字也能参与的动作 ——
// 发帖的门槛往往不是"没想法"，而是"不知道写什么"，
// 所以这里直接给一句可以照着写的句子。
const communityCheckin = {
  emoji: '🙋',
  title: '记录你的第一笔分红',
  sub: '今天，8 人晒了持仓',
  hint: '拍一张持仓截图就能发，不用写长文'
}

// 顶部轮播（置顶精选）。三条轮着播，底部圆点指示。
const communitySpotlight = [
  {
    id: 's1',
    label: '本周精选',
    title: '都叫红利，为什么今年收益不同？',
    sub: '长期看都是红利风格，短期业绩差异来自行业配置',
    emoji: '🧭'
  },
  {
    id: 's2',
    label: '本周精选',
    title: '股息率 8% 的票，老手为什么反而不敢碰？',
    sub: '高股息有时是股价跌出来的，不是分出来的',
    emoji: '📉'
  },
  {
    id: 's3',
    label: '本周精选',
    title: '除息日买入，等于白拿一次分红吗？',
    sub: '不是白捡 —— 除息当天价格会同步下调',
    emoji: '🧮'
  }
]

/**
 * 信息流。date 决定它落在哪个日期分组下（分组标题由页面按 date 生成）。
 *
 * body 的结构与 Article.js 一致（块数组 { t, v }，t 为 h/p），
 * 这样二级页的正文渲染可以直接沿用同一套排版。
 */
const communityFeed = [
  {
    id: 'c1',
    kind: 'post',
    date: '2026-09-21',
    dateText: '2026.09.18',
    topic: '投资实证',
    author: { name: '孟岩', tint: '#E4EDF8' },
    reactions: [
      { emoji: '👍', n: 32 },
      { emoji: '👏', n: 16 }
    ],
    comments: 6,
    images: [
      { emoji: '📈', tint: '#E8F0F7' },
      { emoji: '📊', tint: '#F3EDE3' },
      { emoji: '🧾', tint: '#E9F0E9' },
      { emoji: '📉', tint: '#F1E9F2' }
    ],
    body: [
      { t: 'p', v: '这周的实盘记录。四张图分别是：账户净值、本月分红到账、持仓明细、以及跟沪深300的对比。' },
      { t: 'p', v: '净值这周基本没动，但收到了两笔分红，所以实际收益是正的。这就是收息策略和追涨最大的区别 —— 它不要求股价涨，只要公司还在赚钱、还愿意分。' },
      { t: 'h', v: '📌 本周三个动作' },
      { t: 'p', v: '1）把一只已经连续两年没提高分红的标的换掉了，换成了同行业分红更稳的那只；' },
      { t: 'p', v: '2）补了一点港股的高息 ETF，纯粹是为了摊一下汇率；' },
      { t: 'p', v: '3）照旧，什么都没做的那部分仓位才是收益的主要来源。' },
      { t: 'p', v: '不做，往往是这个策略里最难的部分。' }
    ]
  },
  {
    id: 'c2',
    kind: 'article',
    date: '2026-09-21',
    topic: '投资是为了更好的生活',
    author: { name: '有知有行', tint: '#F6EADA' },
    timeText: '3 天前',
    reactions: [
      { emoji: '👍', n: 118 },
      { emoji: '❤️', n: 43 }
    ],
    comments: 7,
    title: '投资这本账，除了金融资本，更有人力资本',
    excerpt:
      '我们常常觉得「变富」这件事，取决于账户里的数字。但《投资ABC》里提到一个更关键、也最容易被忽略的小点：你本人，才是最大的一笔资产。',
    cover: { emoji: '📈', tint: '#E8F0F7' },
    body: [
      { t: 'p', v: '我们常常觉得「变富」这件事，取决于账户里的数字。但《投资ABC》里提到一个更关键、也最容易被忽略的小点：你本人，才是最大的一笔资产。' },
      { t: 'h', v: '✅ 人生有两本账' },
      { t: 'p', v: '一本是金融资本：存款、股票、基金、房子。另一本是人力资本：你未来还能赚到的钱的总和。对绝大多数年轻人来说，人力资本的体量远大于金融资本。' },
      { t: 'p', v: '在最典型的生命周期里，两条曲线是交叉的：年轻时人力资本很高、金融资本很低；随着年龄增长，人力资本被「兑换」成工资，再一点点沉淀成金融资本。' },
      { t: 'h', v: '✅ 这对投资意味着什么' },
      { t: 'p', v: '第一，年轻时不必为账户里的数字焦虑。你最大的资产还没开始变现。' },
      { t: 'p', v: '第二，人力资本是「抗通胀」的 —— 它跟着你的能力和行业走，而不跟着 CPI 走。所以在积累期，把精力投向自己，回报率往往高于调仓。' },
      { t: 'p', v: '第三，也是最实际的：把两者的风险错开。人力资本越不稳定（比如收入波动大、行业周期强），金融资本就越该稳一些。' }
    ]
  },
  {
    id: 'c3',
    kind: 'poll',
    date: '2026-09-20',
    topic: '做好保险保障',
    author: { name: '有知有行', tint: '#F6EADA' },
    timeText: '4 天前',
    question:
      '小明下楼梯时摔了一跤，门牙磕断了。急诊止血拍片花了几百块，后来补牙做牙冠又花了三千。如果他买了一份小蜜蜂 6 号综合意外险，那么关于此次意外的医疗花费，下面说法正确的是？',
    options: ['拍片止血和补牙都能报', '拍片止血能报，补牙不能报', '拍片止血不能报，补牙能报', '我不知道'],
    // 每一项的票数，**加起来必须等于 voted**：界面上「X 人已选择」和各项
    // 百分比是两处独立显示，对不上就会看着像算错了。
    // 原本只有 voted 一个总数，算不出百分比（不知道分布），所以补上。
    // 目前是写死的样例，等后端有投票接口就换成真实统计。
    counts: [268, 391, 76, 263],
    voted: 998,
    comments: 1,
    body: [
      { t: 'p', v: '意外医疗的赔付范围，关键看条款里的「必需且合理」怎么界定 —— 而牙齿相关的治疗，各家产品的写法差别很大。' },
      { t: 'p', v: '投票结果和解析可以在评论区看到。选「我不知道」完全没关系，这题本来就容易想当然。' }
    ]
  },
  {
    id: 'c4',
    kind: 'article',
    date: '2026-09-20',
    topic: '盘点家庭财务',
    author: { name: '运营组张瑾', tint: '#E3F0E7' },
    timeText: '6 天前',
    reactions: [
      { emoji: '👍', n: 52 },
      { emoji: '🔥', n: 18 }
    ],
    comments: 6,
    title: '使用家庭资产记账后，不妨问问自己这几个问题',
    excerpt:
      '@运营组张瑾：分享几个常见问题，可以把它们当作检查清单，问问自己～',
    cover: { emoji: '🏠', tint: '#F3EDE3' },
    body: [
      { t: 'h', v: '✅ 我的流动资金是否充足？' },
      { t: 'p', v: '有一个「四笔钱」的框架：活钱管理、稳健理财、长期投资、保险保障。' },
      { t: 'p', v: '活钱管理是指我们为了应对生活中发生的意外情况而准备的流动资金，要满足自己随取随用的需求。一般情况下，可以预留 3～6 个月的生活开支。' },
      { t: 'h', v: '✅ 我的负债如何？' },
      { t: 'p', v: '如果你的信用贷还款利率很高，这时可以先考虑还贷。' },
      { t: 'h', v: '✅ 占比最高的资产是什么？我对它是否了解呢？' },
      { t: 'p', v: '对很多朋友来说，房产都占了大头。' },
      { t: 'p', v: '一个家庭的决策，往往不是一个人的决策。了解到的信息，也会影响我们在房产方面的判断。' },
      { t: 'h', v: '✅ 未来 1～3 年我要用的钱，是否准备好了？' },
      { t: 'p', v: '比如接下来的三年，需要准备房子的首付，或者是要准备好孩子上学的钱等等。' },
      { t: 'p', v: '把生活中的每一个目标都转化为具体的负债 —— 即在某个时间点，我应该存够多少钱，并落实到具体的财务规划上。这样当目标来临的时候，可以很自信地说：我已经准备好了。' },
      { t: 'p', v: '最后还想说的是，工具的作用，更多只是显化了当下的状态本身。我们真正的财务状况，事实上从拥有第一笔收入开始便持续不断地变化着。' }
    ],
    // id 对应 utils/toolRoutes.js 里的落点。没有它这张卡点了不会有反应 ——
    // 详情页那边就是按这个 id 去查路由表的。
    tool: { id: 'lifeExpense', emoji: '🧾', name: '家庭资产记账', desc: '点此盘点家庭资产与负债' }
  },
  {
    id: 'c5',
    kind: 'poll',
    date: '2026-09-19',
    topic: '仓位管理',
    author: { name: '收息佬运营', tint: '#FBEFE0' },
    timeText: '5 天前',
    question: '不算应急备用金，你现在的现金仓位（活钱 + 货基）大概占多少？',
    options: ['基本没有，钱都在市场里', '10% 以内', '10% ～ 30%', '30% 以上'],
    // 同上：counts 之和 = voted = 1204
    counts: [502, 361, 214, 127],
    voted: 1204,
    comments: 5,
    body: [
      { t: 'p', v: '现金仓位是最容易被低估的一个变量。它决定了市场下跌时你是「被迫卖出」还是「还能加仓」—— 这两种处境的心理压力完全不同。' },
      { t: 'p', v: '没有标准答案。但有一个自测方法：如果明天账户跌 30%，你还能睡得着、且不需要卖出任何东西吗？' }
    ]
  },
  {
    id: 'c6',
    kind: 'article',
    date: '2026-09-19',
    topic: '分红策略',
    author: { name: '老张', tint: '#E9F0E9' },
    timeText: '1 周前',
    reactions: [
      { emoji: '👍', n: 96 },
      { emoji: '🔥', n: 24 }
    ],
    comments: 12,
    title: '高股息不等于高回报：股息率里的三个陷阱',
    excerpt:
      '股息率 = 每股分红 ÷ 股价。分母变小，数字就变大 —— 所以高股息里有一半是「跌出来的」，而不是「分出来的」。',
    cover: { emoji: '📉', tint: '#F1E9F2' },
    body: [
      { t: 'p', v: '股息率 = 每股分红 ÷ 股价。这个公式里有个容易被忽略的事实：分母变小，数字就变大。所以看到一只 8% 股息率的票，第一件事不是兴奋，而是问一句：它是分得多，还是跌得多？' },
      { t: 'h', v: '陷阱一：一次性分红被当成常态' },
      { t: 'p', v: '卖掉一块资产、处置一笔股权，都能让某一年分红突然变得很好看。看股息率一定要看**连续几年**，波动大的基本可以排除。' },
      { t: 'h', v: '陷阱二：周期顶部的「高股息」' },
      { t: 'p', v: '周期股在景气顶点时利润丰厚、分红慷慨，但股价还没跌。这时候买进去，第二年利润回落，分红跟着腰斩，股价和股息一起下台阶。' },
      { t: 'h', v: '陷阱三：为了分红而分红' },
      { t: 'p', v: '有些公司把大部分利润分掉，却不留钱做研发和维持性资本开支。短期股东高兴，长期是在吃老本。分红率（分红 ÷ 净利润）持续高于 80% 的要留个心眼。' },
      { t: 'p', v: '一句话总结：真正可持续的高股息，来自「赚得到、也愿意分」的公司，而不是「跌得多」的股票。' }
    ]
  },
  {
    id: 'c7',
    kind: 'post',
    date: '2026-09-18',
    dateText: '2026.09.17',
    topic: '持仓晒单',
    author: { name: '股息猎人', tint: '#F1E9F2' },
    reactions: [
      { emoji: '👍', n: 45 },
      { emoji: '❤️', n: 12 }
    ],
    comments: 9,
    images: [
      { emoji: '🧾', tint: '#E8F0F7' },
      { emoji: '💰', tint: '#F6EADA' }
    ],
    body: [
      { t: 'p', v: '九月分红全部到账，两张图：一张是到账明细，一张是今年累计。' },
      { t: 'p', v: '今年累计收息已经超过我一个月的工资了。三年前开始的时候，一年也就两千块。' },
      { t: 'h', v: '📌 我的三条土办法' },
      { t: 'p', v: '1）不加杠杆，买了就放着，分红到账就再买同一只；' },
      { t: 'p', v: '2）一年只看两次账户，看得越多越想动手；' },
      { t: 'p', v: '3）只买自己能说清楚靠什么赚钱的公司。说不清楚就不买。' }
    ]
  },
  {
    id: 'c8',
    kind: 'article',
    date: '2026-09-18',
    topic: '新手提问',
    author: { name: '收息佬运营', tint: '#FBEFE0' },
    timeText: '1 周前',
    reactions: [{ emoji: '👍', n: 38 }],
    comments: 4,
    title: '第一只高股息该买什么？先问自己三个问题',
    excerpt:
      '与其问「买什么」，不如先问「我能承受什么」。这三个问题答完，候选池基本就自己浮出来了。',
    cover: { emoji: '🧭', tint: '#E9F0E9' },
    body: [
      { t: 'h', v: '✅ 这笔钱多久不用？' },
      { t: 'p', v: '三年内要用的钱不该进权益。收息策略靠的是时间，最短也要跨过一个完整的周期。' },
      { t: 'h', v: '✅ 我能承受多大的回撤？' },
      { t: 'p', v: '高股息不等于不跌。2024 年有几个月，高息板块也出现过 15% 以上的回撤。如果那样会睡不着，就该降低仓位而不是换标的。' },
      { t: 'h', v: '✅ 我要的是现金流，还是总回报？' },
      { t: 'p', v: '这是最关键的一问。要现金流，就盯分红和分红可持续性；要总回报，股息只是收益的一部分，还得看估值变化。目标不同，选的票完全不同。' },
      { t: 'p', v: '三个问题答完，你会发现真正的候选池往往只有几只 —— 那就够了。' }
    ]
  }
]

module.exports = {
  user,
  expenses,
  selectedExpenseIds,
  holdings,
  dividendNotice,
  calendarEvents,
  yearOverview,
  discoverTools,
  discoverRanks,
  discoverArticles,
  communityTopics,
  communityPromo,
  communityCheckin,
  communitySpotlight,
  communityFeed,
  onboardingDemo,
  profileMenus,
  // 会员
  membershipTiers,
  membershipOriginPerYear,
  membershipFeatures,
  membershipLimits,
  membershipPlans,
  membershipNotes,
  holdingMenus,
  holdingSorts,
  holdingGroups,
  calendarLegend,
  yearMonths,
  metricCatalog,
  METRIC_MAX,
  expenseIcons,
  stockMarkets,
  stockPool,
  // 我的 / 发现 / 工具
  currencyOptions,
  accounts,
  standardRows,
  contactInfo,
  legalDocs,
  appInfo,
  rankBoards,
  articleBodies,
  yieldCompareCodes,
  compoundDefaults,
  dcaDefaults
}
