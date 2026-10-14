/**
 * 数据服务层 —— 全项目唯一的数据读写入口
 *
 * 行情与分红：走 utils/quote.js 的东方财富实时接口（真实数据）。
 * 账户 / 持仓 / 内容：走 utils/mock.js + utils/store.js 的本地数据。
 * 会员门禁：档位与额度见 utils/membership.js，超限一律 fail(msg, 402) 抛出。
 * 所有方法统一返回 { code, msg, data }，页面无需关心底层是网络还是本地。
 *
 * 约定：code === 0 表示成功；其余为异常（含网络错误），统一由 util.onError 兜底。
 */
const mock = require('./mock.js')
const store = require('./store.js')
const util = require('./util.js')
const validate = require('./validate.js')
const appicon = require('./appicon.js')
const quote = require('./quote.js')
const cloud = require('./cloud.js')
const membership = require('./membership.js')
// 投票题的 id 规则（pollId）。首页卡片、详情页、以及卡片上内嵌的那道题
// 都必须用它算出同一个键，否则会出现"在首页投了、进详情却是没投过"。
const poll = require('./poll.js')

const LATENCY = 120

function clone(data) {
  if (data === undefined || data === null) return data
  return JSON.parse(JSON.stringify(data))
}

// 成功响应
function ok(data) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ code: 0, msg: 'ok', data: clone(data) })
    }, LATENCY)
  })
}

// 失败响应
function fail(msg, code) {
  return Promise.reject({ code: code === undefined ? -1 : code, msg: msg || '请求失败，请稍后重试' })
}

/* ================= 行情刷新节流 =================
 * 持仓页 / 详情页进入时刷新一次，同一次会话里 5 分钟内不重复拉。
 * 取数走 quote.fetchDetails 的批量接口，服务端另有 15s 缓存兜住并发，
 * 所以客户端不再自己攒一份按标的的缓存。
 */
const LIVE_TTL = 5 * 60 * 1000

// 除息日归属的年份；解析不出来时退回报告期里的四位年份
function exYearOf(r) {
  const m = String((r && (r.exDate || r.period)) || '').match(/(\d{4})/)
  return m ? Number(m[1]) : 0
}

// 派息归属的财年：报告期带年份就用它（A股「2025年报」、港股「2025末期」），
// 只有一串日期的（场外基金）退回除息日所在年份
function fiscalYearOf(r) {
  const m = String((r && r.period) || '').match(/(\d{4})/)
  return m ? Number(m[1]) : exYearOf(r)
}

// 年度方案：A股叫「年报」，港股叫「末期」。用来判断一个财年是不是已经派完
function isAnnualPeriod(r) {
  return /年报|年度|末期/.test(String((r && r.period) || ''))
}

/**
 * 最近一个完整财年的每股派息合计（税前），返回 { dps, year }。
 *
 * 不用「近 12 个月滚动」：滚动窗口会把今年的中期派息和上一年的年度派息叠在一起，
 * 同一家公司一年两度的节奏被打乱，息率被算高、而且每天都在变。
 *
 * 也不用「除息日所属自然年」：A股 / 港股的年度方案大多要等到下一年才除息，
 * 按自然年归集会把「上一年财年的年报」算进今年，最近一次真实派息反而被排除。
 *
 * 规则：按报告期归集到财年，取最近一个「不晚于去年、且已经出了年度方案」的财年；
 * 都还没出年度方案时，退回最近一个不晚于去年的财年；整体对不上（新股 / 刚改派息
 * 节奏）时才退回最近一期，避免口径归零。
 */
function annualDpsOf(dividend, fallback) {
  const list = (dividend && dividend.list) || []
  if (!list.length) return { dps: Number(fallback) || 0, year: 0 }

  const byYear = {}
  const annualYear = {}
  list.forEach((r) => {
    const y = fiscalYearOf(r)
    if (!y) return
    byYear[y] = (byYear[y] || 0) + r.dps
    if (isAnnualPeriod(r)) annualYear[y] = true
  })

  const lastFullYear = new Date().getFullYear() - 1
  const years = Object.keys(byYear)
    .map(Number)
    .filter((y) => y <= lastFullYear)
    .sort((a, b) => b - a)

  const complete = years.filter((y) => annualYear[y])[0]
  const hit = complete || years[0]
  if (hit) return { dps: byYear[hit], year: hit }

  return { dps: list[0].dps, year: 0 }
}

/**
 * 三种分红口径各自对应的「税前每股派息基数」。
 *
 *   近1年 = 最近一个完整财年的派息合计（沿用 annualDpsOf 的规则）
 *   近3年 = 最近 3 个完整财年合计的**均值**
 *   近5年 = 最近 5 个完整财年合计的**均值**
 *
 * 这里以前是「最近一年 × 固定系数」（1 / 0.92 / 0.85）。那个系数没有任何数据
 * 依据，方向甚至可能是反的：海澜之家近 5 年平均 0.4525 明明高于去年的 0.41，
 * 却被算成 0.41 × 0.85 = 0.3485 —— 息率凭空少了 15%，而"近5年"本该比"近1年"
 * 更平稳、不是无条件更低。
 *
 * 只统计**完整财年**（报告期年份 ≤ 去年），今年还没走完的中期派息不算进来，
 * 否则同一只标的今天一个数、明天一个数。够几个财年就用几个（新股、
 * 刚改派息节奏的标的不会因此归零）。
 */
function dpsByModeOf(dividend, fallback) {
  const annual = annualDpsOf(dividend, fallback)
  const list = (dividend && dividend.list) || []

  const byYear = {}
  list.forEach((r) => {
    const y = fiscalYearOf(r)
    if (!y) return
    byYear[y] = (byYear[y] || 0) + r.dps
  })

  const lastFullYear = new Date().getFullYear() - 1
  const years = Object.keys(byYear)
    .map(Number)
    .filter((y) => y <= lastFullYear)
    .sort((a, b) => b - a)

  const avgOf = (n) => {
    const pick = years.slice(0, n)
    if (!pick.length) return annual.dps
    return pick.reduce((s, y) => s + byYear[y], 0) / pick.length
  }

  return { m1: annual.dps, m3: avgOf(3), m5: avgOf(5) }
}

// 各口径在 dpsByModeOf 结果里对应的键（近1年 / 近3年 / 近5年 / 自定义）
const DIV_KEYS = ['m1', 'm3', 'm5', 'm1']

// 按口径索引取基数；索引越界或取不到时退回近1年
function dpsBaseFor(dividend, idx, fallback) {
  const m = dpsByModeOf(dividend, fallback)
  return Number(m[DIV_KEYS[idx] || 'm1']) || m.m1
}

// 从最新派息年份往前数，连续有派息的年数（中断一年即重新计数）
function liveYearsOf(dividend) {
  const list = (dividend && dividend.list) || []
  const seen = {}
  list.forEach((r) => {
    const y = yearOf(r)
    if (y) seen[y] = true
  })

  const years = Object.keys(seen)
    .map(Number)
    .sort((a, b) => b - a)
  if (!years.length) return 0

  let count = 1
  for (let i = 1; i < years.length; i++) {
    if (years[i] === years[i - 1] - 1) count++
    else break
  }
  return count
}

// 自由流通市值换算成人民币（港股按当前汇率折算），用于「红利指数」成分权重
function capToCny(q, market) {
  if (!q) return 0
  const cap = q.floatCap || q.marketCap || 0
  if (!cap) return 0
  // 港股给的是港元、美股给的是美元，A股 / ETF 本身就是人民币 —— 统一走折算，
  // 原先只处理了港股，美股的市值被当成人民币，权重会小到几乎看不见
  return cap * cnyPerUnitLive(market)
}

/**
 * 榜单 / 息率对比 / 定投回测共用的「实时息率项」。
 * 数值全部现算，本地只保留成员名单。
 */
function liveYieldItem(stock, entry) {
  const q = entry && entry.quote
  const market = (stock && stock.market) || (entry && entry.market) || 'A'
  const inPool = findStock(stock && stock.code)
  const price = q && q.price > 0 ? q.price : 0
  const dps = annualDpsOf(entry && entry.dividend, inPool ? inPool.dps : 0).dps
  // 榜单 / 息率对比没有「逐只配置」的入口，统一用该市场默认税率
  const taxRate = defaultTaxRateOf(market)
  const value = price > 0 && dps > 0 ? (netDpsOf(dps, taxRate) / price) * 100 : 0

  return {
    code: String((stock && stock.code) || '').toUpperCase(),
    name: (q && q.name) || (inPool ? inPool.name : '') || String(stock && stock.code),
    market,
    price,
    dps,
    taxRate,
    value,
    years: liveYearsOf(entry && entry.dividend),
    capCny: capToCny(q, market),
    live: !!q && price > 0
  }
}

// 按成员名单拉齐实时数据：走批量接口，一次请求拿齐十几只标的
function buildLiveList(codes) {
  const list = (codes || []).map((code) => ({ code, market: guessMarket(code) }))
  if (!list.length) return Promise.resolve([])

  return quote
    .fetchDetails(list)
    .catch(() => ({}))
    .then((map) =>
      // 保持入参顺序与长度：没拿到行情的标的由 liveYieldItem 自己兜底成 value 0
      list.map((s) => liveYieldItem(s, map[quote.batchKey(s)] || {}))
    )
}

/* ================= 显示货币 =================
 * 基准数据（mock / storage）始终按人民币存储，页面金额文案一律由下面这组
 * 函数产出：按当前显示货币的 rate 换算后带上符号。
 * 这样「我的 → 显示货币」改一次，全 App 的金额同步换汇，页面无需各自处理。
 */
function conv(n) {
  const v = Number(n) || 0
  const cur = readCurrency()
  // 人民币不用换算
  if (cur.code === 'CNY') return v
  // 显示货币之间也走**实时汇率**：记账 rate 的口径是「1 元 = rate 个该币种」，
  // 而实时那边拿到的是「1 单位外币 = 多少人民币」，取倒数即可。
  // 拿不到实时汇率时才退回记账 rate（此时至少口径自洽，不会忽大忽小）。
  const live = fxLive && Number(fxLive[cur.code])
  return live > 0 ? v / live : v * cur.rate
}

function curSymbol() {
  return readCurrency().symbol
}

// 千分位金额（d 为小数位）
function moneyText(n, d) {
  return curSymbol() + util.group(conv(n), d)
}

/**
 * 带正负号的金额（浮动盈亏用）：+¥1,234.56 / -¥1,234.56 / ¥0.00。
 *
 * 不复用 moneyText 直接传负数：那样负号会夹在货币符号后面（¥-1,234.56），
 * 做涨跌展示时读起来别扭。
 */
function signedMoneyText(n, d) {
  const v = Number(n) || 0
  const sign = v > 0 ? '+' : v < 0 ? '-' : ''
  return sign + moneyText(Math.abs(v), d)
}

// 带正负号的百分比：+20.55% / -8.30%
function signedPctText(n, d) {
  const v = Number(n) || 0
  const sign = v > 0 ? '+' : v < 0 ? '-' : ''
  return sign + util.money(Math.abs(v), d === undefined ? 2 : d) + '%'
}

// 固定小数金额
function fixedText(n, d) {
  return curSymbol() + util.money(conv(n), d)
}

// ≥1万自动折「万」，否则完整千分位
function amountText(n) {
  return curSymbol() + util.amount(conv(n))
}

// 概览用的「数字 + 万」文案（引导流 / 蓝图），带当前货币符号
function wanText(n) {
  return curSymbol() + util.wan(conv(n), 2)
}

/* ================= 通用视图模型 ================= */

// 市场元数据统一从 mock.stockMarkets 派生，标签与配色都不在多处硬编码
const MARKET = {}
const MARKET_LABEL = {}
// 持仓详情页副标题用的长文案
const MARKET_LONG_LABEL = {
  A: '人民币资产',
  HK: '港澳资产',
  ETF: '境内基金',
  FUND: '境内基金',
  US: '美元资产'
}

mock.stockMarkets.forEach((m) => {
  MARKET[m.key] = { tag: m.tag, cls: m.cls }
  MARKET_LABEL[m.key] = m.label
})

function marketOf(m) {
  return MARKET[m] || MARKET.US
}

// 各市场的本币：港股按港币、美股按美元、A股按人民币。
// 股票的价格与每股股息天然是「本币」计价（行情接口给的就是本币），
// 而资产类金额统一按人民币存储 —— 两者的折算全部走下面这组函数，
// 不要在页面上临时乘汇率。
function nativeCurrency(market) {
  const code = market === 'HK' ? 'HKD' : market === 'US' ? 'USD' : 'CNY'
  return mock.currencyOptions.filter((c) => c.code === code)[0] || mock.currencyOptions[0]
}

// 1 单位本币 = 多少人民币。currencyOptions 的 rate 是「1 元 = rate 个该币种」，
// 所以取倒数：港币 ≈ 0.926 元、美元 ≈ 7.25 元。
function cnyPerUnit(market) {
  const c = nativeCurrency(market)
  return c && c.rate ? 1 / c.rate : 1
}

// 本币金额 -> 人民币（录入时统一折成人民币存）
function toCny(v, market) {
  return (Number(v) || 0) * cnyPerUnit(market)
}

// 人民币 -> 本币金额（按本币展示、编辑面板回显时用）
function fromCny(v, market) {
  const r = cnyPerUnit(market)
  return r ? (Number(v) || 0) / r : Number(v) || 0
}

// 本币符号与名称：港币 HK$、美元 $、人民币 ¥
function nativeSymbol(market) {
  return nativeCurrency(market).symbol
}

function nativeName(market) {
  return nativeCurrency(market).name
}

/**
 * 给一个**已经是本币**的数值加上本币符号。
 *
 * 标的自身的报价（最新价、每股股息、每股成本）一律按本币展示：这些数字是
 * 「这只股票在它自己市场里的价格」，换成别的币种会和行情软件、券商 App 对不上，
 * 用户也没法照着填。资产类金额（市值 / 分红总额 / 净投入）走 moneyText，按显示货币来。
 *
 * 注意传进来的必须已经是本币 —— 接口原值和 nativeOf() 取出的本币原值都满足；
 * 再折一遍等于把汇率平方。
 */
function nativeRawText(v, market, d) {
  return nativeSymbol(market) + util.money(Number(v) || 0, d)
}

/**
 * 取某个字段的**本币原值**。
 *
 * 录入与刷新行情时，本币原值会跟着人民币值一起存下来（costNative / priceNative…），
 * 展示直接读它。不再从人民币反算，是因为反算要再乘一次记账汇率的倒数：
 * 来回两道既有舍入误差，又把「本币值」这个事实绑死在那个发版即固定的汇率上。
 *
 * 老数据没有这个字段，回落到 fromCny() —— 与改造前逐位相同，不会更差；
 * 下次编辑或刷新行情时它会自动补上。
 */
function nativeOf(row, key, market) {
  if (!row) return 0
  const v = row[key + 'Native']
  if (v === undefined || v === null || v === '') {
    return fromCny(row[key], market || row.market)
  }
  return Number(v) || 0
}

// 本币原值 + 本币符号（展示用）
function nativeOfText(row, key, market, d) {
  const m = market || (row && row.market)
  return nativeRawText(nativeOf(row, key, m), m, d)
}

/* ---------------- 实时汇率 ----------------
 * 快照里的本币金额是按「记账汇率」折成人民币存的 —— 也就是 mock.currencyOptions
 * 里那两个常量（HKD 1.08 / USD 0.1379），发版后就固定不动。它是
 * 「存储值 ⇄ 本币值」的固定桥梁：一旦改它，港币价格显示会跟着漂
 * （存的是按旧汇率折出来的数，用新汇率还原就对不上了）。
 *
 * 所以汇率更新**不动它**，只在外面乘一个重估系数：
 *   重估系数 = 实时汇率 ÷ 记账汇率
 * 市值、预测年分红这类「当下与未来的价值」乘上它 → 按最新汇率看；
 * 历史投入（成本）和实际到账（已收分红）不乘 → 它们本来就是当时的人民币。
 * 息率是同一币种相除，系数约掉，天然不受汇率影响。
 */
const FX_KEY = 'fxRates'

// 内存里那份实时汇率：启动时从 storage 恢复，联网后再刷新
let fxLive = null

// 1 单位本币 = 多少人民币（实时）；拿不到时返回 null，由调用方退回记账汇率
function liveCnyPerUnit(market) {
  const code = market === 'HK' ? 'HKD' : market === 'US' ? 'USD' : 'CNY'
  if (code === 'CNY') return 1
  const v = fxLive && Number(fxLive[code])
  return v > 0 ? v : null
}

/**
 * 折算用的汇率：1 单位本币 = 多少人民币。
 *
 * 优先实时，拿不到时退回记账汇率 —— 离线或汇率接口挂掉时，
 * 数字可能会有几个点的偏差，但不会出现数量级错误。
 */
function cnyPerUnitLive(market) {
  const live = liveCnyPerUnit(market)
  return live > 0 ? live : cnyPerUnit(market)
}

// 拉一次实时汇率；失败保持现状（继续用上次的缓存或记账汇率）
function refreshFx() {
  return quote
    .fetchFx()
    .then((rates) => {
      fxLive = rates
      wx.setStorageSync(FX_KEY, { at: Date.now(), rates: rates })
      return rates
    })
    .catch(() => null)
}

function restoreFx() {
  const saved = wx.getStorageSync(FX_KEY)
  if (saved && saved.rates) fxLive = saved.rates
  return fxLive
}

// store 是纯计算层，不该反过来依赖 api，所以把汇率以注入的方式给它。
// 注入的是「1 单位本币 = 多少人民币」—— store 用它把本币原值折成人民币，
// 每次 decorate 都现算，所以汇率一变，市值立刻跟着变，而录进去的数字不动。
if (typeof store.setFxProvider === 'function') store.setFxProvider(cnyPerUnitLive)

/**
 * 历史数据口径修正。
 *
 * 【最终口径】快照里**只存本币原值**：港股填 3.44 就存 3.44，美股填 25.8 就存 25.8。
 * 人民币金额不落库，由 store.decorate 按当时汇率现算。这样汇率怎么动，
 * 「录入的数字」永远是事实，人民币只是它的一个视图。
 *
 * 这一路改过四版，每版修的是上一版暴露出来的问题，读的时候容易绕，所以列清楚：
 *
 *   v1  最初录入侧不区分币种：行情 / 分红接口给的是本币，系统当人民币直接用，
 *       于是港股市值差约 7%、美股差约 7 倍。这一版把接口来的本币字段折成人民币。
 *
 *   v2  修 v1 折过头的两处 —— 它们本来就不是本币：
 *         · 自定义标的没有行情源，price 是拿成本推出来的，语义随成本；
 *         · 分红口径选「自定义」时，dps 是用户照界面提示手填的。
 *       这两类按 v1 的结果继续用，股价息率会整整差一个汇率。
 *
 *   v3  引入 xxxNative（本币原值），值由修正后的人民币反算。
 *       问题就出在这里：它对 **cost** 也做了同样的反算，但 cost 从来没被
 *       v1/v2 折过 —— 它里面一直是用户录入的**本币**数字。于是 3.44 被
 *       当成人民币再除一次记账汇率，显示成 3.72。用户看到的就是
 *       「我明明填了 3.44，它自己变成了别的数」。
 *
 *   v4（本版）统一到「只存本币」：
 *         · cost —— 旧值本就是本币，原样留下（这就是纠正 v3 的那一步）；
 *         · price / dps / baseDps —— v1/v2 折过，这里折回本币；
 *         · received —— 一直按人民币累加，折回本币；
 *         · fee / seedCost —— 同样折回本币，让种子基准跟着汇率一起动。
 *       迁移完成后，所有 xxx 与 xxxNative 同为本币，读取路径不再分情况。
 *
 * 版本标记存在 storage 且纳入 SETTING_KEYS（跟着账号上云）：
 * 只放本地的话，App 与小程序会各折一次，等于把汇率平方。
 */
const NATIVE_FIX_KEY = 'nativeCurrencyFix'
const NATIVE_FIX_VERSION = 6

// 已有的本币原值优先（新数据、以及 v3 对 price/dps 算对的那部分都要保留），
// 缺失时才用反算兜底
function useOr(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  return isNaN(n) ? fallback : n
}

function migrateNativeCurrency() {
  const done = Number(wx.getStorageSync(NATIVE_FIX_KEY)) || 0
  if (done >= NATIVE_FIX_VERSION) return 0

  let n = 0
  const next = store.allRows().map((h) => {
    const market = (h && h.market) || 'A'
    const cny = cnyPerUnit(market)

    // 先把 v1/v2 的修正复现出来，让 price / dps / baseDps 落在
    // 「改造后的人民币口径」这个已知状态上（done 为 0 或 1 时的处理不同）
    let price = h.price
    let dps = h.dps
    let baseDps = h.baseDps

    // 只涉及港股与美股 —— A股 / ETF / 场外基金的本币就是人民币，折算是恒等。
    // 而且只在 done < 2 时做：跑到 v3 之后的数据里 price/dps 已经是人民币了，
    // 再折一次会把数字推得更远（这条迁移会重跑，必须保证幂等）。
    if (cny !== 1 && done < 2) {
      // 没有行情时 price 是「按录入成本估算」来的，和成本同币种（人民币）
      const noQuote = h.priceDate === '按录入成本估算'
      // 分红口径「自定义」时 dps 是用户手填的，按界面提示是人民币
      const customDiv = h.divMode === '自定义'

      if (done < 1) {
        if (!noQuote) price = (Number(h.price) || 0) * cny
        if (!customDiv) dps = (Number(h.dps) || 0) * cny
        baseDps = (Number(h.baseDps) || 0) * cny
      } else {
        if (noQuote) price = (Number(h.price) || 0) / cny
        if (customDiv) dps = (Number(h.dps) || 0) / cny
      }
    }

    // 上面三个此刻都是人民币口径，折回本币（优先沿用已有的原值）
    const priceNative = useOr(h.priceNative, fromCny(price, market))
    const dpsNative = useOr(h.dpsNative, fromCny(dps, market))
    const baseDpsNative = useOr(h.baseDpsNative, fromCny(baseDps, market))

    // cost 从来没有被折过：它里面就是用户当初录入的本币数字，直接用它。
    // （v3 把它当人民币除了一次汇率，是本次要纠正的错误。）
    const costNative = Number(h.cost) || 0

    // received 的口径要分三种情况，因为它是最容易折错的一个字段：
    //   · 有 receivedNative —— 已经迁移过，直接用它（幂等）
    //   · done === 4 —— 那一版把 received 折成了本币却没留下 receivedNative，
    //     所以现在读到的是「本币 ÷ 记账汇率」，要乘回去而不是再除一次
    //   · 其余 —— 还是人民币口径，正常折回本币
    let receivedNative
    if (h.receivedNative !== undefined && h.receivedNative !== null && h.receivedNative !== '') {
      receivedNative = Number(h.receivedNative) || 0
    } else if (done === 4) {
      receivedNative = (Number(h.received) || 0) * cny
    } else {
      receivedNative = fromCny(h.received, market)
    }

    // fee 同样是人民币口径（addHolding 里存的是 feeNative × cny）
    const feeNative = useOr(h.feeNative, fromCny(h.fee, market))

    const withNative = Object.assign({}, h, {
      // 迁移后 xxx 与 xxxNative 同为本币，读取路径统一
      cost: costNative,
      costNative: costNative,
      price: priceNative,
      priceNative: priceNative,
      dps: dpsNative,
      dpsNative: dpsNative,
      baseDps: baseDpsNative,
      baseDpsNative: baseDpsNative,
      fee: feeNative,
      feeNative: feeNative,
      received: receivedNative,
      receivedNative: receivedNative
    })

    // 建仓基准：seedCost 冻结时取的就是用户录入值（本币），直接用；
    // v3 补的 seedCostNative 是反算来的，一并纠正
    if (h.seedShares !== undefined && h.seedShares !== null) {
      const seedCost = Number(h.seedCost) || 0
      withNative.seedCost = seedCost
      withNative.seedCostNative = seedCost
    }

    n++
    return withNative
  })

  // 先落标记再提交：即便这次上云失败，dirty 还留着，下次启动会重试推上去
  wx.setStorageSync(NATIVE_FIX_KEY, NATIVE_FIX_VERSION)
  // 一条持仓都没有时也要写标记，否则每次启动都会白跑一遍
  if (n) store.replaceHoldings(next)

  // 交易 / 分红明细也必须一起回到本币口径 —— 它们和持仓是同一份数据的两面。
  // 只改持仓的话，明细里的成交价还是旧的人民币折算值，一加权进成本就又串味了。
  const marketOf = {}
  store.allRows().forEach((h) => {
    if (h && h.id) marketOf[h.id] = h.market || 'A'
  })

  const recs = readRecords()
  let rn = 0
  Object.keys(recs).forEach((hid) => {
    const market = marketOf[hid] || 'A'
    if (cnyPerUnit(market) === 1) return // 人民币市场折算恒等，不用动

    const bucket = recs[hid] || {}
    ;['trade', 'dividend'].forEach((kind) => {
      const list = bucket[kind]
      if (!list || !list.length) return

      bucket[kind] = list.map((r) => {
        const t = Object.assign({}, r)
        if (kind === 'trade') {
          t.price = useOr(t.priceNative, fromCny(t.price, market))
          t.priceNative = t.price
          t.fee = useOr(t.feeNative, fromCny(t.fee, market))
          t.feeNative = t.fee
        } else {
          t.amount = useOr(t.amountNative, fromCny(t.amount, market))
          t.amountNative = t.amount
          t.dps = useOr(t.dpsNative, fromCny(t.dps, market))
          t.dpsNative = t.dps
          t.tax = useOr(t.taxNative, fromCny(t.tax, market))
          t.taxNative = t.tax
        }
        rn++
        return t
      })
    })
  })
  if (rn) writeRecords(recs)

  // 最后一步：让摊薄成本按新口径重算一遍。
  //
  // 为什么非做不可：迁移只改了「原始字段」（成本、成交价、手续费…），
  // 但页面上看到的每股成本是 positionOf 从「建仓基准 + 全部交易」算出来的，
  // 它上一次运行是在旧口径的数据上 —— 不重算的话，明细已经对了，
  // 汇总出来的成本却还是老数字，两边对不上。
  if (n || rn) {
    store.allRows().forEach((h) => {
      const trades = ((recs[h.id] || {}).trade) || []
      if (!trades.length) return
      const cur = store.getHolding(h.id)
      if (cur) applyTradesToHolding(cur, trades)
    })
  }

  return n + rn
}

// 单只持仓 -> 视图模型
function holdingVM(h) {
  const d = store.decorate(h)
  const mi = marketOf(d.market)
  const cur = readCurrency()
  const native = nativeCurrency(d.market)
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    icon: d.name.substring(0, 1),
    market: d.market,
    marketLabel: d.marketLabel,
    marketTag: mi.tag,
    tagClass: mi.cls,
    shares: d.shares,
    sharesText: d.shares + '股',
    // 录入侧字段：编辑面板要回显
    buyDate: d.buyDate || '',
    fee: d.fee || 0,
    // 编辑面板按本币回显（手续费当初也是按本币录的）
    feeNative: nativeOf(d, 'fee'),
    costMode: d.costMode || '',
    divMode: d.divMode || '',
    negativeCost: !!d.negativeCost,
    custom: !!d.custom,
    // 每股股息、最新价、每股成本都是「这只股票自己的价格」，一律按本币展示
    // （和数据来源、券商对账单一致，用户也照着它填）；资产类金额才走显示货币
    dps: d.dps,
    dpsText: nativeOfText(d, 'dps', d.market, 4),
    price: d.price,
    priceText: nativeOfText(d, 'price', d.market, 2),
    priceDateText: d.priceDate,
    cost: d.cost,
    // 编辑面板按本币回显：用户当初按本币填，再打开就该看到本币
    costNative: nativeOf(d, 'cost'),
    costText: nativeOfText(d, 'cost', d.market, 4),
    dividend: d.dividend,
    dividendText: moneyText(d.dividend, 2),
    marketValue: d.marketValue,
    // 市值 ≥ 1万 时自动折算成「数字 + 万」
    marketValueText: amountText(d.marketValue),
    costValue: d.costValue,
    // 浮动盈亏 = 现市值 − 持仓成本（不含已收分红，那部分另有回本进度）。
    // 金额与比例都带正负号；up / down 供页面着色，两者都 false 即持平（走灰）
    floatProfit: d.floatProfit,
    floatProfitText: signedMoneyText(d.floatProfit, 2),
    floatProfitPctText: signedPctText(d.floatProfitPct, 2),
    floatProfitUp: d.floatProfit > 0,
    floatProfitDown: d.floatProfit < 0,
    costYieldText: util.money(d.costYield, 2) + '%',
    priceYieldText: util.money(d.priceYield, 2) + '%',
    // 持股天数按买入日现算：存下来的那个值只是录入当时的快照，放着不动会越来越旧。
    //
    // ⚠️ 这里返工过：原来只看 d.buyDate，老数据（快照里没这个字段）会回落到
    // 建仓时存死的 holdingDays —— 而那个值本身就是错的（见 daysSince 的说明，
    // 空日期当时会被算成 1）。现在走 holdingStartDate 逐级兜底，
    // 最后一项「最早一笔交易」能把没有 buyDate 的老持仓救回来。
    //
    // 0 表示真的一个日期都没有，页面显示「—」。
    holdingDays: daysSince(holdingStartDate(d)),
    received: d.received,
    receivedText: moneyText(d.received, 2),
    // 老数据没存过税率时按该市场默认值回显，保证编辑面板能选中
    taxRate:
      d.taxRate === undefined || d.taxRate === null || d.taxRate === ''
        ? defaultTaxRateOf(d.market)
        : d.taxRate,
    taxOn: d.taxOn !== false,
    netInvestText: moneyText(d.netInvest, 2),
    remainingText: moneyText(d.remaining, 2),
    paybackYearsText: util.money(d.paybackYears, 1),
    paybackProgress: d.paybackProgress,
    // 显示货币与本币不一致时才提示「换成港币看」
    currencyName: cur.name,
    nativeCurrencyName: native.name,
    showCurrencyTip: native.code !== cur.code
  }
}

// 持仓总览 -> 视图模型
function summaryVM() {
  const s = store.summary()
  // 20 年推演由成本息率实时算出，不再是写死的倍数
  const proj = returnProjection(s.costYield)
  return {
    count: s.count,
    dividend: s.dividend,
    dividendText: moneyText(s.dividend, 2),
    receivedText: moneyText(s.received, 2),
    costText: curSymbol() + util.wan(conv(s.costValue), 2),
    marketText: curSymbol() + util.wan(conv(s.marketValue), 2),
    costYieldText: util.money(s.costYield, 2) + '%',
    marketYieldText: util.money(s.marketYield, 2) + '%',
    monthlyText: moneyText(s.monthly, 2),
    multipleText: proj.multipleText,
    projection: proj,
    holdDays: s.holdDays
  }
}

/* ================= 汇总指标设置 ================= */

const METRIC_STORE_KEY = 'holdingMetrics'

function defaultMetricKeys() {
  return mock.metricCatalog.filter((m) => m.def).map((m) => m.key)
}

// 已保存的选择，未设置过则用默认 6 项
function readMetricKeys() {
  const saved = wx.getStorageSync(METRIC_STORE_KEY)
  if (saved && saved instanceof Array) return saved.slice()
  return defaultMetricKeys()
}

// 每项指标的展示值
function metricValueMap() {
  const s = store.summary()
  // 金额一律走显示货币：正负号由换算后的值决定，符号与数值都带在文案里
  const signed = (n) => {
    const v = conv(n)
    return (v >= 0 ? '+' : '-') + curSymbol() + util.group(Math.abs(v), 2)
  }
  const signedPct = (n) => (n >= 0 ? '+' : '-') + util.money(Math.abs(n), 2) + '%'
  return {
    received: moneyText(s.received, 2),
    cost: curSymbol() + util.wan(conv(s.costValue), 2),
    marketValue: curSymbol() + util.wan(conv(s.marketValue), 2),
    costYield: util.money(s.costYield, 2) + '%',
    marketYield: util.money(s.marketYield, 2) + '%',
    monthly: moneyText(s.monthly, 2),
    daily: moneyText(s.daily, 2),
    floatPnl: signed(s.floatPnl),
    floatRate: signedPct(s.floatRate),
    totalReceived: moneyText(s.totalReceived, 2),
    netInvest: curSymbol() + util.wan(conv(s.netInvest), 2),
    holdCount: s.count + ' 只'
  }
}

/**
 * 指标值的涨跌配色。
 *
 * mock.metricCatalog 里给 floatPnl / floatRate 标了 tone:'up'，那原本只是个
 * **"这项需要按涨跌着色"的标记**，但页面把它当成"固定用涨色"来用了 ——
 * 于是顶部汇总的浮动盈亏无论赚还是亏都是同一个橙色（metricUp = #E0892C），
 * 而下面卡片里同一个数字却是红涨绿跌，两处对不上。
 *
 * 这里按**实际正负**给出方向，与卡片上的 profitToneOf 保持同一套语义：
 * 盈利红、亏损绿、持平不着色（走默认白）。国内行情软件的约定。
 */
function metricToneOf(key) {
  if (key !== 'floatPnl' && key !== 'floatRate') return ''
  const v = Number(store.summary()[key]) || 0
  if (v > 0) return 'up'
  if (v < 0) return 'down'
  return ''
}

function toMetricVM(keys, onlySelected) {
  const values = metricValueMap()
  return mock.metricCatalog
    .filter((m) => (keys.indexOf(m.key) > -1) === onlySelected)
    .map((m) => ({
      key: m.key,
      name: m.name,
      desc: m.desc,
      value: values[m.key],
      tone: metricToneOf(m.key)
    }))
}

// 纯计算、无 IO，故设计为同步方法，保证开关指标时无延迟
function buildMetricLists(keys) {
  const k = keys || []
  return {
    selectedKeys: k.slice(),
    selectedMetrics: toMetricVM(k, true),
    optionalMetrics: toMetricVM(k, false)
  }
}

/**
 * 覆盖清单数据源：以「生活支出设置」里可编辑的清单为唯一真源，
 * 按年支出从小到大依次覆盖 —— 先搞定最容易的目标，这也是产品的核心语义。
 *
 *   已覆盖：累计金额 + 该项年支出 ≤ 预测年度分红
 *   进行中：第一个装不下的项，进度 = (分红 - 已累计) / 该项年支出
 *   未点亮：其余全部
 *
 * 状态是"算"出来的而不是写死的，所以在设置页改金额 / 增删项后会立刻重排。
 * 默认数据下精确还原参考图：话费、物业费已覆盖，水电燃气进行中 63%，还差 ¥1,777。
 */
function coverageSource() {
  const dividend = store.summary().dividend

  const list = readLifeExpenses()
    .slice()
    .sort((a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0))
    .map((e) => ({
      id: e.id,
      name: e.name,
      icon: e.icon,
      year: (Number(e.amount) || 0) * 12
    }))

  let cum = 0
  let hasDoing = false

  return list.map((i) => {
    if (!hasDoing && cum + i.year <= dividend) {
      cum += i.year
      return Object.assign(i, { status: 'covered', progress: 100, gap: 0 })
    }
    if (!hasDoing) {
      hasDoing = true
      const remain = dividend - cum
      const lack = i.year - remain
      return Object.assign(i, {
        status: 'doing',
        progress: i.year ? Math.round((remain / i.year) * 100) : 0,
        gap: lack > 0 ? Math.round(lack) : 0
      })
    }
    return Object.assign(i, { status: 'locked', progress: 0, gap: 0 })
  })
}

/**
 * 成长阶段：按「已用于覆盖的分红金额 ÷ 所有支出项目的年支出总额」递进，
 * 与顶部成长之路、成长日志徽章同源。
 *   0% 起始出发 · 25% 有所起色 · 50% 小有所成 · 75% 收支平衡 · 100% 财务自由
 * 分子分母都是金额（不是项数），分母是"所有项目"的开支合计。
 * 如需调整节奏，只改这里的档位即可，进度条与日志徽章会同步跟随。
 */
const STAGE_NAMES = ['起始出发', '有所起色', '小有所成', '收支平衡', '财务自由']
const STAGE_STEPS = [0, 25, 50, 75, 100]

function stageIndexOf(ratio) {
  let idx = 0
  for (let i = 0; i < STAGE_STEPS.length; i++) {
    if (ratio >= STAGE_STEPS[i]) idx = i
  }
  return idx
}

/**
 * 成长日志：与覆盖进度联动生成。
 *   进行中的项 -> 「正在点亮 xxx」
 *   已覆盖的项 -> 「点亮了 xxx」，最新点亮的排在最上面
 *
 * 小标签规则：按点亮顺序累计覆盖率，哪一条把覆盖率推进到新档位，
 * 就在哪一条右侧打上那一档的标签；没跨过节点的条目不显示标签。
 * （第一条必然跨过 0% 这一档，所以一定带「起始出发」）
 */
function growthLogsVM(src, totalYear) {
  const covered = src.filter((i) => i.status === 'covered')
  const doing = src.filter((i) => i.status === 'doing')[0]

  const now = new Date()
  const date =
    now.getFullYear() + '-' + util.pad(now.getMonth() + 1) + '-' + util.pad(now.getDate())

  // 逐项累计，记录每一档是在点亮哪一项时跨过的
  const badgeOf = {}
  let cum = 0
  let reached = -1
  covered.forEach((i) => {
    cum += i.year
    const idx = stageIndexOf(totalYear ? (cum / totalYear) * 100 : 0)
    if (idx > reached) {
      reached = idx
      badgeOf[i.id] = STAGE_NAMES[idx]
    }
  })

  const logs = []
  if (doing) {
    logs.push({
      id: 'doing_' + doing.id,
      date,
      text: '正在点亮',
      target: doing.name,
      badge: '',
      badgeClass: ''
    })
  }

  // covered 本身按"由易到难"排，也就是点亮顺序，倒过来即最新在前
  covered
    .slice()
    .reverse()
    .forEach((i) => {
      const badge = badgeOf[i.id]
      logs.push({
        id: 'covered_' + i.id,
        date,
        text: '点亮了',
        target: i.name,
        badge: badge || '',
        badgeClass: badge ? 'tag-green' : ''
      })
    })

  return logs
}

// 分红覆盖（持仓页精简版）
function coverageBriefVM() {
  const src = coverageSource()

  const grid = src.map((i) => ({
    id: i.id,
    name: i.name,
    icon: i.icon,
    on: i.status === 'covered',
    doing: i.status === 'doing'
  }))

  const doing = src.filter((i) => i.status === 'doing')[0]

  return {
    coveredCount: src.filter((i) => i.status === 'covered').length,
    totalCount: src.length,
    gapText: doing ? moneyText(doing.gap, 0) : curSymbol() + '0',
    nextName: doing ? doing.name : '',
    nextIcon: doing ? doing.icon : '',
    grid
  }
}

// 分红覆盖（详情页完整版）
function coverageVM() {
  const src = coverageSource()
  const dividend = store.summary().dividend
  const totalYear = src.reduce((s, i) => s + i.year, 0)
  const covered = src.filter((i) => i.status === 'covered').length

  const list = src.map((i) => {
    const done = i.status === 'covered'
    const doing = i.status === 'doing'
    return {
      id: i.id,
      name: i.name,
      icon: i.icon,
      yearText: moneyText(i.year, 0),
      status: i.status,
      done,
      doing,
      locked: i.status === 'locked',
      progress: done ? 100 : doing ? i.progress : 0,
      tagText: done ? '已覆盖' : doing ? '进行中' : '未点亮',
      tagClass: done ? 'tag-green' : doing ? 'tag-orange' : 'tag-gray',
      note: done
        ? '分红已稳定覆盖此项开销'
        : doing
        ? '还差 ' + moneyText(i.gap, 0) + '，进度 ' + i.progress + '%'
        : '需 ' + moneyText(i.year, 0) + ' 分红就能点亮'
    }
  })

  const uncovered = list.filter((i) => !i.done)
  const nextTwo = uncovered.slice(0, 2)

  // 成长阶段：覆盖率 = 已用于覆盖的分红金额 ÷ 所有支出项目的年支出总额
  // 分红全额都用在覆盖上（完全覆盖若干项 + 进行中项已覆盖的一部分），
  // 所以分子 = min(预测年度分红, 所有项目年支出总额)
  const coveredAmount = Math.min(dividend, totalYear)
  const stageRatio = totalYear ? (coveredAmount / totalYear) * 100 : 0
  const stageIndex = stageIndexOf(stageRatio)
  const stageName = STAGE_NAMES[stageIndex]

  /**
   * 下一档目标 —— 文案里的「再覆盖 N 项 / 还需 X 分红」都必须指向它。
   *
   * 原先这两处取的是「未覆盖项的前两项」，与档位推进没有任何关系，于是界面上会
   * 出现「说好再覆盖 2 项就进下一档、覆盖完了进度条却纹丝不动」；而且那句话里的
   * 档位名是写死的，根本不在 STAGE_NAMES 里，进度条永远不可能显示成它。
   *
   * 档位是按**金额**划的，所以这里也按金额算差额，再换算成「还要点亮几项」。
   */
  const lastIndex = STAGE_NAMES.length - 1
  const topped = stageIndex >= lastIndex
  const nextIndex = Math.min(stageIndex + 1, lastIndex)
  // 下一档的金额门槛（档位按金额划，分母是全部支出合计）
  const nextThreshold = (STAGE_STEPS[nextIndex] / 100) * totalYear
  const nextStageGap = topped ? 0 : Math.max(0, nextThreshold - coveredAmount)

  // 到门槛时还能多点亮几项：用同一套「由易到难、累计不超门槛」的规则模拟一遍。
  //
  // 不能拿「未覆盖项的全年金额」去累加 —— 那样会把只吃得下一部分的项也当成整项，
  // 项数会虚高。实测：门槛只够再点亮 1 项，累加全年金额却数成了 2 项、金额也多出一倍。
  let cum = 0
  let reachable = 0
  src.forEach((i) => {
    if (cum + i.year <= nextThreshold) {
      cum += i.year
      reachable++
    }
  })
  const needCount = topped ? 0 : Math.max(0, reachable - covered)

  return {
    coveredCount: covered,
    totalCount: src.length,
    totalYearText: moneyText(totalYear, 2),
    dividendText: moneyText(dividend, 2),
    receivedText: moneyText(0, 2),
    stageName,
    stageIndex,
    // 进度线 = 当前档位在 5 个节点中的位置
    stageLine: Math.round((stageIndex / lastIndex) * 100),
    stages: STAGE_NAMES.map((name, i) => ({
      name,
      done: i < stageIndex,
      current: i === stageIndex
    })),
    // 已抵达最后一档：文案改说「已达成」，不再提「再覆盖几项」
    topped,
    nextStageName: topped ? '' : STAGE_NAMES[nextIndex],
    nextStageGapText: moneyText(nextStageGap, 0),
    // 口径说明用：档位是按**金额**推进的，和「覆盖了几项」不是同一个口径。
    // 两者同屏出现时容易被当成对不上（覆盖 3/7 项 ≠ 15%），所以要给个明确的算式。
    coveredAmountText: moneyText(coveredAmount, 2),
    stageRatioText: util.money(stageRatio, 1) + '%',
    needCount,
    needGapText: moneyText(nextStageGap, 0),
    next: nextTwo[0] || null,
    list,
    logs: growthLogsVM(src, totalYear)
  }
}

/* ================= 用户 ================= */

/**
 * 登录 / 注册走 utils/cloud.js（用户名 + 密码 → token），这里不再有微信手机号那套。
 *
 * 小程序版曾经有 login(code) 与 bindPhone(code)：靠 <button open-type="getPhoneNumber">
 * 拿授权码、由服务端换手机号。App 端没有这个能力（那是微信生态独有的），
 * 手机号也整个不再收集，所以这两个函数连同 profile 里的手机号项一起删掉了。
 */

/**
 * 退出登录：先让服务端的 token 失效，再清本机登录态（cloud.logout 里做）。
 * 只清本地是不够的 —— 那个 token 在服务端还能一直用到过期（30 天），
 * 与隐私政策里「退出登录即可让它失效」的说法不符。
 */
function logout() {
  return cloud
    .logout()
    .catch(() => null)
    .then(() => ok(true))
}

function getUser() {
  // 与「我的」页同源：昵称 / 头像取当前登录用户，slogan 是全局文案
  return ok({
    nickName: nickNameOf(),
    avatar: avatarOf(),
    slogan: mock.user.slogan
  })
}

/* ================= 持仓 ================= */

// market: 'A' | 'HK' | 'ETF' | 'FUND' | 'US'
// 切换标签按「实际持有的市场」动态生成：有哪一类持仓才出现哪一类标签
function buildTabs(holdings) {
  return mock.stockMarkets
    .map((m) => ({
      key: m.key,
      label: m.label,
      count: holdings.filter((h) => h.market === m.key).length,
      dotClass: m.dot
    }))
    .filter((t) => t.count > 0)
}

function getHoldings(market) {
  const all = store.allHoldings()
  const tabs = buildTabs(all)
  // 传入的市场已被删空时，自动落到第一个仍有持仓的市场
  const active = tabs.filter((t) => t.key === market).length
    ? market
    : (tabs[0] ? tabs[0].key : market)

  return ok({
    tabs,
    list: all.filter((h) => h.market === active).map(holdingVM),
    activeMarket: active,
    sorts: mock.holdingSorts,
    groupOptions: mock.holdingGroups
  })
}

/* ---------- 我的持仓：排序 / 分组 ---------- */
/**
 * 纯计算、无 IO，故设计为同步方法：切换排序 / 分组时零延迟重绘。
 * list 为 holdingVM 数组，排序依据的 dividend / priceYield / marketValue 等数值字段都已带在 VM 上。
 */

// 息率档位（用股价息率，成本为负时成本息率没有意义）
function yieldBucket(h) {
  const y = h.priceYield
  if (!(y > 0)) return { key: 'y-none', title: '暂无分红', order: 3 }
  if (y >= 5) return { key: 'y-high', title: '高息 ≥5%', order: 0 }
  if (y >= 3) return { key: 'y-mid', title: '中息 3%~5%', order: 1 }
  return { key: 'y-low', title: '低息 <3%', order: 2 }
}

// 分红贡献：占当前列表合计分红的比例
function contributionBucket(h, total) {
  const p = total > 0 ? (h.dividend / total) * 100 : 0
  if (p >= 50) return { key: 'c-main', title: '主力仓 ≥50%', order: 0 }
  if (p >= 20) return { key: 'c-sub', title: '次要仓 20%~50%', order: 1 }
  return { key: 'c-small', title: '小额仓 <20%', order: 2 }
}

// 仓位大小：按持仓市值
function positionBucket(h) {
  const v = h.marketValue
  if (v >= 50000) return { key: 'p-heavy', title: '重仓 ≥5万', order: 0 }
  if (v >= 10000) return { key: 'p-mid', title: '中仓 1万~5万', order: 1 }
  return { key: 'p-light', title: '轻仓 <1万', order: 2 }
}

const BUCKET_OF = {
  yield: yieldBucket,
  contribution: contributionBucket,
  position: positionBucket
}

function buildHoldingGroups(list, sortKey, groupKey) {
  const key = sortKey || 'default'
  const gk = groupKey || 'none'
  const src = list || []

  // default 保持录入顺序，与参考图一致；其余按数值降序
  const sorted =
    key === 'default'
      ? src.slice()
      : src.slice().sort((a, b) => (b[key] || 0) - (a[key] || 0))

  if (gk === 'none' || !BUCKET_OF[gk]) {
    return {
      groups: [{ key: 'all', title: '', count: sorted.length, list: sorted }],
      total: sorted.length
    }
  }

  const totalDividend = sorted.reduce((s, h) => s + h.dividend, 0)
  const bucketOf = BUCKET_OF[gk]
  const map = {}
  const order = []

  // 遍历已排好序的列表，保证组内顺序与当前排序一致
  sorted.forEach((h) => {
    const b = bucketOf(h, totalDividend)
    if (!map[b.key]) {
      map[b.key] = { key: b.key, title: b.title, count: 0, list: [], order: b.order }
      order.push(b.key)
    }
    map[b.key].count++
    map[b.key].list.push(h)
  })

  const groups = order
    .map((k) => map[k])
    .sort((a, b) => a.order - b.order)
    .map((g) => ({ key: g.key, title: g.title, count: g.count, list: g.list }))

  return { groups, total: sorted.length }
}

function getHolding(id) {
  const target = store.getRaw(id)
  if (!target) return fail('未找到该持仓', 404)
  const vm = holdingVM(target)
  vm.menus = clone(mock.holdingMenus).map((m) =>
    m.key === 'dividend' ? Object.assign(m, { desc: '累计已获 ' + vm.receivedText }) : m
  )
  return ok(vm)
}

function getSummary() {
  const vm = summaryVM()
  vm.metrics = toMetricVM(readMetricKeys(), true)
  return ok(vm)
}

function getCoverageBrief() {
  return ok(coverageBriefVM())
}

/* ================= 汇总指标读写 ================= */

function getMetricSettings() {
  const keys = readMetricKeys()
  const svm = summaryVM()
  return ok(
    Object.assign(
      {
        max: mock.METRIC_MAX,
        dividendText: svm.dividendText
      },
      buildMetricLists(keys)
    )
  )
}

function getDefaultMetricKeys() {
  return ok(defaultMetricKeys())
}

// 允许选 0 个：此时首页汇总区自动收起
function saveMetricSettings(keys) {
  if (!(keys instanceof Array)) return fail('缺少指标参数')
  if (keys.length > mock.METRIC_MAX) return fail('最多选择 ' + mock.METRIC_MAX + ' 个指标')
  wx.setStorageSync(METRIC_STORE_KEY, keys.slice())
  store.markDirty()
  return ok(keys.slice())
}

const COST_MODES = ['分红摊薄', '摊薄成本', '加权平均']
const DIV_MODES = ['近1年', '近3年', '近5年', '自定义']

// 从买入日期算持股天数（含当天）。**没有日期就返回 0**，不再兜底成 1。
//
// ⚠️ 这里返工过，原来写的是"异常日期兜底为 1 天"。那个兜底造成了一个真问题：
// buyDate 是后来才加的字段，在那之前录入的老持仓快照里没有它 ——
// 于是 daysSince('') 返回 1，addHolding 把它**存进** holdingDays；
// 之后读的时候又因为 d.buyDate 为空而回落到那个存死的 holdingDays，
// 表现就是「早就买了，却永远显示 1 天」。
//
// 0 表示"算不出来"，由调用方决定怎么显示（HoldingDetail 显示成「—」）。
// 它和"今天买 = 1 天"不冲突：那是有日期的正常结果。
function daysSince(dateStr) {
  const start = parseDateKey(dateStr)
  if (!start) return 0

  // 把"今天"也归到零点：两个零点相减才是整数天。不归零的话，
  // 当天上午 9 点算"昨天买的"会得到 1.375 天，floor 之后少一天
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const days = Math.round((today - start) / 86400000) + 1
  return days > 0 ? days : 0
}

/**
 * 把 'yyyy-MM-dd' 解析成**本地时区零点**的 Date；格式不对返回 null。
 *
 * ⚠️ 必须手拆字符串，**不能**图省事写成一个 new Date(...)：
 *
 *   · new Date('2026-02-03')   按 **UTC 午夜** 解析 —— 东八区会少算一天
 *   · new Date('2026/02/03')   V8 能解析，**Hermes 不能**（RN 的引擎）
 *
 * 第二条是踩过的真坑（就在这个函数上）：`new Date('2026/02/03')` 在 Hermes 上
 * 得到 **Invalid Date**，而 Invalid 恰好落进"日期不合法"的分支 ——
 * 表现是「日期明明填了，天数却算不出来」，**不打任何日志**。
 *
 * 它难查在两点：一是在电脑（Node）上跑同样的代码是对的，二是换个写法
 * （加不加 replace）结果就变，所以人会先怀疑数据而不是这行。
 *
 * 数字构造 `new Date(y, m-1, d)` 是所有 JS 引擎都保证支持的，且天然是本地零点。
 */
function parseDateKey(key) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(key || '').trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return new Date(y, mo - 1, d)
}

/**
 * 取一只持仓**最早**的交易日期（没有交易返回空串）。
 *
 * ⚠️ 它是买入日期的最后一道兜底，为的是修一个真实的数据问题：
 * buyDate 和 seedDate 都是**后来才加**的字段，在那之前录入的持仓两个都空，
 * 于是持股天数永远停在建仓时的死值。
 * 交易记录的 date 是用户真的填过的，是这批老数据里唯一还活着的日期。
 *
 * 日期是 yyyy-MM-dd，**字典序即时间序** —— 所以这里不转 Date，
 * 也就不会踩时区（转 Date 再用 getTime 比大小是这类代码最常见的坑）。
 */
function earliestTradeDateOf(id) {
  const trades = (readRecords()[id] || {}).trade || []
  let min = ''
  trades.forEach((t) => {
    const d = String((t && t.date) || '')
    if (!d) return
    if (!min || d < min) min = d
  })
  return min
}

/**
 * 一只持仓用于算持股天数的日期，按可靠性逐级兜底：
 *
 *   buyDate   用户在编辑面板填的（首选，也是新数据一定有）
 *   seedDate  建仓基准里那份（买过之后又被重算过时才存在）
 *   最早一笔交易 老数据唯一的日期来源
 *
 * 三个都空说明这只持仓确实没有日期信息，返回空串 ——
 * 调用方显示「—」，让用户自己在编辑面板补一次，而不是编一个数字出来。
 */
function holdingStartDate(d) {
  return String((d && (d.buyDate || d.seedDate)) || '') || earliestTradeDateOf(d && d.id)
}

/**
 * 手动添加持仓：落本地 storage，首页与各统计随即包含这只持仓。
 * 录入侧只提供「股数 / 成本 / 日期」，行情侧字段按下面规则补齐：
 *   dps   —— 按分红口径（近1/3/5年系数或自定义）从股票池估算
 *   price —— 取标的池里的最新价；自定义标的没有行情源，退回成本绝对值，
 *            保证市值、股价息率、浮盈都能算出来
 */
function addHolding(form) {
  if (!form || !form.code || !form.name) return fail('请填写代码与名称')
  const shares = Number(form.shares)
  if (!(shares > 0)) return fail('请填写正确的持仓数量')

  const code = String(form.code).trim().toUpperCase()
  const market = form.market || guessMarket(code)

  // 会员门禁：持仓数量上限（免费 3 只），以及港股 / 美股仅 Pro 可用
  const gate = membership.checkHolding(store.allRaw(), market)
  if (!gate.ok) return fail(gate.msg, 402)

  const inPool = findStock(code)

  /**
   * 录入侧的钱一律是**本币**（港股按港币填、美股按美元填），快照也
   * **只存本币原值** —— 你填 3.44 港币，存进去的数字就是 3.44。
   * 人民币金额不落库，由 store.decorate 按当时的实时汇率现算。
   *
   * 这样汇率怎么变，你录入的数字都不会被偷偷改掉，只会让市值跟着汇率动；
   * 也不会再出现「成本是人民币、股息是港币」这种单位打架把息率算歪的情况。
   */
  const idx = Math.max(0, DIV_MODES.indexOf(form.divMode))
  const custom = Number(form.customDividend)

  // 分红口径基数按口径取：添加页会把分红档案的三口径值一起带过来；
  // 缺失时才退回单值（接口拿不到档案的情况）。两者都是本币
  const modes = form.dpsByMode
  const rawBaseDps = modes
    ? Number(modes[DIV_KEYS[idx] || 'm1']) || 0
    : Number(form.baseDps) > 0
    ? Number(form.baseDps)
    : inPool
    ? inPool.dps
    : 0
  const baseDps = rawBaseDps
  // 分红税率逐只可配；关掉「预测分红扣税」就按 0% 算
  const taxRate = taxRateFromForm(form, market)
  const taxOn = form.taxOn !== false
  // 持仓统一存税后口径；自定义口径是用户自己填的税后本币金额，同样要折成人民币存
  const dpsNative =
    idx === 3 && custom > 0 ? custom : Number(netDpsOf(rawBaseDps, taxOn ? taxRate : 0).toFixed(6))
  const dps = dpsNative

  // 以下全部只存本币原值：人民币金额由 decorate 按实时汇率现算，不落库
  const costNative = Number(form.cost) || 0
  const feeNative = Number(form.fee) || 0
  // 建仓手续费直接摊进每股成本：投入里本来就有它，不摊的话用户得等到
  // 以后加一笔交易才被算进去（那时才第一次跑 positionOf）。
  // 注意基准 seedCost 只放用户填的成本，手续费由 fee 字段单独记着 ——
  // 否则 positionOf 重算时会「基准里一份 + 再摊一份」，成本凭空膨胀。
  const cost = shares > 0 ? Number((costNative + feeNative / shares).toFixed(6)) : costNative
  // 现价优先用页面取回的实时行情（本币），拿不到时才退回录入成本
  const livePriceNative = Number(form.price) > 0 ? Number(form.price) : 0
  const livePrice = livePriceNative
  // 拿不到行情时现价的语义跟着成本走（「按录入成本估算」），本币原值同理
  const priceNative = livePrice > 0 ? livePriceNative : Math.abs(costNative)
  const price = priceNative

  const record = {
    id: 'u-' + market + '-' + code + '-' + Date.now(),
    code: code,
    name: form.name,
    market: market,
    marketLabel: MARKET_LONG_LABEL[market] || market,
    shares: shares,
    dps: dps,
    dpsNative: dpsNative,
    // 记一份真实派息基数（已折人民币），之后改分红口径时不必再请求接口
    baseDps: baseDps,
    baseDpsNative: rawBaseDps,
    price: price,
    priceNative: priceNative,
    priceDate: form.priceDate || (livePrice > 0 ? '实时行情' : '按录入成本估算'),
    cost: cost,
    costNative: cost,
    // 建仓基准：只放用户填的每股成本（不含手续费）。
    // 定下来是为了以后加交易时，重算从「真正录入的那个数」出发，
    // 而不是从摊过手续费的当前成本出发 —— 那会把手续费算两次。
    seedShares: shares,
    seedCost: costNative,
    seedCostNative: costNative,
    seedDate: form.buyDate || '',
    taxRate: taxRate,
    taxOn: taxOn,
    holdingDays: daysSince(form.buyDate),
    received: 0,
    // 以下为录入侧信息，持仓详情页/编辑时可回显
    buyDate: form.buyDate || '',
    fee: feeNative,
    feeNative: feeNative,
    costMode: form.costMode || '',
    divMode: form.divMode || '',
    negativeCost: !!form.negativeCost,
    custom: true,
    // 归到当前账户名下：切到别的账户就看不到它
    accountId: readActiveAccountId()
  }

  store.appendHolding(record)
  return ok(holdingVM(record))
}

/* ================= 添加持仓：选股与口径估算 ================= */

// 分红预测口径的基数改由 dpsByModeOf 按真实财年均值给出，见文件上方定义

function todayKey() {
  const now = new Date()
  return now.getFullYear() + '-' + util.pad(now.getMonth() + 1) + '-' + util.pad(now.getDate())
}

/* ================= 标的行情 / 分红档案 =================
 * 添加自选（持仓）时「输入代码或名称 -> 取到真实价格与分红档案」的统一出口。
 * 价格、涨跌、历史分红全部来自 utils/quote.js 的东方财富实时接口，
 * 本地不保存任何价格或分红数据；详情见 utils/quote.js 顶部的域名白名单说明。
 */

/* ---------------- 分红税率 ----------------
 * 各市场给出的只是「默认值」，真正生效的是每只持仓自己存的 taxRate + taxOn。
 * 同是港股，港股通 H 股（20%）、红筹（28%）、香港券商直投（10%）、
 * 本地股（0%）差别很大；美股也要按实际预扣填，所以做成逐只可调。
 */
const DEFAULT_TAX_RATE = { A: 0, ETF: 0, FUND: 0, HK: 20, US: 10 }

// 税率预设胶囊，与「添加持仓」页一一对应，rate 为 null 表示自定义
const TAX_OPTIONS = [
  { rate: 20, text: '20%' },
  { rate: 28, text: '28%' },
  { rate: 10, text: '10%' },
  { rate: 0, text: '0%' },
  { rate: null, text: '自定义' }
]

// 各市场的税率说明，选完股票后按市场取
const TAX_TIPS = {
  HK: '港股通 H 股默认 20%；红筹股选 28%；香港券商直投 H 股选 10%；港股直接持有本地股选 0%',
  US: '美股股息一般按税收协定预扣 10%，实际扣税不同可自定义',
  A: 'A 股股息红利按持股期限差别化征收，长期持有多为免征，默认 0%',
  ETF: '境内基金分红一般不额外扣税，默认 0%',
  FUND: '境内基金分红一般不额外扣税，默认 0%'
}

function defaultTaxRateOf(market) {
  const r = DEFAULT_TAX_RATE[market]
  return r === undefined ? 0 : r
}

// 持仓实际生效的税率：关掉「预测分红扣税」就等于按 0% 算
function effectiveTaxRate(h) {
  if (!h || h.taxOn === false) return 0
  const r = Number(h.taxRate)
  if (h.taxRate === undefined || h.taxRate === null || h.taxRate === '' || isNaN(r)) {
    return defaultTaxRateOf(h.market || 'A')
  }
  return r
}

// 表单传进来的税率；没填就退回该市场默认值
function taxRateFromForm(form, market) {
  const f = form || {}
  const r = Number(f.taxRate)
  if (f.taxRate !== undefined && f.taxRate !== null && f.taxRate !== '' && !isNaN(r)) return r
  return defaultTaxRateOf(market)
}

/**
 * 持仓里的每股派息一律存「税后」口径（详情页的预测年分红、成本息率、股价息率
 * 标题都写着税后），而分红接口给的是税前方案，所以统一在这里扣一道红利税。
 */
function netDpsOf(baseDps, taxRate) {
  const base = Number(baseDps) || 0
  if (!(base > 0)) return 0
  return base * (1 - (Number(taxRate) || 0) / 100)
}

// 用真实分红档案推出该持仓应有的派息（税前基数 + 按口径折算的税后每股派息）
// 自定义口径的金额是用户自己填的，不覆盖；档案里算不出来时返回 null
function holdingDpsPatch(h, dividend) {
  const idx = Math.max(0, DIV_MODES.indexOf(h.divMode || DIV_MODES[0]))
  if (idx === 3) return null

  // 基数按口径取：近1年 = 最近一个完整财年，近3/近5年 = 对应财年的合计均值
  const base = dpsBaseFor(dividend, idx)
  if (!(base > 0)) return null

  // 接口给的派息是**本币**，快照也只存本币原值（人民币由 decorate 现算）
  const dpsNative = Number(netDpsOf(base, effectiveTaxRate(h)).toFixed(6))

  return {
    baseDps: base,
    baseDpsNative: base,
    dps: dpsNative,
    dpsNative: dpsNative
  }
}

// 标的池仅用于「只拿到代码时判断市场」这类辅助场景，行情与分红一律以接口为准
function findStock(code) {
  const key = String(code || '').trim().toUpperCase()
  if (!key) return null
  return mock.stockPool.filter((s) => s.code.toUpperCase() === key)[0] || null
}

// 榜单 / 工具页只带 ?code= 跳进来时，用它推断市场
function guessMarket(code) {
  const c = String(code || '').trim().toUpperCase()
  if (!c) return 'A'
  const inPool = findStock(c)
  if (inPool) return inPool.market
  if (/^\d{5}$/.test(c)) return 'HK'
  if (/^[A-Z][A-Z.]{0,6}$/.test(c)) return 'US'
  if (/^[15]\d{5}$/.test(c)) return 'ETF'
  return 'A'
}

// 搜索结果项：带上真实市场标签，一行就能看清是哪个市场的标的
function stockBriefVM(s) {
  const mi = marketOf(s.market)
  return {
    // 同一代码可能出现在不同市场（如 000756 既是深A股票也是场外基金），key 用市场+代码
    key: s.market + '-' + s.code,
    code: s.code,
    name: s.name,
    market: s.market,
    marketLabel: MARKET_LABEL[s.market] || s.market,
    // marketTag 是短徽标（A / E / 基 / 港），已选行只放得下一个字
    marketTag: mi.tag,
    cls: mi.cls,
    tagClass: mi.cls,
    typeName: s.typeName || ''
  }
}

/* ---------- 行情：真实价格 -> 展示文案 ---------- */

// 价格按当前显示货币换算；涨跌幅是比例，不受换算影响
function quoteVM(q, market) {
  if (!q || !(q.price > 0)) return null

  const digits = q.digits || 2
  const sign = (v) => (v >= 0 ? '+' : '-')
  const trend = q.change > 0 ? 'up' : q.change < 0 ? 'down' : 'flat'

  return {
    price: q.price,
    // 价格与涨跌额是这只股票的本币报价（港股 HK$、美股 $）：按显示货币换算
    // 反而和行情软件对不上。涨跌幅 / 振幅是比例，不受币种影响，照旧
    priceText: nativeRawText(q.price, market, digits),
    prevCloseText: nativeRawText(q.prevClose, market, digits),
    change: q.change,
    changeText: sign(q.change) + nativeRawText(Math.abs(q.change), market, digits),
    changeRate: q.changeRate,
    changeRateText: sign(q.changeRate) + util.money(Math.abs(q.changeRate), 2) + '%',
    trend,
    trendText: trend === 'up' ? '涨' : trend === 'down' ? '跌' : '平',
    openText: q.open ? nativeRawText(q.open, market, digits) : '--',
    highText: q.high ? nativeRawText(q.high, market, digits) : '--',
    lowText: q.low ? nativeRawText(q.low, market, digits) : '--',
    amplitudeText: q.amplitude ? util.money(q.amplitude, 2) + '%' : '--',
    turnoverText: q.turnoverRate ? util.money(q.turnoverRate, 2) + '%' : '--',
    peText: q.pe ? util.money(q.pe, 2) : '--',
    pbText: q.pb ? util.money(q.pb, 2) : '--',
    capText: q.marketCap ? util.money(q.marketCap / 100000000, 2) + ' 亿' : '--',
    // 场外基金看单位净值，其它看最新价
    priceLabel: market === 'FUND' ? '单位净值' : '最新价',
    priceDate: q.priceDate || '实时行情'
  }
}

/* ---------- 分红档案：接口原始记录 -> 展示结构 ---------- */

function dividendDateLine(r) {
  // 刚公告、还没走到除权的方案没有除息日，退而显示方案进度
  if (!r.exDate) return r.progress || '尚未实施'

  const parts = ['除权除息 ' + r.exDate]
  if (r.payDate) parts.push('到账 ' + r.payDate)
  else if (r.recordDate) parts.push('登记 ' + r.recordDate)
  return parts.join(' · ')
}

/**
 * dividend 为 null 表示该市场没有开放分红接口（美股），页面按「无数据」展示；
 * list 为空数组表示接口查到了、但这只标的确实没有分红记录。
 * dps 是真实派息口径：最近一个完整财年的派息合计（见 annualDpsOf）。
 */
function dividendArchiveVM(dividend, price, market) {
  if (!dividend) {
    return {
      available: false,
      hasDividend: false,
      list: [],
      count: 0,
      source: '',
      basisText: '',
      dps: 0,
      dpsText: '--',
      totalDpsText: '--',
      emptyText: '该市场暂未开放分红档案接口，可在下方手动填写每股派息'
    }
  }

  const rows = dividend.list || []
  // 展示只露最近 6 期；派息口径要拿全量记录算，否则跨年的方案会被截断
  let markedCurrent = false
  const list = rows.slice(0, 6).map((r, i) => {
    // 已公告但还没除权（例如刚披露的中报方案）：单独标出来，不当作「最近一次」
    const pending = !r.exDate
    const current = !pending && !markedCurrent
    if (current) markedCurrent = true

    return {
      index: i,
      periodText: r.period || '—',
      planText: r.planText || '—',
      dps: r.dps,
      // 派息方案是这只股票的本币金额（接口原值），按本币展示
      dpsText: nativeRawText(r.dps, market, 4),
      exDate: r.exDate || '—',
      dateText: dividendDateLine(r),
      progress: r.progress || '',
      pending,
      current
    }
  })

  const annual = annualDpsOf(dividend)
  const dps = annual.dps

  return {
    available: true,
    hasDividend: list.length > 0,
    list,
    count: list.length,
    source: dividend.source || '',
    basisText: annual.year ? annual.year + ' 年度派息合计' : list.length ? '最近一期派息' : '',
    dps,
    // 三个口径各自的基数，添加页按用户选的口径取用（近1/3/5年）
    dpsByMode: dpsByModeOf(dividend),
    dpsText: nativeRawText(dps, market, 4),
    totalDpsText: nativeRawText(list.reduce((s, r) => s + r.dps, 0), market, 4),
    emptyText: '暂无分红记录'
  }
}

/* ---------- 标的详情：行情 + 分红档案 + 税后息率 ---------- */

const EMPTY_QUOTE = {
  priceText: '--',
  prevCloseText: '--',
  changeText: '',
  changeRateText: '',
  trend: 'flat',
  highText: '--',
  lowText: '--',
  openText: '--',
  peText: '--',
  pbText: '--',
  capText: '--',
  priceDate: '暂无行情'
}

function stockDetailVM(stock, q, dividend) {
  const market = stock.market
  const mi = marketOf(market)
  const quoteView = quoteVM(q, market)
  const price = quoteView ? quoteView.price : 0
  const div = dividendArchiveVM(dividend, price, market)
  // 这里只是「该市场默认税率」，用来在选完股票时先给出一个税后股息率，
  // 下一步用户可以在「分红税率」里逐只调整
  const taxRate = defaultTaxRateOf(market)
  const netYield = price > 0 ? (netDpsOf(div.dps, taxRate) / price) * 100 : 0

  return Object.assign(
    {
      code: stock.code,
      name: q && q.name ? q.name : stock.name,
      market,
      marketLabel: MARKET_LABEL[market] || market,
      marketTag: mi.tag,
      tagClass: mi.cls,
      // 分红预测口径的基数来自真实派息记录
      dps: div.dps,
      dpsText: div.dpsText,
      dpsBasisText: div.basisText,
      taxRate,
      yieldText: div.dps > 0 && price > 0 ? util.money(netYield, 2) + '%' : '--',
      taxTipText: taxRate > 0 ? '已按 ' + taxRate + '% 红利税折算' : '按税前股息计算',
      // 该市场的税率说明，页面「分红税率」卡片直接用
      taxTip: TAX_TIPS[market] || TAX_TIPS.A,
      dividend: div,
      hasQuote: !!quoteView,
      priceLabel: market === 'FUND' ? '单位净值' : '最新价',
      sourceText: '数据来源：东方财富（实时）'
    },
    EMPTY_QUOTE,
    quoteView || {}
  )
}

/**
 * 标的详情：一次取回实时行情 + 分红档案。
 * 支持两种入参：搜索结果对象（带 market / secid），或直接给代码字符串。
 */
function getStockDetail(stock) {
  const target =
    typeof stock === 'string'
      ? { code: String(stock).trim().toUpperCase(), market: guessMarket(stock) }
      : stock

  if (!target || !target.code) return fail('缺少标的代码', 400)

  const code = String(target.code).trim().toUpperCase()
  const market = target.market || guessMarket(code)

  return quote
    .fetchDetail({ code, market, secid: target.secid || '' })
    .then((res) => {
      if (!res.quote && !res.dividend) {
        return fail('未获取到行情，请确认代码是否正确或稍后重试', 404)
      }
      return ok(stockDetailVM({ code, market, name: target.name || '' }, res.quote, res.dividend))
    })
    .catch((e) => fail((e && e.msg) || '行情获取失败，请稍后重试', (e && e.code) || 0))
}

function getAddHoldingOptions() {
  return ok({
    markets: mock.stockMarkets,
    costModes: COST_MODES,
    divModes: DIV_MODES,
    buyDate: todayKey(),
    // 页面自己拼金额文案时要用当前显示货币的符号
    symbol: curSymbol(),
    // 分红税率：胶囊预设 / 各市场说明 / 各市场默认值
    taxOptions: TAX_OPTIONS,
    taxTips: TAX_TIPS,
    defaultTaxRates: DEFAULT_TAX_RATE
  })
}

// 从榜单 / 工具页带 ?code= 跳进来时，按代码直接取到标的详情
function getStockByCode(code) {
  return getStockDetail(code)
}

/**
 * 个股新闻：公司公告 + 个股资讯 + 行业政策。**会员功能**。
 *
 * ⚠️ 会员判断**在服务端**（不在这个函数里）：会员状态是本机缓存、可以改，
 * 而这是要付费才能看的内容 —— 判断必须落在服务端。非会员时服务端回 402，
 * 这里原样透给调用方，页面上已有的 .catch(util.onError) 会弹出开通引导。
 *
 * ⚠️ market 要一起传：公告是按"代码 + 市场"查的，同一个代码在不同市场
 * 是两只不同的股票。
 *
 * 返回空数组而不是报错表示"这只股票最近没有新闻"—— 那对用户是个正常结果，
 * 不该表现成失败。
 */
function getStockNews(code, market, limit) {
  const c = String(code || '').trim().toUpperCase()
  if (!c) return ok([])

  return cloud
    .getStockNews(c, market || guessMarket(c), limit)
    .then((body) => ok((body && body.data && body.data.list) || []))
    .catch((e) => fail((e && e.msg) || '读取新闻失败，请稍后重试', (e && e.code) || 0))
}

/**
 * 关键字搜索：走行情搜索接口，代码 / 中文名 / 拼音首字母都能命中，
 * 覆盖全市场标的而不是本地清单。
 * 当前所选市场的结果排前面，但不隐藏其它市场的匹配 —— 直接输代码也能搜到，
 * 选中后页面会把市场标签自动切到该标的的真实市场。
 */
function searchStocks(q) {
  const kw = String((q && q.keyword) || '').trim()
  const prefer = (q && q.market) || ''
  if (!kw) return ok([])

  return quote
    .search(kw)
    .then((list) => {
      const rank = (s) => (s.market === prefer ? 0 : 1)
      const sorted = list.slice().sort((a, b) => rank(a) - rank(b))
      return ok(sorted.map(stockBriefVM))
    })
    .catch((e) => fail((e && e.msg) || '搜索失败，请稍后重试', (e && e.code) || 0))
}

/**
 * 按选中标的 + 分红口径估算年均每股分红（税后），与 addHolding 落库的口径一致。
 * 基数优先用实时分红档案算出的税前年度派息（baseDps），
 * 只有接口拿不到时才退回标的池记录。
 */
function estimateDividend(q) {
  const code = String((q && q.code) || '').trim().toUpperCase()
  const idx = Number((q && q.divModeIndex) || 0)
  const custom = Number((q && q.customDividend) || 0)

  const inPool = findStock(code)
  const market = (q && q.market) || (inPool ? inPool.market : '') || guessMarket(code)

  // 自定义口径直接用用户填的税后金额。返回的一律是**本币**口径：
  // 它显示在「年均每股分红」旁边，下面紧跟着的就是按本币填的输入框
  if (idx === 3) {
    if (!(custom > 0)) return ok({ dividendText: '--', hasDividend: false })
    return ok({ dividendText: nativeRawText(custom, market, 4), hasDividend: true })
  }

  // 基数按口径取：优先用档案给出的三口径值，缺失时才退回单值
  const modes = q && q.dpsByMode
  const base = modes
    ? Number(modes[DIV_KEYS[idx] || 'm1']) || 0
    : Number((q && q.baseDps) || 0) > 0
    ? Number(q.baseDps)
    : inPool
    ? inPool.dps
    : 0
  if (!(base > 0)) return ok({ dividendText: '--', hasDividend: false })

  // 关掉「预测分红扣税」就等于不扣税
  const rate = q && q.taxOn === false ? 0 : taxRateFromForm(q, market)
  return ok({
    dividendText: nativeRawText(netDpsOf(base, rate), market, 4),
    hasDividend: true
  })
}

function removeHolding(id) {
  if (!id) return fail('缺少持仓 ID')
  store.removeHolding(id)
  return ok(true)
}

/* ================= 清仓归档（投资档案） =================
 * 清仓之后记录不该消失：用户要能回头验证「当初卖对了没有」。
 * 归档是**标记**而不是删除 —— 持仓、交易流水、每笔的想法全部保留，
 * 只是从持仓列表挪到档案页。
 *
 * 归档的两种来源见 store.isArchived：股数归零（卖出全部）自动归档，
 * 或在详情页手动点「清仓归档」。
 */

// 单只归档标的的展示模型
function archiveRowVM(h) {
  // 退出价：自动归档时是卖出价，手动归档时是当时的现价
  const exitNative = nativeOf(h, 'exitPrice') || nativeOf(h, 'price')
  const nowNative = nativeOf(h, 'price')
  // 卖出至今涨跌 —— 这个页面存在的意义就在这一行：
  // 负数是「躲过了下跌」（卖对了），正数是「卖早了」（少赚了），两种都值得看
  const sinceExit = exitNative > 0 ? ((nowNative - exitNative) / exitNative) * 100 : 0
  const mi = marketOf(h.market)

  return {
    id: h.id,
    name: h.name,
    code: h.code,
    icon: String(h.name || '?').substring(0, 1),
    marketTag: mi.tag,
    tagClass: mi.cls,
    sharesText: util.group(Number(h.shares) || 0, 0) + '股',
    exitPriceText: nativeRawText(exitNative, h.market, 2),
    nowPriceText: nativeRawText(nowNative, h.market, 2),
    sinceExitText: (sinceExit > 0 ? '+' : '') + util.money(sinceExit, 2) + '%',
    // 数值单列一份给排序用。上面那个是**已格式化**的文本（带 + 号和 %），
    // 拿它排序等于按字符串比大小：'+9.80%' 会排在 '+10.20%' 后面。
    // 这类错误很隐蔽 —— 数字都显示出来了，顺序却不对，一眼看不出是谁的问题。
    sinceExit: sinceExit,
    sinceExitUp: sinceExit > 0,
    sinceExitDown: sinceExit < 0,
    receivedText: moneyText(h.received, 2),
    received: Number(h.received) || 0,
    archivedAt: h.archivedAt || '',
    // 清仓理由：优先用手动填的 archiveReason，否则回落到最后一笔交易的 note
    reason: archiveReasonOf(h),
    // 能不能退回持仓列表：只有「手动归档、且还持有」的可以。
    // 卖光那种归档状态是从 shares 推导出来的（见 store.isArchived），
    // 不写回股数就退不出去 —— 所以按钮只对 canRestore 的显示。
    canRestore: Number(h.shares) > 0
  }
}

// 清仓理由：手动归档时用户填的，或者最后一笔交易写下的想法
function archiveReasonOf(h) {
  const own = String(h.archiveReason || '').trim()
  if (own) return own
  const rec = recordsOf(h.id)
  const trades = (rec.trade || []).slice()
  // 取最后一笔有备注的，倒着找 —— 卖出那笔通常在最后
  for (let i = trades.length - 1; i >= 0; i--) {
    const n = String((trades[i] && trades[i].note) || '').trim()
    if (n) return n
  }
  return ''
}

function getArchive() {
  const rows = store.archivedHoldings().map(archiveRowVM)

  // 三组计数，对应档案页顶部那排筛选项。
  //
  // 「卖对 / 卖飞」是同一个 sinceExit 的两个方向，所以两者之和**不**等于总数：
  // 涨跌正好为 0 的（现价与清仓价相同）两边都不算 —— 它既不证明卖对也不证明卖飞，
  // 归到哪边都是硬凑。页面上的计数徽标必须诚实反映这一点。
  const win = rows.filter((r) => r.sinceExitDown).length
  const fly = rows.filter((r) => r.sinceExitUp).length
  // 「未写想法」不是统计量，是个**动作入口**：把散落各处的待补写聚成一批，
  // 让「回头补一句」这件事能一次做完，而不是靠翻列表偶遇
  const noReason = rows.filter((r) => !r.reason).length

  return ok({
    list: rows,
    count: rows.length,
    winCount: win,
    flyCount: fly,
    noReasonCount: noReason,
    winText: rows.length ? win + ' / ' + rows.length : '—',
    emptyText: '还没有清仓的标的。卖出全部股数后，它会自动出现在这里。'
  })
}

// 归档标的的完整详情：持仓概览 + 全部流水（含每笔的想法）
function getArchivedHolding(id) {
  const h = store.getHoldingAny(id)
  if (!h || !store.isArchived(h)) return fail('未找到该归档标的', 404)

  return quote
    .fetchDividend({ code: h.code, market: h.market })
    .catch(() => null)
    .then((dividend) => {
      const vm = holdingVM(h)
      const file = dividendFileVM(h, dividend)
      return ok({
        holding: vm,
        archive: archiveRowVM(h),
        trade: tradeVM(h),
        dividend: dividendVM(h),
        file: file.list,
        fileTotalText: file.totalText,
        filePassedText: file.passedText,
        receivedText: vm.receivedText
      })
    })
}

/**
 * 心得体悟的字数上限：交易备注（addTradeRecord 的 note）与清仓心得
 * （archiveReason）共用。这个长度是**给人写长文**的，不是短评 ——
 * 5000 字约等于一篇完整的复盘，日常很难写满。
 *
 * 为什么不彻底取消上限：快照有 5MB 总额度（config.MaxPayloadBytes），
 * 单条不限的话一条记录就能把额度吃光，之后**整份同步都会被拒**
 * （400 数据过大）—— 那比「打不进去」糟得多，而且同样没有提示。
 * 真的需要更长，拆成多条记录写即可。
 *
 * 口径必须是**字符数**：前端按码点限（clip），服务端也按 rune 校
 * （snapshot.checkText）。两边不一致会造出「本地存得下、同步被服务端
 * 拒掉」这种最难查的问题。
 */
const MEMO_MAX = 5000

/**
 * 手动清仓归档：以当前价作为退出价，股数不动。
 *
 * reason 是归档时写下的心得体悟（可选）。「当初为什么买、现在为什么卖」
 * 在归档那一刻最好写，回头看时的价值也远高于清仓价本身 —— 所以把它
 * 做成归档流程的一步，而不是事后再去找入口。
 */
function archiveHolding(id, reason) {
  const raw = store.getRaw(id)
  if (!raw) return fail('未找到该持仓', 404)
  const h = store.getHolding(id)
  const exitNative = nativeOf(h, 'price')
  // clip 而不是 slice：slice 数的是 UTF-16 码元，emoji 会被切出半个代理项
  const memo = validate.clip(String(reason || '').trim(), MEMO_MAX)

  const patch = {
    archived: true,
    archivedAt: todayKey(),
    exitPrice: exitNative,
    exitPriceNative: exitNative
  }
  // 只在确实写了的时候覆盖：留空提交不该把之前写过的想法抹掉
  if (memo) patch.archiveReason = memo

  writeHoldingPatch(id, patch)
  return ok(true)
}

/**
 * 补写 / 修改清仓心得。
 *
 * 独立于归档动作，也不要求当前是归档态：归档时未必想清楚（也可能随手
 * 跳过），过段时间回看才最有话说 —— 那时必须还能补，否则「记一句」就
 * 成了一次性的事，错过就永远空着。
 */
function setArchiveReason(id, reason) {
  const h = store.getHoldingAny(id)
  if (!h) return fail('未找到该持仓', 404)

  writeHoldingPatch(id, {
    archiveReason: validate.clip(String(reason || '').trim(), MEMO_MAX)
  })
  return ok(true)
}

/**
 * 移出归档（恢复为在持）。
 *
 * 注意：股数归零的那类「归档」恢复不了 —— 它的归档状态是由 shares 推导的，
 * 不写回股数就还在档案里。这种情况只能靠重新买入来回到持仓列表。
 */
function unarchiveHolding(id) {
  const raw = store.getRawAny(id)
  if (!raw) return fail('未找到该持仓', 404)
  if (!(Number(raw.shares) > 0)) {
    return fail('这股已卖光，重新买入后才能回到持仓列表')
  }
  writeHoldingPatch(id, {
    archived: false,
    archivedAt: '',
    exitPrice: null,
    exitPriceNative: null
  })
  return ok(true)
}

/* ================= 分红覆盖 ================= */

function getCoverage() {
  return ok(coverageVM())
}

/* ================= 生活支出 ================= */

function expenseVM(list, onIds) {
  const list2 = list.map((e) =>
    Object.assign({}, e, {
      on: onIds.indexOf(e.id) > -1,
      // 卡片上的月度金额按显示货币换算
      amountText: moneyText(e.amount, 0)
    })
  )
  const on = list2.filter((i) => i.on)
  const year = on.reduce((s, i) => s + i.amount * 12, 0)
  return {
    list: list2,
    selectedIds: on.map((i) => i.id),
    selectedCount: on.length,
    yearText: moneyText(year, 0),
    monthText: moneyText(year / 12, 0)
  }
}

// 引导流：全部未勾选（与参考图 ¥0 状态一致）
function getOnboardingExpenses() {
  return ok(expenseVM(mock.expenses, []))
}

/* 我的 -> 生活支出设置：整份清单（含自定义项）持久化在本地 */

const EXPENSE_STORE_KEY = 'lifeExpenses'

function defaultLifeExpenses() {
  return mock.expenses
    .filter((e) => mock.selectedExpenseIds.indexOf(e.id) > -1)
    .sort((a, b) => a.sort - b.sort)
    .map((e) => ({ id: e.id, name: e.name, icon: e.icon, amount: e.amount, period: '月' }))
}

function readLifeExpenses() {
  const saved = wx.getStorageSync(EXPENSE_STORE_KEY)
  if (saved instanceof Array && saved.length) return saved
  return defaultLifeExpenses()
}

function writeLifeExpenses(list) {
  wx.setStorageSync(EXPENSE_STORE_KEY, list)
  store.markDirty()
}

function expenseStat(list) {
  const year = list.reduce((s, i) => s + (Number(i.amount) || 0) * 12, 0)
  return {
    count: list.length,
    yearText: moneyText(year, 0),
    monthText: moneyText(year / 12, 0)
  }
}

function getExpenses() {
  const list = readLifeExpenses()
  return ok(Object.assign({ list, icons: mock.expenseIcons }, expenseStat(list)))
}

// 编辑：整份清单回存
function saveExpenses(list) {
  if (!(list instanceof Array)) return fail('参数错误')
  writeLifeExpenses(
    list.map((i) => ({
      id: i.id,
      name: i.name,
      icon: i.icon,
      amount: Number(i.amount) || 0,
      period: i.period || '月'
    }))
  )
  return ok(true)
}

function removeExpense(id) {
  if (!id) return fail('缺少支出 ID')
  const list = readLifeExpenses().filter((i) => i.id !== id)
  writeLifeExpenses(list)
  return ok(Object.assign({ list }, expenseStat(list)))
}

// 添加自定义支出：名称 + 月度金额 + 图标
function addCustomExpense(payload) {
  const p = payload || {}
  const name = String(p.name || '').trim()
  const amount = Number(p.amount)
  if (!name) return fail('请填写名称')
  if (!amount || amount <= 0) return fail('请填写有效的月度金额')
  if (!p.icon) return fail('请选择一个图标')

  const list = readLifeExpenses().concat([
    { id: 'custom_' + Date.now(), name, icon: p.icon, amount, period: '月' }
  ])
  writeLifeExpenses(list)
  return ok(Object.assign({ list }, expenseStat(list)))
}

/* ================= 引导流 ================= */

function getOnboardingDemo() {
  const demo = clone(mock.onboardingDemo)
  const p = demo.preview
  const card = demo.predictCard
  const cp = demo.compound
  const foot = demo.planFooter

  return ok({
    slogan: demo.slogan,
    // 演示卡片：数值在这里按显示货币产出文案，页面不再拼 ¥
    preview: {
      name: p.name,
      icon: p.icon,
      market: MARKET_LABEL[p.market] || p.market,
      shares: util.group(p.shares, 0) + '股',
      cost: fixedText(p.cost, 2),
      yield: util.money(p.yield, 1) + '%',
      dividend: moneyText(p.dividend, 0)
    },
    predictCard: {
      totalText: moneyText(card.total, 0),
      receivedText: moneyText(card.received, 0),
      yieldText: util.money(card.yield, 1) + '%',
      nextPayText: card.nextPay
    },
    litChips: demo.litChips,
    unlitChips: demo.unlitChips,
    litCount: demo.litCount,
    chipTotal: demo.chipTotal,
    nextChip: demo.nextChip,
    compound: {
      nowText: wanText(cp.now),
      futureText: wanText(cp.future),
      years: cp.years,
      multiple: cp.multiple
    },
    tip: demo.tip,
    planFooter: {
      principalText: wanText(foot.principal),
      monthlyText: moneyText(foot.monthly, 0),
      rateText: foot.rate + '%'
    },
    steps: ['了解', '选支出', '定计划', '看蓝图'],
    expenses: expenseVM(mock.expenses, []).list
  })
}

// 逐项被买单的时间线：当年分红 >= 该项年支出
function buildTimeline(principal, monthly, rate, ids) {
  let assets = principal
  const r = rate / 100
  const real = []
  for (let i = 1; i <= 30; i++) {
    const dividend = assets * r
    assets = (assets + monthly * 12) * (1 + r)
    real.push({ year: i, total: assets, dividend })
  }

  const timeline = mock.expenses
    .filter((i) => ids.indexOf(i.id) > -1)
    .map((i) => {
      const need = i.amount * 12
      const hit = real.filter((y) => y.dividend >= need)[0]
      return {
        id: i.id,
        name: i.name,
        icon: i.icon,
        need,
        needText: moneyText(need, 0),
        year: hit ? hit.year : 0,
        yearText: hit ? 2026 + hit.year + '年达成' : '30年+',
        done: !!hit
      }
    })
    .sort((a, b) => (a.year || 99) - (b.year || 99))

  return { years: real, timeline }
}

/**
 * 预演收息蓝图
 * @param {Object} plan { principal, monthly, rate, ids }
 */
function previewPlan(plan) {
  const p = plan || {}
  const principal = Number(p.principal) || 0
  const monthly = Number(p.monthly) || 0
  const rate = Number(p.rate) || 0
  const ids = p.ids && p.ids.length ? p.ids : mock.selectedExpenseIds

  const target = mock.expenses
    .filter((i) => ids.indexOf(i.id) > -1)
    .reduce((s, i) => s + i.amount * 12, 0)

  const built = buildTimeline(principal, monthly, rate, ids)
  const last = built.years[built.years.length - 1]

  let percent = target ? (last.dividend / target) * 100 : 0
  if (percent > 100) percent = 100
  const rounded = Math.round(percent)

  return ok({
    targetYearText: moneyText(target, 0),
    targetMonthText: moneyText(target / 12, 0),
    finalAssetsText: wanText(last.total),
    coverPercent: rounded,
    coverTip: rounded >= 100 ? '按这个计划，30 年内就能全部覆盖' : '目标稍大，30 年内可覆盖 ' + rounded + '%',
    blueprint: built.years.map((y) => ({
      year: y.year,
      totalText: wanText(y.total),
      dividendText: moneyText(y.dividend, 2),
      label: 2026 + y.year + '年总资产'
    })),
    timeline: built.timeline
  })
}

function savePlan(plan) {
  if (!plan) return fail('缺少计划参数')
  return ok(clone(plan))
}

/* ================= 分红日历 ================= */

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function dayKey(y, m, d) {
  return y + '-' + util.pad(m) + '-' + util.pad(d)
}

/* ---------------- 日历事件：从用户自己的持仓推导 ----------------
 * mock.calendarEvents 是空的（没有真实数据源），光靠它日历页会一直是空的：
 * 日期上的小圆点、「下一笔分红月份」、当日明细全都没东西可显示。
 * 这里改为从真实持仓推导三类事件：
 *   股权登记 recordDate / 除权除息 exDate / 派息日 payDate（分红档案）
 *   加上用户自己记的到账记录（派息日）
 * 分红档案走网络，所以按标的缓存 10 分钟 —— 切月重绘时才不会每次都打接口。
 */
const CAL_FILE_TTL = 10 * 60 * 1000
const dividendFileCache = {}

function fileCacheKey(h) {
  return (h.code || '') + '@' + (h.market || '')
}

function fetchDividendCached(h) {
  const key = fileCacheKey(h)
  const hit = dividendFileCache[key]
  if (hit && Date.now() - hit.at < CAL_FILE_TTL) return Promise.resolve(hit.data)
  return quote
    .fetchDividend({ code: h.code, market: h.market })
    .catch(() => null)
    .then((d) => {
      // 取不到（网络抖一下 / 该市场没接口）时只短暂记住，
      // 否则一次失败就会让日历空上 10 分钟，翻月也一直是空的
      dividendFileCache[key] = {
        at: d ? Date.now() : Date.now() - (CAL_FILE_TTL - 30 * 1000),
        data: d
      }
      return d
    })
}

// 档案里有些日期是「尚未公布」这类文案，只认 yyyy-MM-dd
function normDate(v) {
  const s = String(v || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

function pushEvent(out, date, ev) {
  const key = normDate(date)
  if (!key) return
  ;(out[key] = out[key] || []).push(ev)
}

// 一条分红方案 -> 登记 / 除权 / 派息三个日期各落一个事件
function pushFileEvents(out, h, dividend) {
  const rate = 1 - effectiveTaxRate(h) / 100
  const list = (dividend && dividend.list) || []
  list.forEach((r) => {
    const amount = (Number(r.dps) || 0) * (Number(h.shares) || 0) * rate
    const ev = (type) => ({ code: h.code, name: h.name, type: type, amount: amount })
    pushEvent(out, r.recordDate, ev('股权登记'))
    pushEvent(out, r.exDate, ev('除权除息'))
    pushEvent(out, r.payDate, ev('派息日'))
  })
}

// 同步版：只用本地已有的数据（到账记录 + 已缓存的档案），切月时零延迟重绘
function localCalendarEvents() {
  const out = {}
  store.allHoldings().forEach((h) => {
    // 用户自己记的到账记录，按派息日排进日历
    ;(recordsOf(h.id).dividend || []).forEach((r) => {
      pushEvent(out, r.date, {
        code: h.code,
        name: h.name,
        type: '派息日',
        amount: Number(r.amount) || 0
      })
    })

    const hit = dividendFileCache[fileCacheKey(h)]
    if (hit && hit.data) pushFileEvents(out, h, hit.data)
  })
  return out
}

// 异步版：先把每只持仓的分红档案补齐（走缓存或网络），再整体算一遍
function calendarEventsAsync() {
  return Promise.all(store.allHoldings().map((h) => fetchDividendCached(h))).then(() =>
    localCalendarEvents()
  )
}

// 待对账 = 已公告但除权日还没到；nextKey 取其中最早的除权日
function noticeVM() {
  const today = todayKey()
  let count = 0
  let amount = 0
  let nextKey = ''

  store.allHoldings().forEach((h) => {
    const hit = dividendFileCache[fileCacheKey(h)]
    const list = (hit && hit.data && hit.data.list) || []
    const rate = 1 - effectiveTaxRate(h) / 100

    list.forEach((r) => {
      const ex = normDate(r.exDate)
      if (!ex || ex < today) return
      count++
      amount += (Number(r.dps) || 0) * (Number(h.shares) || 0) * rate
      if (!nextKey || ex < nextKey) nextKey = ex
    })
  })

  return { count: count, amount: amount, amountText: moneyText(amount, 2), nextKey: nextKey }
}

/**
 * 纯计算生成某月的日历格子（同步、无 IO）
 * 页面切换月份时先本地重绘，再异步补事件点，避免整页骨架屏闪烁。
 * @param {Object} q { year, month, todayKey, selectedKey }
 * @param {Object} events 可选，缺省时用本地已有的事件
 */
function buildMonthCells(q, events) {
  const year = Number((q && q.year) || 0) || new Date().getFullYear()
  const month = Number((q && q.month) || 0) || 1
  const todayKey = (q && q.todayKey) || ''
  const selectedKey = (q && q.selectedKey) || todayKey
  const src = events || localCalendarEvents()

  const offset = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const daysInPrev = new Date(year, month - 1, 0).getDate()

  const cells = []
  for (let i = offset - 1; i >= 0; i--) {
    cells.push({ key: 'p' + i, day: daysInPrev - i, outside: true })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = dayKey(year, month, d)
    cells.push({
      key: key,
      day: d,
      outside: false,
      isToday: key === todayKey,
      selected: key === selectedKey,
      // 当天的分红事件，日期格上的小圆点与选中后的明细都用它
      events: src[key] || null
    })
  }
  const rest = 42 - cells.length
  for (let i = 1; i <= rest; i++) {
    cells.push({ key: 'n' + i, day: i, outside: true })
  }

  return { title: year + '年' + month + '月', week: WEEK, cells: cells }
}

/**
 * 按月取日历数据（含分红事件）
 * @param {Object} q { year, month, todayKey, selectedKey }
 */
function getCalendar(q) {
  // 先补齐分红档案（命中缓存就是纯本地计算），再排日历
  return calendarEventsAsync().then((events) => {
    const base = buildMonthCells(q, events)
    return ok({
      title: base.title,
      week: base.week,
      cells: base.cells,
      legend: mock.calendarLegend,
      notice: noticeVM(),
      events: events
    })
  })
}

// 某天的分红事件
function getDayEvents(key, events) {
  const src = (events || localCalendarEvents())[key] || []
  return src.map((e) => ({
    code: e.code,
    name: e.name,
    type: e.type,
    amount: Number(e.amount) || 0,
    amountText: moneyText(e.amount, 2),
    tagClass: e.type === '派息日' ? 'tag-green' : e.type === '除权除息' ? 'tag-orange' : 'tag-blue'
  }))
}

/**
 * 年度总览：按年、按月汇总**真实的分红记录**。
 *
 * ⚠️ 这里返工过，原因值得留着：原来读的是 `mock.yearOverview` —— 那个对象里
 * 写死了 `received: 0` 和 12 个 0 的月份数组（mock.js 自己的注释也写着
 * "需要按真实分红记录逐月汇总后填充"）。也就是说**这个页面从来没接过真实数据**：
 * 用户记了分红，这里永远是 0。它不是"读错了字段"，是压根没读。
 *
 * 数据源取本地快照里的分红记录，**不**取服务端 —— 后者只是从快照解析出来的
 * 影子表，快照才是唯一权威源（理由见 autoRecordDividends 的说明）。
 *
 * ⚠️ 金额口径必须与 dividendVM 一致：记录里的 amount 是**本币**，先按持仓
 * 当下的汇率折成人民币，再交给 moneyText 走显示货币。两处口径不一致的话，
 * 同一个月在这页和详情页会显示成两个数。
 */
function getYearOverview(year) {
  const y = Number(year) || new Date().getFullYear()
  const all = readRecords()
  const months = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let total = 0

  Object.keys(all).forEach((hid) => {
    const rows = ((all[hid] || {}).dividend) || []
    if (!rows.length) return

    // 持仓可能已被删除或归档，那时取不到市场 —— 按汇率 1 处理。
    // 宁可少折一次，也不要为了一条历史记录让整页崩掉。
    const h = store.getHoldingAny(hid)
    const cny = h ? cnyPerUnitLive(h.market) : 1

    rows.forEach((r) => {
      const d = String((r && r.date) || '')
      if (d.slice(0, 4) !== String(y)) return
      const m = Number(d.slice(5, 7))
      if (!(m >= 1 && m <= 12)) return

      const amt = (Number(r.amount) || 0) * cny
      months[m - 1] += amt
      total += amt
    })
  })

  const max = Math.max.apply(null, months.concat([1]))

  return ok({
    year: y,
    receivedText: moneyText(total, 2),
    hasData: total > 0,
    months: mock.yearMonths.map((label, i) => {
      const value = months[i] || 0
      return {
        label,
        value,
        valueText: moneyText(value, 2),
        height: value > 0 ? Math.max(8, Math.round((value / max) * 100)) : 4,
        active: value > 0
      }
    })
  })
}

/* ================= 发现 ================= */

function getDiscover() {
  return ok({
    tools: mock.discoverTools,
    ranks: mock.discoverRanks,
    articles: mock.discoverArticles
  })
}

/* ================= 社区 ================= */

/**
 * 把后端返回的图片地址补成完整 URL。
 *
 * 后端存的是**站内相对地址**（/uploads/xxx.jpg）。这样做的原因在后端
 * 也有注释：同一台服务器有内网地址、测试域名、正式域名三个身份，
 * 服务端猜不准调用方是从哪一个进来的 —— 猜错就会被写进库里，
 * 换域名之后全站裂图。
 *
 * 所以由客户端拼上自己正在用的 API_BASE，两边都不会错。
 */
function articleImageURL(u) {
  const s = String(u || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  const base = String(cloud.API_BASE || '').replace(/\/+$/, '')
  return base + (s.charAt(0) === '/' ? s : '/' + s)
}

/* ---------------- 轻的那一份：@min ----------------
 * **只有首页卡片**用它。详情页（头图、正文插图）和放大浮层用的都是
 * **原图**，而且两者是同一个地址 —— 放大不会再去下一次别的图。
 *
 * 后端会给每张配图另存一份轻的，名字长这样（见 server-go/internal/api/uploads.go）：
 *
 *   /uploads/20260928-56529e50.png       原图（详情页 / 放大）
 *   /uploads/20260928-56529e50@min.jpg   压缩档
 *
 * ⚠️ `min` 是**标记**，不是尺寸：压缩档的像素尺寸与原图**完全一样**，
 * 只是重新编码成 JPEG。所以图上每一个字、每一根线都还在原来的位置 ——
 * 列表要解决的是"文件太大、下得慢"，不是"图太大"。
 *
 * ⚠️ 这两个常量必须与后端对齐（`minTag` 与 `variantExt`）：写错了不会有
 * 任何报错，只是那张图**悄悄地一直发原图**（后端认不出那个后缀），也就是白改。
 */
const MIN_TAG = 'min'
const MIN_EXT = 'jpg'

/**
 * 原图地址 → 压缩档的地址。
 *
 * 后缀固定是 .jpg：后端把这一档统一编成 JPEG —— 同尺寸下实测
 * 一张 1604×1119 的封面 1225 KB → **178 KB**，而卡片是列表里**每张图
 * 都要下一次**的位置。透明处会被合成到白底，卡片本身就是白底，看不出来。
 *
 * ⚠️ 会先把地址里可能已经带着的一档摘掉。同一个地址会在几处之间流传
 *（正文块里的 url 也是它），不处理就会出现 `x@min@min.jpg` 这种后端不认识的
 * 地址 —— 认不出来只能兜底发原图，而且不会有任何报错。
 *
 * ⚠️ 后端保证"生成不出来、或者压完没更小，就发原图"，所以这个地址永远
 * 拿得到图，最差只是这一次没变小（原图本来就只有三十几 KB 时就是这样）。
 */
function minImageURL(u) {
  const s = String(u || '').trim()
  if (!s) return ''

  // 摘掉已有的那一档（可能在扩展名之前，也可能整个地址没有扩展名）。
  // 旧版的 `@宽x高` 也要能摘掉：那一批地址可能还留在缓存里。
  const bare = s.replace(/@(min|\d+x\d+)(\.[A-Za-z0-9]+)?$/, '')
  const m = /^(.*?)\.[A-Za-z0-9]+$/.exec(bare)
  return articleImageURL((m ? m[1] : bare) + '@' + MIN_TAG + '.' + MIN_EXT)
}

/**
 * 把一个正文块转成 App 用的形状。
 *
 * 只做**地址补全**和字段改名，不改结构 —— 块的语义由后台定义
 * （见 server-go/internal/store/article.go 的 ArticleBlock），
 * 这里再解释一遍的话，两边迟早对不上。
 */
function articleBlock(b) {
  const t = (b && b.t) || 'p'
  if (t === 'img') {
    // 正文插图用**原图**：它铺满卡片宽，而放大浮层还要在同一张上再放
    // 两三倍 —— 缩过的图在那一档是糊的。放大不会另下一张，浮层用的
    // 就是这个地址。
    return { t: 'img', url: articleImageURL(b.url), caption: b.caption || '' }
  }
  if (t === 'tool') {
    return {
      t: 'tool',
      id: b.id,
      emoji: b.emoji || '🧮',
      title: b.name || '试试这个工具',
      desc: b.desc || ''
    }
  }
  if (t === 'poll') {
    // 字段名换成 App 里那套（question / options）：正文里内嵌的问卷块，
    // 和"整条内容就是一道题"（mock.js 里的 kind:'poll'）在界面上**是同一个
    // 东西**，这里改一次名，详情页就能用同一个函数画它们。
    //
    // counts 给空数组：那本数据是"别人投的票"，而正文里的问卷没有这个数据源
    //（票是本机记的，见 utils/poll.js），所以从 0 起算。给空数组而不是
    // 等长的 0 数组 —— stats 里是 `base[i] || 0`，缺位就是 0。
    return {
      t: 'poll',
      question: b.v || '',
      options: (b.options || []).slice(),
      counts: []
    }
  }
  if (t === 'h') return { t: 'h', v: b.v || '' }
  if (t === 'q') return { t: 'q', v: b.v || '' }
  return { t: 'p', v: (b && b.v) || '' }
}

/** 文章作者的色块。取一个不抢内容的浅蓝，与 mock 里那几种保持同一路数。 */
const AUTHOR_TINT = '#E4EDF8'

/**
 * 后端文章 → 首页信息流里的一条卡片。
 *
 * 为什么要在客户端做这层转换，而不是让后端直接吐 feed 的形状：
 * 后端的返回是**内容**（标题、正文、图片），而 feed 是**呈现**
 * （作者色块、日期分组标签、表态数）。让服务端去拼呈现，
 * 等于以后每改一次配色都要动后端；而且 App 有老版本在线上，
 * 服务端的返回形状一变，老版本立刻就崩。
 */
function articleToFeedItem(a) {
  const art = a || {}
  const body = (art.body || []).map(articleBlock)

  const item = {
    id: art.id,
    kind: 'article',
    date: art.date || '',
    topic: art.topic || '',
    // 作者色块由客户端按名字定，后台只填名字 —— 让运营挑颜色没有意义，
    // 而固定的几种浅色能保证与卡片底色都不打架。
    author: { name: art.author || '收息佬', tint: AUTHOR_TINT },
    title: art.title || '',
    excerpt: art.excerpt || '',
    body: body
  }

  // 排序与去重都用**原图地址**（`/uploads/xxx.png`），加尺寸后缀是最后一步。
  //
  // 反过来的话（拿 `xxx@200x200.png` 去比）同一张图的两个尺寸会被当成两张图 ——
  // 而"把正文第一张图同时设为封面"恰恰是常见做法，于是它会在那一排里出现两次。
  const rawCover = String(art.coverUrl || '').trim()
  const rawBody = (art.images || []).map((u) => String(u || '').trim()).filter(Boolean)

  // 卡片上那一排图 = **封面 + 正文插图**，顺序就是这个顺序（封面在最前）。
  //
  // 为什么合成**一个数组**：原来封面挂 cover、正文图挂 bodyImages，于是卡片成了
  // "上面一张大封面 + 下面一排正文图"。两组图各自独立，点封面只能看封面、
  // 点正文图只能看正文图 —— 而它们是同一篇里的图，用户想滑到下一张却滑不动。
  // 一组图一个数组，点哪张就从哪张开始左右滑（见 Community.renderThumbs）。
  //
  // ⚠️ `gallery[0]` 既是卡片上左起第一张，也是点开后左右滑的第一张。
  // 两处各排一次的话，改了一处就会出现"点第二张、看到的却是第一张"。
  //
  // ⚠️ 数据源是 art.images（服务端在**列表接口**里挑好的插图地址），**不是 art.body**。
  //
  // 这里踩过一次：最初写的是从 `art.body` 里筛 img 块，而**列表接口不返回 body**
  //（正文可能几十 KB，只传标题摘要）。于是首页永远拿不到正文图、卡片上只有封面 ——
  // 详情页却是好的（详情接口返回 body），所以看起来像"有时行有时不行"。
  // 现在由服务端把地址挑出来给列表用，见 server-go/internal/store/article.go 的 Images。
  const rawGallery = rawCover ? [rawCover].concat(rawBody.filter((u) => u !== rawCover)) : rawBody

  // 每个图位挂**两个地址**，但它们是"同一张图，一大一小"，不是两个尺寸档：
  //   url —— 压缩档（@min.jpg，尺寸与原图一样，只是文件小），卡片上用它
  //   big —— **原图**，点开放大时换上
  //
  // 为什么放大用原图而不是再存一档别的：放大这件事的全部意义就是看细节，
  // 而原图反正已经在库里、详情页本来就在用它 —— 放大只是把同一张再取一次，
  // 不多存任何东西、也不多一个要同步的档位。
  if (rawGallery.length) {
    item.gallery = rawGallery.map((u) => ({
      url: minImageURL(u),
      big: articleImageURL(u)
    }))
  }

  // 封面仍然单独留一份：详情页顶上那张"脸"取的是它（CommunityDetail 的 headPics）。
  //
  // 它与 gallery 不再是同一件事：`gallery` 是**卡片上那一排图**（封面 + 正文图），
  // `cover` 是**这篇的封面**。把正文图并进 gallery 的同时不能并进 images ——
  // 详情页顶上那一排取的正是 images / cover，塞进去的话正文图会在详情页
  // 再铺一排，和正文里那些插图重复。所以这里用的是新字段 gallery，不是 images。
  //
  // 用**原图**：它在详情页上是铺满卡片宽的头图，也是放大浮层的同一张 ——
  // 缩过的图在那一档（还要再放两三倍）是糊的。
  if (rawCover) item.cover = { url: articleImageURL(rawCover) }

  // ⚠️ 这里**不再**把文章正文里的投票挑到卡片上。
  //
  // 挑过一版（服务端给 Article.Poll、这里挂 pollBlock）：能显示，但那张卡片上
  // 会同时出现"文章标题 + 题目"两行加粗的字，下面还压着一排配图 ——
  // 三者互不相干，堆在一起很难看。
  //
  // 后来投票被抽成了**独立内容**（后台的「投票」页）：在首页上它是一张只有
  // 题目和选项的卡（见下面的 pollToFeedItem），不再借文章的壳。
  //
  // 老文章里那个 poll 块仍然会在**详情页**渲染（见 CommunityDetail.renderBody），
  // 只是不再爬到首页卡片上来了。

  // 回应数显式给 0。
  //
  // 不给的话 `renderReply` 会拼出「共 undefined 条回应」—— 这个 bug 上线过一次：
  // 后端文章的字段里没有 comments，而内置内容全都有，所以在合并成一条信息流之后
  // 只有后台发的文章会露出来。
  item.comments = 0

  return item
}

/**
 * 上报一票，返回**最新的统计**。
 *
 * 服务端投完直接回整条投票（含 counts / total），所以这里不用再拉一次列表 ——
 * 那样既慢，又可能拿到并发之前的旧数据。
 *
 * ⚠️ 未登录时**不发请求**，直接给一个 code=401 的错误：让调用方按
 * "没登录"处理（提示一句就去干自己的事），而不是按"网络失败"处理 ——
 * 后者会让人翻来覆去查网络，而问题根本不在这儿。
 *
 * ⚠️ 上报失败**不代表那一票不存在**：本机已经记下了（见 utils/poll.js），
 * 用户看到的界面是对的，只是这一票没进服务端统计。
 */
function votePoll(id, option) {
  // ⚠️ 只有**独立投票**才上报，它的 id 形如 p_xxx。
  //
  // 另外两种投票没有服务端存储，票只存在本机（与它们一直以来的行为一致）：
  //   · 内置的示例投票（mock 里的 c3 / c5）；
  //   · 老文章正文里那个 poll 块 —— 它就是一段正文，服务端根本没有这条投票。
  //
  // 不判断的话，用户每投一次都会打一个注定 404 的请求、再弹一句"投票失败"，
  // 而他什么也没做错。skipped 让调用方知道"这次没上报，别拿票数去覆盖界面"。
  if (String(id || '').indexOf('p_') !== 0) {
    return Promise.resolve(ok({ skipped: true }))
  }

  if (!cloud.isLoggedIn()) {
    return Promise.reject(fail('登录后这一票才会计入统计', 401))
  }
  return cloud.votePoll(id, option).then((body) => {
    const p = (body && body.data && body.data.poll) || null
    if (!p) return ok({ skipped: true })
    return ok({
      id: p.id,
      counts: p.counts || [],
      total: p.total || 0
    })
  })
}

/**
 * 后端的投票 → 首页信息流里的一条。
 *
 * 出来的是 `kind: 'poll'`，与内置的那种投票卡**完全同一种形状** ——
 * 于是首页和详情页那两套现成的投票渲染（Community.renderPoll /
 * CommunityDetail.renderPollCard）一行都不用改。
 *
 * ⚠️ 这里**不带"我投了哪一项"**：读接口是公开的，服务端不知道来的人是谁。
 * 那一半仍然由本机记（见 utils/poll.js），两边合起来才是完整的界面：
 * 服务端给"每一项有多少人投"，本机给"我投的是哪一项"。
 * 这也正是把投票独立出来的好处之一 —— 以前票数只能拿本机那一票假装。
 */
function pollToFeedItem(p) {
  const poll = p || {}
  const options = poll.options || []

  return {
    id: poll.id,
    kind: 'poll',
    date: poll.date || '',
    // 话题（可选）。
    //
    // ⚠️ 这里原来**写死成空串**，理由是"独立投票不属于任何话题"。那一版里
    // 后端确实没有这个字段，写死和"读一个永远为空的值"是同一件事。
    // 现在后端有了（article_poll.topic，见 migrations.sql 的 v6）—— 再写死，
    // 后台填了话题 App 上也不会显示，而且是那种查不出原因的"没反应"。
    //
    // 空串＝没设。卡片头那边会因此**整行不渲染**（见 Community.renderItemHead），
    // 不会留一个孤零零的「#」在那儿。
    topic: poll.topic || '',
    // 作者是署名。投票卡上不显示它（投票没有"作者"这个概念），给个兜底值。
    author: { name: poll.author || '收息佬', tint: AUTHOR_TINT },
    question: poll.question || '',
    // 补充说明（可选）：卡片上截断成几行、详情页完整显示。
    // 它是"题目下面那段解释"，不是正文 —— 所以即使长，也不改变卡片的形态。
    description: poll.description || '',
    options: options,
    // counts 必须与 options **等长**：App 是按下标取的（counts[i]），
    // 短了会取到 undefined，而结果态里那一项会显示成 0% ——
    // 看着像"没人选"，其实是数据缺了。服务端保证等长，这里再兜一次底。
    counts: options.map((_, i) => (poll.counts || [])[i] || 0),
    // voted 是**真实总票数**（所有人），不再是"我自己那一票" ——
    // 这是把投票独立出来最大的收获。
    voted: poll.total || 0,
    comments: 0
  }
}

/**
 * 首页信息流的排序：按日期倒序；同一天里投票排在文章后面。
 *
 * 为什么显式排序，而不是靠"拼起来的顺序"：文章和投票来自两个接口，
 * 谁拼在前取决于哪一次先回来 —— 那种"有时投票在上面、有时在下面"的抖动
 * 没人能解释，而且每刷新一次变一次。
 *
 * sort 是稳定的（ES2019 起），所以同日期同类别的会保持接口给的顺序
 *（服务端已经按权重排过）。
 */
function byDateDesc(a, b) {
  const da = String(a.date || '')
  const db = String(b.date || '')
  if (da !== db) return da < db ? 1 : -1

  const ka = a.kind === 'poll' ? 1 : 0
  const kb = b.kind === 'poll' ? 1 : 0
  return ka - kb
}

/**
 * 社区首页：一次把顶部那几个模块连同信息流一起给出去。
 *
 * 没有拆成多个接口，是因为社区首页是「进来就要全部显示」的形态 ——
 * 拆开只会让首屏出现逐块跳出来的阶梯感，用户看到的是页面在"长出来"。
 * 以后某个模块需要独立刷新（比如打卡人数要实时），再单独开接口也来得及。
 *
 * ══ 长文现在来自后端 ══
 *
 * 顶部那几个模块（话题、主推卡、打卡条、精选）以及**帖子与投票**仍是内置内容，
 * 只有长文（kind:'article'）改由后台的「首页文章」维护 ——
 * 这是后台目前能改的那一部分，也是运营最需要随时改的那一部分。
 * 所以这里是「后端的文章 + 内置的帖子/投票」拼起来，而不是二选一。
 */
function getCommunityFeed(opts) {
  const shell = {
    topics: mock.communityTopics,
    promo: mock.communityPromo,
    checkin: mock.communityCheckin,
    spotlight: mock.communitySpotlight
  }
  const builtin = () => ok(Object.assign({}, shell, { feed: mock.communityFeed }))

  // 拿不到远程数据时要不要退回内置示例内容（默认要）。
  //
  // ⚠️ **下拉刷新时一定要传 false**。
  //
  // 退回内置内容是为了"首屏绝不空着"（那是对的：没登录、断网、后端刚挂，
  // 用户看到几篇示例总比看到空白好）。但**刷新**是另一回事：用户手上
  // 已经有一份真实内容，这时悄悄把它换成示例，表现就是"运营刚发的文章
  // 不见了" —— 而且因为请求并没有真的抛错，页面上连一句提示都不会有。
  // 走刷新这条路的调用方要求"拿不到就报错"，页面才会保留原内容 + 弹提示
  //（见 screens/Community.js 的 fetch）。
  const fallback = !(opts && opts.fallback === false)

  // 本地存储还没就绪：用内置内容顶一下（开机瞬间的一两帧）。
  //
  // ⚠️ 这里**不能**要求"已登录"。
  //
  // 首页文章是**公开**内容（/api/community/articles 不校验登录，与 /api/config 同理），
  // 而首页又恰恰是未登录用户看到的第一屏。原先多写了一个 isLoggedIn() 判断，
  // 后果是：运营在后台发完一篇、在 App 上怎么看都没有 —— 得先登录才显示。
  // 排查时特别容易拐到"发布是不是没生效"上去，其实只是没登录。
  // 请求失败时照样退回内置内容，见下面的 catch。
  if (!cloud.enabled()) {
    return fallback ? builtin() : Promise.reject(fail('网络异常，请稍后重试'))
  }

  // 文章与投票**并行**拉。
  //
  // 投票那个失败不影响文章：它只是首页上的一部分卡片，少几张页面照样完整。
  // 反过来（因为投票挂了就让整个首页退回内置内容）代价太大 —— 运营会以为
  // "自己刚发的文章没生效"，而其实只是投票接口出了问题。
  return Promise.all([
    cloud.getCommunityArticles(),
    cloud.getCommunityPolls().catch((e) => {
      // ⚠️ 用 log 而不是 warn：这是**预期内的降级**（后端还没部署这个接口时
      // 必然发生），不是异常。用 warn 的话开发期每次进首页都弹一条 LogBox
      // 黄条，而它指向的事情"本来就是这样"—— 那种噪音会让人忽略掉真正的警告。
      console.log('[community] 读取投票失败，首页将只显示文章：' + ((e && e.msg) || e))
      return null
    })
  ])
    .then((res) => {
      const body = res[0]
      const pollBody = res[1]
      const list = (body && body.data && body.data.list) || []
      const pollList = (pollBody && pollBody.data && pollBody.data.list) || []

      // ⚠️ 请求**成功**时就用后端的列表，哪怕是空的。
      //
      // 空列表意味着"运营把文章都下架/删掉了"，首页就该真的没有长文 ——
      // 这时候再把内置那几篇示例文章冒出来，等于运营的删除操作没生效。
      // 只有请求失败（断网、后端挂了）才退回内置内容，见下面的 catch。
      const articles = list.map(articleToFeedItem)
      const polls = pollList.map(pollToFeedItem)
      const others = mock.communityFeed.filter((x) => x.kind !== 'article')

      // 顶部话题条**用后端下发的清单**（后台「话题标签」页维护的那一份）。
      //
      // 原先它是写死在这里的六个 mock 常量。后果是：运营给文章设了一个新话题，
      // 卡片上会显示「# 新话题」，可顶部筛不到它 —— 而且没有任何地方能补，
      // 因为那份清单在客户端里。
      //
      // ⚠️ 判据是"这个字段在不在"，**不是"它是不是空数组"**：
      //   · 字段缺失（老版本后端）→ 用内置那六个，接口升级不会把话题条弄空；
      //   · 返回了空数组（运营把标签都删了）→ 就真的是空的。
      //     那是运营的选择，不该被内置内容盖回去 —— 那就成了"删除不生效"。
      const d = (body && body.data) || {}
      const topics = Array.isArray(d.topics) ? d.topics : mock.communityTopics

      // 文章与投票混排成**同一条信息流**（按日期倒序），内置的帖子接在最后 ——
      // 它们没有真实日期，插进中间只会让"最近发生了什么"变得不可读。
      const merged = articles.concat(polls).sort(byDateDesc)

      return ok(Object.assign({}, shell, { topics: topics, feed: merged.concat(others) }))
    })
    // 失败时：首屏退回内置内容；刷新则把错误抛给调用方（见上面 fallback 那段）
    .catch((err) => (fallback ? builtin() : Promise.reject(err)))
}

/**
 * 社区详情：一条内容的完整正文 + 它的回应。
 *
 * 和 getArticle 一样返回整条记录 —— 正文里要用到话题、作者、时间、表态数，
 * 单独再查一次列表只为拿这几个字段不划算。
 *
 * 先查内置内容：帖子与投票目前还在 mock 里（见 getCommunityFeed 的说明），
 * 它们命中时不必发一次注定拿不到的请求。
 */
function getCommunityPost(id) {
  const item = mock.communityFeed.filter((x) => x.id === id)[0]
  if (item) return ok(Object.assign({}, item, { commentList: buildComments(item) }))

  if (!cloud.enabled()) return fail('内容不存在', 404)

  // 独立投票（id 以 p_ 开头）：它没有正文，就是题目 + 选项，但仍然要能被单独
  // 打开 —— 深链进来、或者下拉刷新之后手上没有列表数据，都得自己取一次。
  if (String(id || '').indexOf('p_') === 0) {
    return cloud.getCommunityPoll(id).then((body) => {
      const p = body && body.data && body.data.poll
      if (!p) return fail('内容不存在', 404)
      return ok(Object.assign({}, pollToFeedItem(p), { commentList: [] }))
    })
    // 失败不 catch 成"内容不存在"：断网时说那句会让人以为这条被删了，
    // 与下面文章那段同一个道理（见那段注释）。
  }

  return cloud
    .getCommunityArticle(id)
    .then((body) => {
      const art = body && body.data && body.data.article
      if (!art) return fail('内容不存在', 404)
      const it = articleToFeedItem(art)
      // 回应暂时没有真实的（评论还不落库），给空数组而不是让字段缺省 ——
      // 缺省时详情页那一段会渲染成 "undefined 条回应"
      return ok(Object.assign({}, it, { commentList: [] }))
    })
    // ⚠️ 这里的失败**不等于"内容不存在"**。
    //
    // 上面那行（art 为空）才是真的不存在；走到这里的是请求没成（断网、
    // 后端挂了、超时）。两种都说"内容不存在"的话，用户在电梯里点开一篇文章
    // 会看到"内容不存在"—— 他会以为这篇被删了，而这跟他的网络有关。
    // 所以把真实错误原样传出去（连 code 一起，402 那类还要走会员提示）。
    .catch((err) =>
      fail((err && err.msg) || '内容加载失败，请稍后重试', (err && err.code) || 0)
    )
}

/**
 * mock 阶段的评论池。
 *
 * 真实评论数据还没有，这里按条目 id **确定性地**取几条 ——
 * 关键是"确定性"：同一个 id 每次拿到的评论完全一样（不掺随机数），
 * 否则每次重进页面评论都在变，界面看起来像坏了，也没法截图核对。
 *
 * 接真实评论后，把 buildComments 换成按 postId 查表即可，调用方不用动。
 */
const COMMENT_POOL = [
  { name: '长线是金', tint: '#E4EDF8', text: '这条我存下来了，谢谢分享。', timeText: '2 小时前' },
  { name: '慢就是快', tint: '#E3F0E7', text: '看完去把自己的持仓也理了一遍，确实有几只是"说不清靠什么赚钱"的。', timeText: '5 小时前' },
  { name: '收息新人', tint: '#FBEFE0', text: '新手提问：如果只想先拿一笔小钱试试，一般从什么标的开始比较稳妥？', timeText: '昨天' },
  { name: '股息猎人', tint: '#F1E9F2', text: '同意，能说清楚赚钱逻辑的公司本来就不多，说不清就不买。', timeText: '昨天' },
  { name: '阿May', tint: '#F6EADA', text: '第三点戳到我了。以前总盯着股息率数字，从来没看过分红率。', timeText: '2 天前' },
  { name: '老张', tint: '#E9F0E9', text: '补充一句：看历史分红别只看最近三年，至少要跨过一个完整的周期。', timeText: '3 天前' }
]

function buildComments(item) {
  const n = Math.max(0, Math.min(Number(item.comments) || 0, 3))
  if (!n) return []

  // 起始位置由 id 决定：不同条目看到的是不同的几条，但同一条永远一样。
  // 用字符和而不是随机 —— 随机在这里只会带来"刷新一次变一次"的困惑。
  let seed = 0
  const s = String(item.id || '')
  for (let i = 0; i < s.length; i++) seed += s.charCodeAt(i)

  const out = []
  for (let i = 0; i < n; i++) {
    const c = COMMENT_POOL[(seed + i * 2) % COMMENT_POOL.length]
    out.push({
      key: item.id + '-' + i,
      name: c.name,
      tint: c.tint,
      text: c.text,
      timeText: c.timeText,
      likes: 3 + ((seed + i * 7) % 40)
    })
  }
  return out
}

/* ================= 我的 ================= */

// 当前登录用户的本地资料（注册 / 登录时写进 userInfo，跟着账号走）
function localUser() {
  const info = wx.getStorageSync('userInfo')
  return info && typeof info === 'object' ? info : {}
}

// 当前登录用户名：App 端不收集手机号，用户名就是唯一身份
function usernameOf() {
  return String(localUser().username || '').trim()
}

/**
 * 展示用昵称。
 *
 * 曾经「我的」页直接读 mock.user.nickName —— 那是个写死的"收息佬用户"，
 * 于是不管谁登录都显示同一个名字。真实昵称在注册 / 登录时就写进 userInfo 了
 * （见 Login.js 的 app.login({ nickName })，取的就是用户名）。
 *
 * 三层回退到默认值，保证任何情况下都有东西可显示：
 *   昵称 → 用户名 → 默认文案
 * 第二层不是多余的：早期版本的 userInfo 只存了 username，没存 nickName，
 * 那些用户升级上来昵称会是空的。
 */
function nickNameOf() {
  const u = localUser()
  return String(u.nickName || '').trim() || usernameOf() || '收息佬用户'
}

// 头像：目前只有默认 emoji，留成函数是为了和昵称同源，将来支持自定义头像时只改这里
function avatarOf() {
  return String(localUser().avatar || '').trim() || '👤'
}

function getProfile() {
  const src = coverageSource()
  const totalYear = src.reduce((s, i) => s + i.year, 0)
  const cur = readCurrency()
  const accounts = readAccounts()
  const active = accounts.filter((a) => a.active)[0]
  const mem = membership.current()

  // 免费开放期里，还没付费的人不再看到「升级解锁 / 去开通」这类引导；
  // 已付费的人照常显示自己的档位与到期时间（那是他们真实买过的东西）。
  const free = membership.freeForAll()
  const openAll = free && !mem.isPaid

  // 菜单右侧的 value 由当前设置实时回显，而不是写死在 mock 里
  const group1 = mock.profileMenus.group1.map((it) => {
    if (it.key === 'member') {
      return Object.assign({}, it, { value: openAll ? '全员免费开放' : membership.statusText() })
    }
    if (it.key === 'currency') return Object.assign({}, it, { value: cur.name + ' ' + cur.symbol })
    if (it.key === 'username') {
      // 登录账号：用户确认「我是谁」最直接的一项
      return Object.assign({}, it, { value: usernameOf() || '未知' })
    }
    if (it.key === 'account') {
      // 带上当前账户自己的持仓数：切完账户能立刻看出这是另一套账
      const mine = active
        ? store.allRows().filter((h) => String(h.accountId || '') === String(active.id)).length
        : 0
      return Object.assign({}, it, {
        value: active
          ? active.name + ' · ' + mine + ' 只持仓（共 ' + accounts.length + ' 个）'
          : '未设置'
      })
    }
    return it
  })

  return ok({
    // 昵称与头像取当前登录用户的真实资料，不用 mock 里那个写死的默认值 ——
    // 显示的是"谁在登录"，不是一份模板（见 nickNameOf 的说明）。
    // slogan 仍是全局文案，与用户无关。
    user: {
      nickName: nickNameOf(),
      avatar: avatarOf(),
      slogan: mock.user.slogan
    },
    // 会员状态：会员卡与「Pro」标记都读它，不再用写死的 user.isPro
    member: {
      tier: mem.tier,
      tierName: openAll ? '全员免费开放' : mem.tierName,
      // badge 是「我的」页顶部那个身份徽章的备选文案。档位判断全部由这里给出，
      // 页面不再自己从 tier 推导 —— 那种「两处各判一次」的写法迟早会跑偏。
      badge: openAll ? '免费' : mem.isPro ? '👑 Pro' : mem.isLite ? 'Lite' : '普通会员',
      isPaid: mem.isPaid,
      isPro: mem.isPro,
      isLite: mem.isLite,
      expired: mem.expired,
      expiresAt: mem.expiresAt,
      daysLeft: mem.daysLeft,
      statusText: openAll ? '当前所有功能对所有人免费开放' : membership.statusText(),
      // 免费期没有「去开通」：页面据此隐藏引导按钮
      cta: openAll ? '' : '去开通',
      tip: openAll
        ? '全部功能已解锁，无需开通'
        : mem.isPro
        ? 'Pro 权益已全部解锁'
        : mem.isLite
        ? 'Lite 已解锁无限持仓'
        : '升级解锁无限持仓 · 港股美股 · 多账户'
    },
    expenseCount: src.length,
    monthExpenseText: moneyText(totalYear / 12, 0),
    yearExpenseText: moneyText(totalYear, 0),
    // 备案号：留空时页面不渲染这一行（见 pages/profile/profile.wxml）
    icpNo: mock.appInfo.icpNo,
    group1,
    group2: mock.profileMenus.group2
  })
}

/* ================= 显示货币 ================= */

const CURRENCY_KEY = 'displayCurrency'

function readCurrency() {
  const code = wx.getStorageSync(CURRENCY_KEY) || 'CNY'
  return mock.currencyOptions.filter((c) => c.code === code)[0] || mock.currencyOptions[0]
}

function getCurrencyOptions() {
  const cur = readCurrency()
  return ok({
    current: cur.code,
    // 把「当前」直接写进文案，原生操作面板没有勾选态
    list: mock.currencyOptions.map((c) =>
      Object.assign({}, c, { label: c.name + ' ' + c.symbol + (c.code === cur.code ? '（当前）' : '') })
    )
  })
}

function saveCurrency(code) {
  const hit = mock.currencyOptions.filter((c) => c.code === code)[0]
  if (!hit) return fail('不支持的币种')
  wx.setStorageSync(CURRENCY_KEY, code)
  store.markDirty()
  return ok(hit)
}

/* ================= 会员 =================
 * 门禁统一在写操作里用 fail(msg, 402) 抛出，util.onError 会把 402 转成
 * 「去升级」弹窗 —— 所以各页面不必各自写一遍引导文案。
 */

// 金额文案：整数不带小数，非整数保留两位并去掉末尾的 0（¥98 / ¥59.6 / ¥0.27）
function priceText(n, d) {
  const v = Number(n) || 0
  const digits = d === undefined ? (v % 1 ? 2 : 0) : d
  const s = v.toFixed(digits)
  // 只在有小数点时才去掉末尾的 0 —— 否则 ¥40 会被截成 ¥4
  return '¥' + (s.indexOf('.') > -1 ? s.replace(/0+$/, '').replace(/\.$/, '') : s)
}

/**
 * 会员中心页的数据组装（同步）。
 * 权益表与方案本来就是本地定义，同步就能拿到 —— 页面必须先渲染出来，
 * 不能把「一进页面就有内容」押在一次异步请求上（请求慢了或抛错就是一片空白）。
 * 服务端那份只在后面覆盖档位与到期时间（见 syncMembership）。
 */
function membershipVM() {
  const cur = membership.current()
  // 免费开放期：状态文案、权益表说明与购买入口都要跟着变
  // （总闸在 utils/membership.js 的 FREE_FOR_ALL）
  const free = membership.freeForAll()
  const openAll = free && !cur.isPaid

  const features = mock.membershipFeatures.map((f) => ({
    name: f.name,
    free: f.free,
    lite: f.lite,
    pro: f.pro,
    // 还没上线的功能如实标注，避免「卖了会员却用不了」
    soon: f.ready === false
  }))

  const plans = mock.membershipPlans.map((p) => {
    const years = p.months / 12
    const isLite = p.tier === 'lite'
    // 划线价 = 按 1 年原价折算的时长总价，这样「省 ¥X」和「X 折」能互相印证
    const origin = Math.round(mock.membershipOriginPerYear * years)
    const perYear = p.price / years
    const perDay = p.price / ((p.months * 365) / 12)

    return {
      key: p.key,
      tier: p.tier,
      name: p.name,
      months: p.months,
      price: p.price,
      priceText: priceText(p.price),
      unit: p.months === 1 ? '/月' : '',
      // Lite 只有一行说明；Pro 写「折合 ¥X/年」，1 年档跟价格是同一个数就不重复写了
      subText: isLite || p.months === 12 ? '' : '折合 ' + priceText(perYear) + '/年',
      originText: isLite ? '' : priceText(origin),
      metaText: isLite
        ? p.note || ''
        : '约 ' +
          priceText(perDay, 2) +
          '/天 · 省 ' +
          priceText(origin - p.price) +
          ' · 相当于 ' +
          ((p.price / origin) * 10).toFixed(1) +
          ' 折',
      badge: p.badge || '',
      hot: !!p.hot,
      best: !!p.best,
      tip: p.tip || '',
      note: p.note || '',
      // 已开通的档位打个标，续费时一眼看到
      owned: cur.isPaid && cur.paidTier === p.tier
    }
  })

  const def = plans.filter((p) => p.hot)[0] || plans[0]

  return {
    status: {
      tier: cur.tier,
      tierName: openAll ? '全员免费开放' : cur.tierName,
      isPaid: cur.isPaid,
      isPro: cur.isPro,
      isLite: cur.isLite,
      expired: cur.expired,
      expiresAt: cur.expiresAt,
      daysLeft: cur.daysLeft,
      statusText: openAll ? '当前所有功能对所有人免费开放' : membership.statusText(),
      // 免费开放期不卖会员：否则等于为「本来就已经免费的功能」收钱
      selling: !free,
      // 这一行说的永远是「免费版」的限制，所以固定读免费档的额度 ——
      // 用当前档位会串成「最多 -1 只持仓」这种怪物
      freeText: openAll
        ? '持仓数量、港股美股、多账户等功能均已解锁，无需付费开通'
        : '免费版：最多 ' +
          mock.membershipLimits.free.holdings +
          ' 只持仓 · 不支持港股美股 · 多账户限 ' +
          mock.membershipLimits.free.accounts +
          ' 个'
    },
    // 权益表是「未来的档位规划」，免费期把标题说清楚，免得和实际行为矛盾
    tableTitle: free ? '档位权益规划（当前全员免费开放）' : '免费 · Lite · Pro 权益对比',
    tableNote: free
      ? '当前所有功能对所有人免费开放，无需开通；后续如调整档位会提前公告'
      : 'Lite 仅解锁无限持仓（不含港股美股）；Pro 解锁全部功能',
    tiers: mock.membershipTiers,
    features,
    plans,
    defaultPlanKey: def ? def.key : '',
    notes: mock.membershipNotes
  }
}

function getMembership() {
  return ok(membershipVM())
}

/**
 * 支付方式 + 「去哪买兑换码」的说明。
 *
 * 为什么单独一个异步接口，而不是并进 membershipVM()：
 * 那个是同步的，页面必须先渲染出来（不能把「一进页面就有内容」押在网络上）。
 * 这份文案只在服务端，要联网取；拿不到就用兜底文案，不能因此让整页空白。
 *
 * 也因此**失败不算错**：返回空的 guide，页面对它做降级处理。
 */
function getPayChannels() {
  // 里面的 try/catch 不是多余的：这层取的是「页面排版要用的辅助数据」，
  // 它不该有任何机会把整页带崩。真实踩过一次 —— cloud.getPayChannels
  // 忘了导出，于是这里同步抛 TypeError，而调用点在 onLoad 生命周期里，
  // release 包的表现就是**点进去直接闪退**。
  //
  // 也就是说：辅助数据要按辅助数据对待，失败退化成空，别让它有机会升级成崩溃。
  try {
    return cloud
      .getPayChannels()
      .then((res) => ok((res && res.data) || {}))
      .catch(() => ok({ channels: [], guide: null }))
  } catch (e) {
    console.warn('[pay] 读取支付方式失败：' + ((e && e.message) || e))
    return Promise.resolve(ok({ channels: [], guide: null }))
  }
}

// 兑换码：必须走服务端校验 —— 放在本地等于把码写死在小程序里
function redeemMembership(code) {
  const c = String(code || '').replace(/\s/g, '').toUpperCase()
  if (!c) return fail('请输入兑换码')

  return cloud
    .redeemMembership(c)
    .then((res) => {
      const m = (res && res.data && res.data.membership) || null
      // 同样存 paidTier：刚兑换完通常还没过期，两者相等；
      // 但口径必须和 syncMembership 一致 —— 同一个存储项被两种语义写过，
      // 迟早会出现"这次进页面有提示、下次没有"这种查不动的问题
      if (m) membership.write({ tier: m.paidTier || m.tier, expiresAt: m.expiresAt, source: '兑换码' })
      return ok(membership.current())
    })
    .catch((e) => fail((e && e.msg) || '兑换失败，请稍后重试'))
}

/**
 * 下单：服务端签好名，拿回「调起支付参数」交给对应的 SDK。
 *
 * channel 取 wxpay / alipay；不传则由服务端挑第一个已就绪的渠道。
 *
 * 两家回来的形状**不一样**（微信是 appid/prepayid 等 7 个字段，
 * 支付宝是一整串 orderStr），这里原样透传，由会员页按渠道交给各自的
 * SDK 封装。在这一层"统一格式"只会把两家的差异藏起来，
 * 等真出问题时反而更难查。
 *
 * 小程序那版要先 wx.login 换 session_key（虚拟支付要用它签用户态），
 * App 支付不需要 —— 签名全在服务端用商户私钥做，客户端只认方案 key。
 */
function createMembershipOrder(planKey, channel) {
  const plan = mock.membershipPlans.filter((p) => p.key === planKey)[0]
  if (!plan) return fail('请选择开通方案')

  return cloud
    .payPrepay(plan.key, channel)
    .then((res) => ok(res.data))
    .catch((e) => fail((e && e.msg) || '下单失败，请稍后重试'))
}

// 订单状态：官方明确说 requestVirtualPayment 的 success 回调可能丢失，
// 所以支付成功后要回来轮询，以服务端有没有发货为准
function getOrderStatus(outTradeNo) {
  if (!outTradeNo) return fail('缺少订单号')

  return cloud
    .getOrderStatus(outTradeNo)
    .then((res) => ok(res.data))
    .catch((e) => fail((e && e.msg) || '查询订单失败'))
}

/**
 * 降级宽限期的检查与执行。**必须在 syncMembership 之后调用** ——
 * 它读的是本地档位（刚被服务端结果覆盖过），顺序反了就会拿旧档位做判断。
 *
 * 三个阶段：
 *   1) 档位有效（含 Pro / Lite）→ 清除一切冻结。用户续费后回到 App 即恢复，
 *      不需要任何额外操作；
 *   2) 已过期但还在 7 天缓冲内 → **只提示，不动数据**；
 *   3) 缓冲期满 → 冻结超额部分（用户侧表现为消失，数据仍在，见 store.freezeExcess）。
 *
 * 单独成一个函数而不是并进 syncMembership：后者被会员页当作 boolean 用
 * （`.then((changed) => ...)`），改返回结构会牵动那一处。
 *
 * 返回 { show, phase, ... }，由 App 启动流程决定怎么提示。
 */
function notifyMembershipGrace() {
  const g = membership.graceState()

  // ① 档位有效：清掉可能残留的冻结
  if (!g.expired) {
    const n = store.unfreezeAll()
    return ok({ show: false, phase: '', restored: n })
  }

  const max = membership.limits().holdings
  if (membership.unlimited(max)) return ok({ show: false, phase: '' })

  // 在持 + 已冻结 = 这个账户实际持有的只数（allRaw 已排除冻结的）
  const total = store.allRaw().length + store.frozenRows().length

  // ② 缓冲期内：只提醒
  if (g.active) {
    const over = total - max
    if (over <= 0) {
      // 用户自己删到额度以内了 —— 没违规就不该继续收着
      store.unfreezeAll()
      return ok({ show: false, phase: '' })
    }
    return ok({
      show: true,
      phase: 'grace',
      daysLeft: g.daysLeft,
      deadline: g.deadline,
      over: over,
      max: max
    })
  }

  // ③ 缓冲期满：执行冻结
  store.freezeExcess(max)
  const frozen = store.frozenRows().length
  if (!frozen) return ok({ show: false, phase: '' })
  return ok({ show: true, phase: 'frozen', frozen: frozen, max: max })
}

/* ---------------- 临期提醒（过期前一周） ---------------- */

// 节流用的存储键：存「上次提示的日期」（yyyy-MM-dd）。
// 刻意不进 store.js 的云端同步列表 —— 它是本机状态，换设备再提示一次是合理的，
// 而同步过去会变成「这台点过知道了，那台就不提示了」。
const EXPIRE_NOTICE_KEY = 'expireNoticeDate'

/**
 * 会员即将到期的提示。返回 { show, daysLeft, expiresAt, tier, tierName }。
 *
 * 与 notifyMembershipGrace 的分工：
 *   · 这个 —— 还没过期，但一周内会到期，用户该做的是从容续费；
 *   · 那个 —— 已经过期，进入缓冲或已被收起，用户该做的是赶紧续。
 * 两者互斥：过期当天只可能命中后者（见 membership.expiringState 的注释）。
 *
 * ⚠️ 按天节流，同一天只提示一次。
 *
 * 不加节流会很难用：syncOnBoot 在冷启动**和**每次回前台都会跑，
 * 用户在几个 App 之间来回切两下就被连着弹三次。
 * 而提示一旦变成骚扰，用户会学会无脑点「知道了」—— 那时它连本来的作用都没了。
 *
 * 用「日期」而不是「提示过就不再提示」：剩余天数每天在变，
 * 昨天说"还有 7 天"、今天说"还有 6 天"是有意义的；
 * 而只弹一次，会让一周前随手瞄过一眼的用户再也收不到提醒。
 */
function notifyMembershipExpiring() {
  const e = membership.expiringState()
  if (!e.notice) return ok({ show: false })

  const today = membership.todayKey()
  if (String(wx.getStorageSync(EXPIRE_NOTICE_KEY) || '') === today) {
    return ok({ show: false, throttled: true })
  }

  wx.setStorageSync(EXPIRE_NOTICE_KEY, today)
  return ok({
    show: true,
    daysLeft: e.daysLeft,
    expiresAt: e.expiresAt,
    tier: e.tier,
    tierName: e.tierName
  })
}

// 启动时对齐：会员状态以服务端为准，本地只是缓存
function syncMembership() {
  if (!cloud.enabled()) return Promise.resolve(false)

  return cloud
    .getMembership()
    .then((res) => {
      const m = (res && res.data) || null
      if (!m) return false

      /**
       * ⚠️ 存的是 `paidTier`（实际买过的档位），**不是** `tier`。
       *
       * 服务端的 tier 是"当前生效档位"——过期它就会回 free。而本地这份缓存的
       * 语义是"用户买过什么"，过期与否由 expiresAt 本地判（见 membership.current）。
       *
       * 两者混用的后果不是显示错，而是**整条降级链路被短路**：
       * graceState() 用 `tier !== 'free'` 判断"曾经付费"，一旦被服务端的 free
       * 覆盖，这个条件永远为假 —— 于是宽限期提示不弹、冻结也不执行，
       * 用户看到的是"持仓还在但莫名其妙不能新增，且没有任何说明"。
       *
       * 后端 Status 里特意分了 tier / paidTier 两个字段就是为了这件事，
       * 这里不用它就等于白分了。
       */
      membership.write({
        tier: m.paidTier || m.tier,
        expiresAt: m.expiresAt,
        source: m.source || ''
      })

      // 桌面图标：曾经按档位切换（Pro 深色版 / 普通白色版），**已停用**。
      //
      // 原因见 appicon.js 的注释：Android 换图标必须启停 activity-alias，
      // 而那会销毁当前 Activity —— 用户看到的是「启动后界面闪一下重来」。
      // 为一次几乎不会发生的档位变化牺牲每次启动的观感，不划算。
      //
      // 这里改调 reset()：把可能还停在深色版的图标退回默认（停用之前
      // 用户也许已经被切过去了）。它幂等 —— 原生侧会判断当前是否已是默认，
      // 是的话不重建，所以每次启动都调也不会再出现那个闪动。
      appicon.reset()
      return true
    })
    .catch(() => false)
}

/* ================= 多账户 ================= */

const ACCOUNT_KEY = 'accounts'

function readAccounts() {
  const saved = wx.getStorageSync(ACCOUNT_KEY)
  const list = saved instanceof Array && saved.length ? saved : mock.accounts
  return list.map((a) => Object.assign({}, a, { active: a.id === readActiveAccountId(list) }))
}

function readActiveAccountId(list) {
  const saved = wx.getStorageSync('activeAccountId')
  const src = list || readAccounts()
  if (saved && src.filter((a) => a.id === saved).length) return saved
  const first = src.filter((a) => a.active)[0] || src[0]
  return first ? first.id : ''
}

function writeAccounts(list) {
  wx.setStorageSync(ACCOUNT_KEY, list)
  store.markDirty()
}

// 每个账户顺带给出自己名下的持仓数：删账户时要先说清楚会带走多少
function accountsWithCount(list) {
  const all = store.allRows()
  return list.map((a) =>
    Object.assign({}, a, {
      holdingCount: all.filter((h) => String(h.accountId || '') === String(a.id)).length
    })
  )
}

function getAccounts() {
  const list = readAccounts()
  return ok({ list: accountsWithCount(list), activeId: readActiveAccountId(list) })
}

function switchAccount(id) {
  if (!id) return fail('缺少账户 ID')
  if (!readAccounts().filter((a) => a.id === id).length) return fail('账户不存在')
  wx.setStorageSync('activeAccountId', id)
  // 持仓按 accountId 过滤，这里同步给 store，切完立刻按新账户出账
  store.setAccountId(id)
  // 当前账户也属于要跟着账号走的状态，标记一次让它同步上云
  store.markDirty()
  // 换账户了，行情缓存作废，进持仓页时按新账户那几只重刷
  holdingQuoteAt = 0
  return ok(accountsWithCount(readAccounts()))
}

// 新增账户：名称 + 用途说明
function addAccount(payload) {
  const p = payload || {}
  const name = String(p.name || '').trim()
  if (!name) return fail('请填写账户名称')

  // 会员门禁：账户数上限（免费 / Lite 为 1 个，Pro 为 10 个）
  const gate = membership.checkAccount(readAccounts().length)
  if (!gate.ok) return fail(gate.msg, 402)

  const list = readAccounts().map((a) => Object.assign({}, a, { active: false }))
  list.push({
    id: 'acc_' + Date.now(),
    name,
    broker: String(p.broker || '').trim() || '自定义账户',
    // 持有人写当前登录用户，不用那个写死的默认昵称 ——
    // 否则新建的每个账户都会被挂到"收息佬用户"名下
    holder: nickNameOf(),
    active: false
  })
  writeAccounts(list)
  return ok(list)
}

function removeAccount(id) {
  const list = readAccounts()
  if (list.length <= 1) return fail('至少保留一个账户')
  const next = list.filter((a) => a.id !== id)
  // 账户没了，它名下的持仓与流水也一起清掉，不留无主数据
  store.removeAccountHoldings(id)
  // 删掉的刚好是当前账户时，落到第一个账户
  if (wx.getStorageSync('activeAccountId') === id) {
    wx.setStorageSync('activeAccountId', next[0].id)
    store.setAccountId(next[0].id)
  }
  holdingQuoteAt = 0
  writeAccounts(next)
  return ok(accountsWithCount(next))
}

/* ================= 我的：文档 / 联系 / 注销 ================= */

function getStandardDoc() {
  return ok({ title: '数据口径说明', rows: mock.standardRows })
}

function getContactInfo() {
  return ok(mock.contactInfo)
}

function getLegalDoc(key) {
  const doc = mock.legalDocs[key]
  if (!doc) return fail('文档不存在', 404)
  return ok(Object.assign({ key }, doc))
}

/**
 * 注销账号：服务端删账号 + 业务数据，本机清到出厂状态。
 *
 * 两件都不能省：
 *   - 只清本地 → 下次登录会把云端数据原样拉回来；
 *   - 只清数据不删账号 → 用同一组用户名密码还能登回来，等于没注销。
 * 服务端失败就如实报错，不能让用户以为已经注销了。
 */
function destroyAccount() {
  if (!cloud.enabled()) return fail('云托管未启用，无法注销账号')

  return cloud
    .destroyAccount()
    .then(() => store.destroyUserData())
    .then(() => ok(true))
    .catch((e) => fail((e && e.msg) || '注销失败，请检查网络后重试'))
}

/* ================= 持仓：实时行情与派息口径刷新 =================
 * 进入持仓页 / 持仓详情页时调用，按 code + market 拉一次真实数据并回写本地持仓：
 *   price / priceDate —— 最新价，总市值、浮盈、股价息率跟着它走
 *   baseDps / dps     —— 最近一个完整财年的真实派息，按口径折算成税后每股派息
 * mock 里的 price / dps 只作首次尚未联网时的兜底快照。
 */
let holdingQuoteAt = 0

function refreshHoldingQuotes(force) {
  if (!force && Date.now() - holdingQuoteAt < LIVE_TTL) return Promise.resolve(0)

  // 在持的 + 已归档的都要刷：投资档案要拿「现价」算卖出至今涨跌，
  // 归档标的的现价若不更新，那个百分比会永远停在清仓那天 —— 而这恰恰
  // 是档案页唯一有信息量的数字。
  const list = store.allRaw().concat(store.rawArchived())
  if (!list.length) return Promise.resolve(0)

  // 一次批量请求拿齐所有持仓的行情 + 分红：
  // N 只持仓原来要 2N 次客户端请求（还会撞小程序 10 并发上限），现在只要 1 次；
  // 场外基金的净值与分红在服务端同源，也由同一个接口一并处理。
  return quote
    .fetchDetails(list.map((h) => ({ code: h.code, market: h.market, secid: h.secid || '' })))
    .catch(() => ({}))
    .then((map) => {
      let n = 0
      list.forEach((h) => {
        const entry = map[quote.batchKey(h)]
        const patch = {}

        const q = entry && entry.quote
        // 行情接口给的是**本币**价（港股港元、美股美元），快照也只存本币原值 ——
        // 两边同口径，直接比即可。这正是「只存原值」的好处：以前要先把行情折成
        // 人民币再和存储值比，汇率一动就被判成「价格变了」，白写一次库。
        const livePriceNative = Number(q && q.price) || 0
        if (q && q.price > 0 && livePriceNative !== nativeOf(h, 'price')) {
          patch.price = livePriceNative
          patch.priceNative = livePriceNative
          patch.priceDate = '实时行情 ' + (q.priceDate || todayKey())
        }

        const dpsPatch = holdingDpsPatch(h, entry && entry.dividend)
        if (dpsPatch) {
          if (dpsPatch.baseDps !== h.baseDps) {
            patch.baseDps = dpsPatch.baseDps
            patch.baseDpsNative = dpsPatch.baseDpsNative
          }
          if (dpsPatch.dps !== h.dps) {
            patch.dps = dpsPatch.dps
            patch.dpsNative = dpsPatch.dpsNative
          }
        }

        if (!Object.keys(patch).length) return
        // 用户新增的持仓直接改记录，内置持仓写一份本地覆盖补丁
        if (h.custom) store.updateAdded(h.id, patch)
        else store.patchBuiltin(h.id, patch)
        n++
      })
      holdingQuoteAt = Date.now()
      return n
    })
}

/* ================= 发现：榜单 / 文章 / 工具 ================= */

function withMarketLabel(item) {
  return Object.assign({}, item, {
    marketLabel: MARKET_LABEL[item.market] || item.market,
    cls: (MARKET[item.market] || MARKET.US).cls,
    valueText: util.money(item.value, 2)
  })
}

// 榜单条形：以榜首为 100%，最低保留 8% 保证可见
function boardRows(items, unit) {
  const max = Math.max.apply(null, items.map((i) => i.value).concat([1]))
  return items.map((item, i) =>
    Object.assign(withMarketLabel(item), {
      key: item.market + '-' + item.code,
      rank: i + 1,
      valueText: unit === '年' ? util.money(item.value, 0) : util.money(item.value, 2),
      width: Math.max(8, Math.round((item.value / max) * 100)),
      top3: i < 3
    })
  )
}

// 权重榜：按自由流通市值占比归一（港股已折人民币）
function weightedRows(pool) {
  const total = pool.reduce((s, i) => s + i.capCny, 0)
  if (!total) return []
  return pool
    .map((i) => Object.assign({}, i, { value: (i.capCny / total) * 100 }))
    .sort((a, b) => b.value - a.value)
}

/**
 * 榜单：成员名单来自 mock.rankBoards[type].codes（编辑侧精选），
 * 数值全部由「实时行情 + 真实分红记录」现算：
 *   yield  税后股价息率（%）  years  连续分红年数（年）  weight  自由流通市值加权占比（%）
 */
function getRank(type) {
  const board = mock.rankBoards[type]
  if (!board) return fail('榜单不存在', 404)

  return buildLiveList(board.codes)
    .then((pool) => {
      let rows
      if (board.metric === 'years') {
        rows = pool.filter((i) => i.live && i.years > 0).sort((a, b) => b.years - a.years)
      } else if (board.metric === 'weight') {
        rows = weightedRows(pool.filter((i) => i.live && i.capCny > 0))
      } else {
        rows = pool.filter((i) => i.live && i.value > 0).sort((a, b) => b.value - a.value)
      }

      if (!rows.length) return fail('行情获取失败，请稍后重试')

      return ok({
        id: board.id,
        name: board.name,
        icon: board.icon,
        badge: board.badge,
        unit: board.unit,
        note: board.note,
        list: boardRows(
          board.metric === 'years'
            ? rows.map((i) => Object.assign({}, i, { value: i.years }))
            : rows,
          board.unit
        )
      })
    })
    .catch((e) => fail((e && e.msg) || '行情获取失败，请稍后重试', (e && e.code) || 0))
}

function getArticle(id) {
  const meta = mock.discoverArticles.filter((a) => a.id === id)[0]
  const body = mock.articleBodies[id]
  if (!meta || !body) return fail('文章不存在', 404)

  return ok({
    id,
    title: meta.title,
    tag: meta.tag,
    read: meta.read,
    icon: meta.icon,
    updated: '2026-08-20',
    body: body.body
  })
}

// 定投回测的候选池：与息率对比同源，页面先异步取一次，再交给同步的 previewDca
function ensureYieldPool() {
  return buildLiveList(mock.yieldCompareCodes)
    .then((pool) => pool.filter((i) => i.live && i.value > 0).sort((a, b) => b.value - a.value))
    .then((pool) => (pool.length ? pool : fail('行情获取失败，请稍后重试')))
    .catch((e) => fail((e && e.msg) || '行情获取失败，请稍后重试', (e && e.code) || 0))
}

// 息率对比：跨市场横向拉平，息率实时计算，条形宽度对榜首归一
function getYieldCompare() {
  return ensureYieldPool()
    .then((pool) => {
      const max = Math.max.apply(null, pool.map((i) => i.value).concat([1]))
      return ok({
        note: '税后股价息率 = 上一个完整年度的每股派息 ÷ 最新股价（港股按默认 20% 红利税折算，持仓里可逐只调整），随行情实时计算。',
        list: pool.map((item, i) =>
          Object.assign(withMarketLabel(item), {
            key: item.market + '-' + item.code,
            rank: i + 1,
            width: Math.max(8, Math.round((item.value / max) * 100))
          })
        )
      })
    })
    .catch((e) => fail((e && e.msg) || '行情获取失败，请稍后重试', (e && e.code) || 0))
}

// 跨市场关键字搜索：发现页用，不限市场，走真实行情搜索接口
function searchAllStocks(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return ok([])

  return quote
    .search(kw)
    .then((list) => ok(list.map(stockBriefVM)))
    .catch((e) => fail((e && e.msg) || '搜索失败，请稍后重试', (e && e.code) || 0))
}

/* ================= 复利 / 定投回测（同步纯计算） ================= */

/**
 * 定投 + 一次性本金 的复利终值。
 * 收益按月复利、月供在月末投入，是理财计算器的通行口径。
 */
function compoundValue(principal, monthly, rate, years) {
  const r = rate / 100 / 12
  const n = Math.max(1, Math.round(years * 12))
  const grow = Math.pow(1 + r, n)
  const fromPrincipal = principal * grow
  const fromMonthly = r > 0 ? monthly * ((grow - 1) / r) : monthly * n
  const invested = principal + monthly * n

  return {
    finalValue: fromPrincipal + fromMonthly,
    invested,
    gain: fromPrincipal + fromMonthly - invested,
    rate: invested > 0 ? ((fromPrincipal + fromMonthly - invested) / invested) * 100 : 0
  }
}

function previewCompound(params) {
  const p = params || {}
  const d = mock.compoundDefaults
  const principal = Number(p.principal) || d.principal
  const monthly = Number(p.monthly) || 0
  const rate = Number(p.rate) || 0
  const years = Math.min(d.maxYears, Math.max(1, Number(p.years) || d.years))

  const total = compoundValue(principal, monthly, rate, years)

  // 抽样出展示用的年度曲线：年数多时只取 6 个点，避免柱子挤成一团
  const step = Math.max(1, Math.ceil(years / 6))
  const curve = []
  for (let y = step; y <= years; y += step) {
    const c = compoundValue(principal, monthly, rate, y)
    curve.push({ label: y + '年', value: c.finalValue, valueText: amountText(c.finalValue) })
  }
  if (curve[curve.length - 1] && curve[curve.length - 1].label !== years + '年') {
    const c = compoundValue(principal, monthly, rate, years)
    curve.push({ label: years + '年', value: c.finalValue, valueText: amountText(c.finalValue) })
  }

  const max = Math.max.apply(null, curve.map((i) => i.value).concat([1]))
  curve.forEach((i) => {
    i.height = Math.max(6, Math.round((i.value / max) * 100))
  })

  return {
    principal,
    monthly,
    rate,
    years,
    // 滑块旁的数值文案由这里产出，页面不再自己拼金额
    principalText: moneyText(principal, 0),
    monthlyText: moneyText(monthly, 0),
    finalText: moneyText(total.finalValue, 2),
    investedText: moneyText(total.invested, 2),
    gainText: moneyText(total.gain, 2),
    rateText: util.money(total.rate, 1),
    multipleText: util.money(total.invested ? total.finalValue / total.invested : 0, 2),
    curve
  }
}

/**
 * 持仓页「20 年可达 X 倍」：以当前总成本为本金，按「成本息率 + 长期股息增长 3%」
 * 作为年化、分红全部再投入，推演 20 年后的资产倍数。
 */
const DIVIDEND_GROWTH = 3

function returnProjection(rate) {
  const years = 20
  const y = (Number(rate) || 0) / 100 + DIVIDEND_GROWTH / 100
  const multiple = Math.pow(1 + y, years)

  return {
    multiple,
    multipleText: util.money(multiple, 1),
    years,
    annualRateText: util.money((Number(rate) || 0) + DIVIDEND_GROWTH, 2),
    dividendGrowth: DIVIDEND_GROWTH
  }
}

/**
 * 定投回测：逐月买入、每年把分红按当年市价再投入。
 * 息率不写死：由调用方传入实时算好的候选池（api.ensureYieldPool），
 * 取池中该标的的税后股价息率；股价年增长是演示用的简化假设。
 * pool 为空时返回 null，页面据此给出重试提示。
 */
function previewDca(params, pool) {
  const src = (pool || []).slice().sort((a, b) => b.value - a.value)
  if (!src.length) return null

  const p = params || {}
  const d = mock.dcaDefaults
  // 候选标的直接用息率对比那份清单，息率即为该标的的税后股价息率
  const stock = src.filter((s) => s.code === p.code)[0] || src[0]

  const monthly = Number(p.monthly) || d.monthly
  const years = Math.min(30, Math.max(1, Number(p.years) || d.years))
  const yieldRate = stock.value
  const growth = d.priceGrowth

  // 起始价用 1 元，最终只关心相对收益，与真实股价无关
  let price = 1
  let shares = 0
  let invested = 0
  let dividendTotal = 0
  const rows = []

  for (let y = 0; y < years; y++) {
    let yearDividend = 0
    for (let m = 0; m < 12; m++) {
      const buy = monthly / price
      shares += buy
      invested += monthly
    }
    yearDividend = shares * price * (yieldRate / 100)
    dividendTotal += yearDividend
    // 分红按当年市价再投入
    shares += yearDividend / price

    rows.push({
      year: y + 1,
      label: y + 1 + '年',
      invested: invested,
      investedText: moneyText(invested, 0),
      shares: shares,
      sharesText: util.group(shares, 0),
      value: shares * price,
      valueText: moneyText(shares * price, 0),
      dividendText: moneyText(dividendTotal, 0)
    })

    price = price * (1 + growth / 100)
  }

  const last = rows[rows.length - 1] || { value: 0, shares: 0 }
  const finalValue = last.value
  const gain = finalValue - invested
  const max = Math.max.apply(null, rows.map((r) => r.value).concat([1]))
  rows.forEach((r) => {
    r.height = Math.max(6, Math.round((r.value / max) * 100))
  })

  // 年化收益率：用期末市值反推
  const annual = invested > 0 && years > 0 ? (Math.pow(finalValue / invested, 1 / years) - 1) * 100 : 0

  return {
    code: stock.code,
    name: stock.name,
    market: stock.market,
    marketLabel: MARKET_LABEL[stock.market] || stock.market,
    monthly,
    years,
    yieldRate,
    yieldText: util.money(yieldRate, 2) + '%',
    priceGrowth: growth,
    monthlyText: moneyText(monthly, 0),
    pool: src.map((s) =>
      Object.assign({}, s, {
        marketLabel: MARKET_LABEL[s.market] || s.market,
        cls: (MARKET[s.market] || MARKET.US).cls,
        valueText: util.money(s.value, 2)
      })
    ),
    investedText: moneyText(invested, 0),
    dividendText: moneyText(dividendTotal, 0),
    valueText: moneyText(finalValue, 0),
    gainText: moneyText(gain, 0),
    gainRateText: util.money(invested ? (gain / invested) * 100 : 0, 1),
    annualText: util.money(annual, 1),
    sharesText: util.group(last.shares || 0, 0),
    hasProfit: gain >= 0,
    rows
  }
}

/* ================= 持仓详情：交易明细 / 分红记录 / 分红档案 ================= */

// 交易 / 分红记录已交给 store 统一管理（本地快照 + 云端同步）
function readRecords() {
  return store.readRecords()
}

function writeRecords(all) {
  store.writeRecords(all)
}

function recordsOf(id) {
  const all = readRecords()
  return all[id] || { trade: [], dividend: [] }
}

/* ---------------- 持仓 = 建仓基准 + 全部交易明细 ----------------
 * 交易明细不只是流水：买入 / 卖出 / 送股会真实改变持仓的股数与摊薄成本。
 * 这里统一按「建仓基准 + 全部明细」整体重算，而不是在原值上做加减 ——
 * 删除记录能自然回退，反复增删也不会累积浮点误差。
 */

// 交易类型 -> 对持仓的影响
//   buy  股数与投入一起加，成本按加权平均（分红复投本质就是用分红再买）
//   sell 只减股数，摊薄单价不变
//   free 送股 / 转送股：股数白得，投入总额不变 → 单价被摊薄
const TRADE_EFFECT = {
  买入: 'buy',
  分红复投: 'buy',
  卖出: 'sell',
  送股: 'free',
  转送股: 'free'
}

/**
 * 建仓基准：首次由交易改动持仓时冻结下来，
 * 这样交易明细第一行（建仓记录）之后就不会跟着持仓一起变了。
 * 还没冻结过（刚建仓 / 老数据）时，当前持仓就是基准 —— 因为在此之前交易并没有改过持仓。
 */
function seedBaseOf(h) {
  const frozen = h && h.seedShares !== undefined && h.seedShares !== null
  // 基准成本一律取**本币原值** —— 快照里 cost 与 costNative 现在同为本币，
  // 但冻结过的那份只有 seedCostNative 是权威的
  const costNative = frozen ? nativeOf(h, 'seedCost') : nativeOf(h, 'cost')
  return {
    shares: Number(frozen ? h.seedShares : h.shares) || 0,
    cost: costNative,
    costNative: costNative,
    date: String((frozen ? h.seedDate : h.buyDate) || '')
  }
}

// 从建仓基准 + 全部交易明细重算股数与摊薄成本（按日期先后顺序算）
function positionOf(h, trades) {
  const seed = seedBaseOf(h)
  const market = (h && h.market) || 'A'
  const list = (trades || [])
    .slice()
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))

  // 两个口径并行推进，值相同（存储只保留本币原值），分开写是为了
  // 让「本币原值」这条主线在代码里始终显眼
  const seedFee = nativeOf(h, 'fee')
  let shares = seed.shares
  let cost = seed.cost
  let costNative = seed.costNative

  // 建仓时填的手续费也要算进投入 —— 它和那笔买入是一体的。
  // 以前这里只从交易明细取 fee，建仓那笔的手续费被整个丢掉了，
  // 用户看到的就是「我填了手续费，成本却按没填算」。
  if (seed.shares > 0 && seedFee > 0) {
    // 摊到这 seed.shares 股上，等价于「每股成本 + 手续费 ÷ 股数」
    cost += seedFee / seed.shares
    costNative += seedFee / seed.shares
  }

  list.forEach((t) => {
    // baked = 已被「重置建仓基准」计入基准的那部分历史交易，不再重复作用一次
    if (t.baked) return

    const n = Number(t.shares) || 0
    if (!(n > 0)) return

    const kind = TRADE_EFFECT[t.type] || 'buy'

    if (kind === 'sell') {
      // 卖出：只减股数，单价不变（最多卖到 0）
      shares = Math.max(0, shares - n)
      return
    }

    const total = shares + n
    if (total > 0) {
      const price = Number(t.price) || 0
      const fee = Number(t.fee) || 0
      // 记录上的本币原值；老记录没存过，由 nativeOf 按记账汇率反算兜底
      const priceNative = nativeOf(t, 'price', market)
      const feeNative = nativeOf(t, 'fee', market)

      cost =
        kind === 'free'
          ? // 送股不花钱：投入总额不变，单价被摊薄
            (cost * shares) / total
          : // 买入 / 分红复投：投入按股数加权，手续费计入成本
            (cost * shares + n * price + fee) / total

      costNative =
        kind === 'free'
          ? (costNative * shares) / total
          : (costNative * shares + n * priceNative + feeNative) / total
    }
    shares = total
  })

  return {
    shares,
    cost: Number(cost.toFixed(6)),
    costNative: Number(costNative.toFixed(6))
  }
}

// 写回持仓。内置持仓与用户新增持仓在 store 里已经是同一条路，这里给个统一入口。
//
// 取行必须用 getRawAny（含已归档）：归档标的的现价刷新、事后补写清仓心得
// 都要写回这一行。用 getRaw 的话归档行取不到 → 直接 return null，
// 调用方毫无察觉地丢掉这次写入。
function writeHoldingPatch(id, patch) {
  const cur = store.getRawAny(id)
  if (!cur) return null
  if (cur.custom) store.updateAdded(id, patch)
  else store.patchBuiltin(id, patch)
  return store.getHoldingAny(id)
}

// 把交易明细的影响落到持仓上（首次改动时顺手把建仓基准冻下来）
function applyTradesToHolding(h, trades) {
  const pos = positionOf(h, trades)
  const patch = { shares: pos.shares, cost: pos.cost, costNative: pos.costNative }

  if (h.seedShares === undefined || h.seedShares === null) {
    patch.seedShares = Number(h.shares) || 0
    // 冻结的基准成本同样取本币原值（h.cost 已被 decorate 按实时汇率折过，
    // 拿它当基准会让基准跟着汇率漂）
    patch.seedCost = nativeOf(h, 'cost')
    patch.seedCostNative = nativeOf(h, 'cost')
    patch.seedDate = h.buyDate || ''
  }

  return writeHoldingPatch(h.id, patch)
}

// 已收分红 = 全部到账记录的合计。增删都整体重算，删除记录自然回退。
//
// ⚠️ 必须**同时写 received 和 receivedNative**，这是踩过的坑，值得写清楚：
//
// 本文件上面的迁移逻辑把这两个字段统一成了同一个口径（本币原值），
// 并且留了注释「迁移后 xxx 与 xxxNative 同为本币，读取路径统一」——
// 也就是说它们**约定要同步**。
//
// 而 store.decorate 里的 nativeVal 是**优先读 xxxNative**、没有才回落 xxx。
// 原来这里只写 received，于是记完一笔分红之后：
//
//	· 服务端那一列（它读快照里的 received）是对的，比如 2112
//	· App 里显示的一直是 0 —— nativeVal 读到的是迁留下来的 receivedNative: 0
//
// 两个字段一个写、一个读，就永远对不上；而且从任何一边看都像"另一边的问题"
//（App 像是没数据，服务端像是没问题）。建仓时不会踩到，因为那时
// receivedNative 还不存在，nativeVal 会回落到 received —— 只有"更新一个
// 早就存在 receivedNative 的持仓"时才会中招。
function applyDividendsToHolding(h, dividends) {
  const sum = (dividends || []).reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const v = Number(sum.toFixed(2))
  return writeHoldingPatch(h.id, { received: v, receivedNative: v })
}

/**
 * 修正所有持仓的「累计已收」两个字段 —— 一次自愈。
 *
 * ⚠️ 存在的理由：修好 applyDividendsToHolding 的**写入**，并不能修好**已经
 * 写坏的那批快照** —— 它们的 received 是对的，receivedNative 还停在旧值
 *（通常就是 0），而 store.decorate 优先读后者，所以界面上依旧是 0。
 * 从分红记录整体重算一遍，两者就回到同一个数上。
 *
 * ⚠️ 只在值**不一致**时才写。每次启动都无脑写的话，会白标 dirty、
 * 白推一次快照 —— 而快照是整份上传的（几 KB 到几 MB），那个代价不小。
 *
 * ⚠️ 比的是**原始字段**（store.getRawAny 那份），不是 decorate 之后的
 * 视图对象：后者已经乘过汇率，拿它比对会永远"不相等"，于是每次都写。
 *
 * 返回修正了几只。
 */
function healReceived() {
  let fixed = 0

  ;(allHoldingsSafe() || []).forEach((h) => {
    if (!h || !h.id) return

    const raw = store.getRawAny(h.id)
    if (!raw) return

    const sum = (recordsOf(h.id).dividend || []).reduce((s, r) => s + (Number(r.amount) || 0), 0)
    const want = Number(sum.toFixed(2))

    if (Number(raw.received) === want && Number(raw.receivedNative) === want) return

    writeHoldingPatch(h.id, { received: want, receivedNative: want })
    fixed++
  })

  if (fixed) console.warn('[store] 修正了 ' + fixed + ' 只持仓的累计已收（received/receivedNative 不一致）')
  return fixed
}

/**
 * 重置建仓基准：把当前持仓当作新的起点，已有交易明细只作流水展示。
 * 用在「用户曾经为了让数字对上，手动改过持仓股数」的情况 ——
 * 否则下一次增删交易时，整体重算会把那些交易的量再加一遍。
 */
function resetSeedBase(id) {
  const raw = store.getRaw(id)
  if (!raw) return fail('未找到该持仓', 404)

  const h = store.getHolding(id)

  // 1. 明细先打上 baked 标记：这些量已经包含在新基准里了，不再参与重算
  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.trade = (cur.trade || []).map((t) => Object.assign({}, t, { baked: true }))
  all[id] = cur
  writeRecords(all)

  // 2. 再把当前持仓冻结成新的建仓基准
  // 基准里只放「用户填的成本」，手续费单独留在 fee 字段上由 positionOf 摊 ——
  // 而此刻 h.cost 已经含过手续费了，所以这里要先把 fee 减掉，否则重算时
  // positionOf 会再摊一次，成本凭空膨胀。
  const seedCost = Number((nativeOf(h, 'cost') - (nativeOf(h, 'fee') || 0) / (Number(h.shares) || 1)).toFixed(6))

  writeHoldingPatch(id, {
    seedShares: Number(h.shares) || 0,
    seedCost: seedCost,
    seedCostNative: seedCost,
    seedDate: h.buyDate || ''
  })

  return getHoldingRecords(id)
}

// 交易明细：把持仓本身的买入信息折算成第一条记录
// 交易类型 -> 标签配色：买入绿 / 卖出橙 / 送股&转送股金 / 分红复投蓝
const TRADE_TAG_CLASS = {
  买入: 'tag-green',
  卖出: 'tag-orange',
  转送股: 'tag-gold',
  送股: 'tag-gold',
  分红复投: 'tag-blue'
}

function tradeVM(h) {
  const market = h.market || 'A'
  // 首行用「建仓基准」而不是当前持仓：否则加完交易，这条历史记录会跟着一起变
  const base = seedBaseOf(h)
  // 建仓那行的手续费取持仓上的 fee（当初建仓时填的）——
  // 写死成 0 会让人以为这笔钱没算进成本，其实它算进去了，只是没显示
  const seedFee = nativeOf(h, 'fee')
  const seed = {
    id: 'seed-' + h.id,
    date: base.date,
    type: '买入',
    shares: base.shares,
    price: base.cost,
    priceNative: base.costNative,
    fee: seedFee,
    feeNative: seedFee,
    seed: true
  }
  const extra = recordsOf(h.id).trade || []
  const list = [seed].concat(extra)

  return list
    .map((r) => ({
      id: r.id,
      date: r.date || '—',
      type: r.type,
      typeClass: TRADE_TAG_CLASS[r.type] || 'tag-green',
      sharesText: util.group(r.shares, 0) + '股',
      // 成交价与手续费是「这只股票的价格」，按本币显示（与行情、券商对账单一致）；
      // 成交金额是资产类数字，按显示货币走
      priceText: nativeOfText(r, 'price', market, 4),
      // r.price 已是本币，成交金额是资产类数字：先折人民币，再按显示货币呈现
      amountText: moneyText(
        (Number(r.shares) || 0) * (Number(r.price) || 0) * cnyPerUnitLive(market),
        2
      ),
      feeText: nativeOfText(r, 'fee', market, 2),
      // 当时的想法：清仓那笔尤其值得陈列出来
      note: String(r.note || '').trim(),
      seed: !!r.seed
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

// 分红记录：用户添加的到账记录 + 由持仓 received 汇总
function dividendVM(h) {
  // ⚠️ 这一行是**补的**，漏它的后果值得记下来。
  //
  // 原来这里直接用了下一段里的 `market`，但那是**同文件另一个函数
  // （tradeVM）里的局部变量** —— 这里根本取不到。而模块级也没有叫 market
  // 的东西（只有个 MARKET 常量，不是一回事），于是 cnyPerUnitLive(market)
  // 在求值参数时就抛 ReferenceError。
  //
  // 症状偏偏是最难往这边想的那种：**其它两个页签（交易明细、分红档案）
  // 都正常**，只有「分红记录」是空的 —— 因为 dividendFileVM 用的是
  // h.market（写对了），只有 dividendVM 用了裸的 market。
  // 而它是在 getHoldingRecords 的 .then 里抛的，整个返回体都拿不到，
  // 页面表现成"这一页没数据"。
  const market = h.market || 'A'
  const list = recordsOf(h.id).dividend || []
  return list
    .map((r) => ({
      id: r.id,
      date: r.date || '—',
      note: r.note || '现金分红',
      planText: r.plan || '—',
      // r.amount 是本币，折成实时人民币后按显示货币呈现
      amountText: moneyText((Number(r.amount) || 0) * cnyPerUnitLive(market), 2)
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

// '2025年报' -> 2025；'2026-06-26' -> 2026
function yearOf(r) {
  const m = String(r.period || r.exDate || '').match(/\d{4}/)
  return m ? Number(m[0]) : 0
}

/**
 * 分红档案：真实历史派息记录（与添加自选页同源），
 * 每行按当前股数与税率折算成税后到账金额。
 * dividend 为 null 表示该市场没有开放分红接口，退化为空档案。
 */
function dividendFileVM(h, dividend) {
  // 该持仓实际生效的税率（关掉「预测分红扣税」就等于 0%）
  const taxRate = effectiveTaxRate(h)
  // 税后到账 = 每股派息 × 股数 × (1 - 税率)
  const rate = 1 - taxRate / 100
  // 接口给的每股派息是**本币**，乘股数得到本币金额，再按**实时汇率**
  // 折成人民币 —— 这些是「未来能收到多少」，要用当下的汇率看。
  const cny = cnyPerUnitLive(h.market)
  const list = (dividend && dividend.list) || []

  let markedCurrent = false
  const rows = list.map((r, i) => {
    // 已公告但还没除权的方案：照常列出，但不标「最近一次」
    const pending = !r.exDate
    const current = !pending && !markedCurrent
    if (current) markedCurrent = true

    return {
      // 同年可能有多期方案（中报 + 年报），key 用下标保证唯一
      key: 'dv-' + i,
      year: yearOf(r) || '—',
      yearText: r.period || r.exDate || '—',
      planText: r.planText || '—',
      exDate: r.exDate || '—',
      payDate: r.payDate || r.recordDate || '—',
      dateText: dividendDateLine(r),
      // 每股派息按本币显示；到账金额是资产类数字，折成人民币后按显示货币走
      dpsText: nativeRawText(r.dps, h.market, 4),
      amount: r.dps * cny * h.shares * rate,
      amountText: moneyText(r.dps * cny * h.shares * rate, 2),
      pending,
      current
    }
  })

  return {
    list: rows,
    totalText: moneyText(rows.reduce((s, r) => s + r.amount, 0), 2),
    // h.received 已经由 decorate 按实时汇率折成人民币了，这里不要再乘汇率
    passedText: moneyText(h.received || 0, 2),
    source: dividend ? dividend.source : '',
    emptyText: dividend ? '该标的暂无分红记录' : '该市场暂未开放分红档案接口'
  }
}

function getHoldingRecords(id) {
  // 用 getHoldingAny 而不是 getHolding：已清仓归档的标的也要能翻看历史流水，
  // 否则投资档案点进去就是「未找到该持仓」—— 而记录明明还在。
  const h = store.getHoldingAny(id)
  if (!h) return fail('未找到该持仓', 404)

  // 历史派息走真实接口；取不到时退化为空档案，不影响其余内容展示
  return quote
    .fetchDividend({ code: h.code, market: h.market })
    .catch(() => null)
    .then((dividend) => {
      const vm = holdingVM(h)
      const file = dividendFileVM(h, dividend)

      return ok({
        holding: vm,
        // 已归档 = 这一页只读。页面据此收起「记一笔」与「删除」：
        // 档案页点进来是复盘，不是编辑；而且那两个入口点下去本来就取不到
        // 持仓（AddTrade 会直接报「未找到该持仓」），留着只会误导。
        archived: store.isArchived(h),
        trade: tradeVM(h),
        dividend: dividendVM(h),
        file: file.list,
        fileTotalText: file.totalText,
        filePassedText: file.passedText,
        fileSource: file.source,
        fileEmptyText: file.emptyText,
        receivedText: vm.receivedText
      })
    })
}

function addTradeRecord(id, form) {
  const h = store.getHolding(id)
  if (!h) return fail('未找到该持仓', 404)

  const f = form || {}
  const shares = Number(f.shares)
  const price = Number(f.price)
  if (!(shares > 0)) return fail('请填写正确的股数')
  if (!(price >= 0)) return fail('请填写正确的成交价')

  const type = f.type || '买入'
  // 卖出不能超过当前持仓：拦下来比静默按 0 算要清楚
  if (TRADE_EFFECT[type] === 'sell' && shares > (Number(h.shares) || 0)) {
    return fail('卖出数量不能超过当前持仓 ' + util.group(Number(h.shares) || 0, 0) + ' 股')
  }

  // 成交价与手续费填的都是**本币**，快照也只存本币原值 ——
  // 与持仓里的 cost 同口径，加权摊薄时不会串味
  const feeNative = Number(f.fee) || 0
  // 「当时的想法」：过一段时间回看，「为什么卖」比「卖在什么价」有价值得多。
  // 用 clip 而不是 slice：slice 数的是 UTF-16 码元，emoji 会被切出半个代理项。
  const note = validate.clip(String(f.note || '').trim(), MEMO_MAX)

  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.trade = (cur.trade || []).concat([
    {
      id: 'tr_' + Date.now(),
      date: f.date || todayKey(),
      type,
      shares,
      price: price,
      // 本币原值：成交价与手续费展示时直读，不再从人民币反算
      priceNative: price,
      fee: feeNative,
      feeNative: feeNative,
      note: note
    }
  ])
  all[id] = cur
  writeRecords(all)

  // 明细不只是流水：买入 / 卖出 / 送股会真的改变持仓的股数与摊薄成本
  const updated = applyTradesToHolding(h, cur.trade)

  // 清仓 = 卖出后股数归零。这里自动把它归档，并记下清仓价与日期 ——
  // 投资档案页要拿这两个数算「卖出至今涨跌」，用来验证当初的判断对不对。
  // 归档是标记而不是删除：交易流水一条不动，随时能翻回去看。
  if (updated && TRADE_EFFECT[type] === 'sell' && Number(updated.shares) <= 0) {
    writeHoldingPatch(id, {
      archived: true,
      archivedAt: f.date || todayKey(),
      archiveReason: note,
      exitPrice: price,
      exitPriceNative: price
    })
  }

  return getHoldingRecords(id)
}

// 分红记录的展示文案：方案按「每 10 股派 X」的惯例写，金额用该标的的**本币**
// （行情软件、券商对账单都是本币口径）；备注里的扣税金额则按显示货币走。
function dividendRemark(market, shares, dps, taxNative) {
  const plan = dps > 0 ? '每 10 股派 ' + nativeSymbol(market) + util.money(dps * 10, 2) : ''

  let note = '现金分红'
  if (taxNative > 0) {
    // 收的是本币，而扣税金额是资产类数字，按显示货币呈现
    note += '（扣税 ' + moneyText(taxNative * cnyPerUnitLive(market), 2) + '）'
  } else if (shares > 0 && dps > 0) {
    note += '（' + util.group(shares, 0) + ' 股）'
  }

  return { note, plan }
}

function addDividendRecord(id, form) {
  const h = store.getHolding(id)
  if (!h) return fail('未找到该持仓', 404)

  const f = form || {}
  const amount = Number(f.amount)
  if (!(amount > 0)) return fail('请填写正确的到账金额')

  // 到账金额、每股派息、扣税填的都是**本币**（页面按该持仓的本币单位收），
  // 快照也只存本币原值
  const shares = Number(f.shares) || 0
  const dps = Number(f.dps) || 0
  const tax = Number(f.tax) || 0
  // 明细里只展示金额 + 一行小字，把「每 10 股派多少」和扣税情况拼进这一行
  const remark = dividendRemark(h.market, shares, dps, tax)

  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.dividend = (cur.dividend || []).concat([
    {
      // id 允许调用方指定：自动记分红（autoRecordDividends）要一个**确定性**的
      // id —— 它靠"这个 id 已经存在"来实现幂等，而不是另存一个"记过没"的标记。
      // 手工记一笔仍然用时间戳（同一个人不会在同一毫秒记两笔）。
      id: String(f.id || '').trim() || 'dv_' + Date.now(),
      date: f.date || todayKey(),
      amount: amount,
      amountNative: amount,
      // 记下派息三要素（本币），之后能还原这笔分红的算法
      shares,
      dps: dps,
      dpsNative: dps,
      tax,
      taxNative: tax,
      note: String(f.note || '').trim() || remark.note,
      plan: String(f.plan || '').trim() || remark.plan
    }
  ])
  all[id] = cur
  writeRecords(all)

  // 到账金额直接进「累计已收」，回本进度跟着走
  applyDividendsToHolding(h, cur.dividend)

  return getHoldingRecords(id)
}

/**
 * 自动补记**已经到账**的分红。冷启动 / 回前台时跑一次（见 App.js 的 syncOnBoot）。
 *
 * ══ 为什么记在 App 本地，而不是后端定时任务 ══
 *
 * user_state 是**唯一权威源**，服务端的 holding_records 只是从整份快照解析出来的
 * 影子表，而且是 PUT 整份覆盖。服务端自己插一笔，下一次客户端同步就会被当成
 * "这批没有它"而删掉 —— 那比不记还糟（数据凭空消失）。
 *
 * ══ 三条约束 ══
 *
 *  1. **只认已实施的方案**：未除权的方案 exDate 是空的，那种是"计划"，不能记。
 *  2. **不早于建仓日**：这条才是真正的判据（见 recordDueDividends 里的 startKey）。
 *     买入之前的那次分红本来就没他一份，不能补。
 *  3. **幂等靠确定性 id**：`dv_auto_<方案>_<到账日>`。重复跑只是"这个 id 已存在"，
 *     不需要另存一个"记过没"的标记（那种标记一旦丢失就会记重复）。
 *     另外还按**到账日**去一次重，防的是手工记过的那一笔（见 recordDueDividends）。
 *
 * ⚠️ 到账日用 payDate，A股/基金**没有**这个字段（上游不给），退回**除权除息日**：
 * A 股现金通常就是除息当天到账，这个回退是合理的。港股有真实的派息日。
 *
 * 失败一律静默：它是"顺手补一笔"，不是用户主动发起的操作 ——
 * 弹一个错误只会让人以为是自己哪里点错了。
 */

// AUTO_DIVIDEND_LOOKBACK_DAYS 最多往回补多久。
//
// ⚠️ 这个值返工过：原来是 **45 天**，理由是"更早的不补，免得用户嫌多"。
// 它挡住了一个真实且常见的场景 —— A 股绝大多数公司**一年只分一次**，
// 而且集中在 6~7 月除息。用户在**10 月**才想起来看，那次分红已经过了
// 119 天，于是"自动记录当年的分红收入"这个功能在最该生效的时候正好失效。
//
// 现在放宽到 400 天（一年多一点）：足够覆盖最近一次年报分红，
// 又不会把几年前的陈年流水一次性翻出来。
//
// ⚠️ 真正保证"不乱记"的是 recordDueDividends 里的 startKey（不早于建仓日），
// 不是这个窗口 —— 窗口只是个防呆上限。两者别搞反：只调窗口、去掉 startKey
// 的话，一只长期持有的票会把建仓以来**所有**分红都补出来。
const AUTO_DIVIDEND_LOOKBACK_DAYS = 400

function autoRecordDividends() {
  const list = (allHoldingsSafe() || []).filter((h) => {
    return h && h.code && !store.isArchived(h)
  })
  if (!list.length) return Promise.resolve(0)

  // 并行取分红档案。单只失败不影响其他 —— 它只是首页的一部分
  return Promise.all(
    list.map((h) =>
      quote
        .fetchDividend({ code: h.code, market: h.market })
        .then((dv) => ({ h: h, dv: dv }))
        .catch(() => null)
    )
  ).then((rows) => {
    let n = 0
    rows.forEach((row) => {
      if (!row || !row.dv) return
      n += recordDueDividends(row.h, row.dv)
    })
    return n
  })
}

// store.allHoldings 在某些构建顺序下可能还没就绪，兜一下（返回空数组而不是抛）
function allHoldingsSafe() {
  try {
    return store.allHoldings() || []
  } catch (e) {
    return []
  }
}

// 'yyyy-MM-dd' 往回推 n 天
function keyMinusDays(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return (
    d.getFullYear() +
    '-' +
    ('0' + (d.getMonth() + 1)).slice(-2) +
    '-' +
    ('0' + d.getDate()).slice(-2)
  )
}

// 金额保留两位（写进快照的金额都是两位小数，和手工记一笔的口径一致）
function money2(n) {
  return Number((Number(n) || 0).toFixed(2))
}

/**
 * 把一只持仓**该记但还没记**的分红补进去，返回补了几笔。
 *
 * 抽出来是为了能单独看逻辑：这里每一步都是"宁可漏记，不可错记"——
 * 漏了用户下次还能补，记错了要他自己去流水里找那一笔删掉。
 */
function recordDueDividends(h, dv) {
  const rows = (dv && dv.List) || []
  if (!rows.length) return 0

  const today = todayKey()
  const floorKey = keyMinusDays(AUTO_DIVIDEND_LOOKBACK_DAYS)
  // 买入之前的分红不该算他的
  const startKey = holdingStartDate(h)

  const all = readRecords()
  const cur = all[h.id] || { trade: [], dividend: [] }
  const kept = cur.dividend || []

  const known = {}
  // ⚠️ 除了确定性 id，还要按**到账日**收一份。只靠 id 不够：
  // 用户可能在某次分红后**手工记过**一笔（那时这个自动补记还没生效，或者他就是想自己记），
  // 而手工记的 id 是 'dv_<时间戳>' —— 和 'dv_auto_<方案>_<到账日>' 永远不同，
  // 于是同一天、同一笔钱会被记两遍，界面上就是"收了两次分红"。
  //
  // 同一天只认一笔：宁可漏（漏了他能再补一次），不可重（重了他得自己去流水里
  // 找出那一条删掉，而自动加的东西最容易让人怀疑是 App 出了问题）。
  const knownDate = {}
  kept.forEach((r) => {
    if (!r) return
    if (r.id) known[r.id] = true
    const d = String(r.date || '')
    if (d) knownDate[d] = true
  })

  const shares = Number(h.shares) || 0
  if (!(shares > 0)) return 0

  // 税率按**当前**设置算税后 —— 与手动记一笔的口径一致，
  // 否则"累计已收"会把两种口径的数加在一起
  const taxOn = h.taxOn !== false
  const rate = Number(h.taxRate) || 0

  const added = []
  rows.forEach((d) => {
    const ex = String((d && d.exDate) || '').trim()
    // exDate 为空 = 已公告未实施，那是计划不是到账
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ex)) return

    const payRaw = String((d && d.payDate) || '').trim()
    const pay = /^\d{4}-\d{2}-\d{2}$/.test(payRaw) ? payRaw : ex

    if (pay > today) return // 还没到账
    if (pay < floorKey) return // 太久远，不补
    if (startKey && pay < startKey) return // 买之前的分红，不该算他的

    const rid = 'dv_auto_' + String((d && d.period) || '') + '_' + pay
    if (known[rid]) return // 已经记过（确定性 id 就是幂等本身）
    if (knownDate[pay]) return // 那天已有记录 —— 多半是手工记过的那一笔，不再重复补

    const dps = Number((d && d.dps) || 0)
    if (!(dps > 0)) return

    const gross = shares * dps
    const tax = taxOn ? (gross * rate) / 100 : 0
    const amount = gross - tax
    if (!(amount > 0)) return

    const remark = dividendRemark(h.market, shares, dps, tax)
    added.push({
      id: rid,
      date: pay,
      amount: money2(amount),
      amountNative: money2(amount),
      shares: shares,
      dps: dps,
      dpsNative: dps,
      tax: money2(tax),
      taxNative: money2(tax),
      note: remark.note,
      plan: remark.plan,
      // 标记来源，方便界面/后台区分"这是自动补的"。
      // 存快照里是对用户透明的一小段，值得：将来要排查"这笔哪来的"时只有它说得清
      auto: true
    })
    known[rid] = true
  })

  if (!added.length) return 0

  all[h.id] = Object.assign({}, cur, { dividend: kept.concat(added) })
  writeRecords(all)

  // 累计已收 / 回本进度跟着走 —— 与手动记一笔同一条路
  const fresh = store.getHolding(h.id)
  if (fresh) applyDividendsToHolding(fresh, all[h.id].dividend)

  return added.length
}

// 删除一条交易记录（持仓自带的买入记录不允许删）
function removeTradeRecord(id, recordId) {
  const h = store.getHolding(id)
  if (!h) return fail('未找到该持仓', 404)
  if (String(recordId).indexOf('seed-') === 0) return fail('持仓自带的买入记录不可删除')

  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.trade = (cur.trade || []).filter((r) => r.id !== recordId)
  all[id] = cur
  writeRecords(all)

  // 删掉一笔交易，持仓要跟着退回这笔交易之前的状态
  applyTradesToHolding(h, cur.trade)

  return getHoldingRecords(id)
}

function removeDividendRecord(id, recordId) {
  const h = store.getHolding(id)
  if (!h) return fail('未找到该持仓', 404)

  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.dividend = (cur.dividend || []).filter((r) => r.id !== recordId)
  all[id] = cur
  writeRecords(all)

  // 删掉一笔到账记录，累计已收跟着减回去
  applyDividendsToHolding(h, cur.dividend)

  return getHoldingRecords(id)
}

// 编辑持仓：只允许改录入侧字段，行情侧字段保持不动
function updateHolding(id, form) {
  const raw = store.getRaw(id)
  if (!raw) return fail('未找到该持仓', 404)

  const f = form || {}
  const shares = Number(f.shares)
  if (!(shares > 0)) return fail('请填写正确的持仓数量')

  // 编辑面板填的同样是**本币**，快照只存本币原值 ——
  // 与新增持仓、交易记录保持同一个口径，录入的数字不会再被汇率改写
  const costNative = Number(f.cost) || 0
  const cost = costNative
  const feeNative = Number(f.fee) || 0
  const buyDate = f.buyDate || raw.buyDate || ''
  // 税率：没传就沿用原值，传了以页面为准；都没值时才退回市场默认
  const taxRate = taxRateFromForm(
    { taxRate: f.taxRate === undefined ? raw.taxRate : f.taxRate },
    raw.market
  )
  const taxOn = f.taxOn === undefined ? raw.taxOn !== false : f.taxOn !== false
  const patch = {
    shares,
    cost,
    costNative,
    // 负成本时现价跟着成本走，本币原值同理；否则沿用原值（老数据交给 nativeOf 兜底）
    price: f.negativeCost ? Math.abs(cost) : raw.price,
    priceNative: f.negativeCost ? Math.abs(costNative) : nativeOf(raw, 'price'),
    buyDate,
    // 买入日期变了持股天数必须跟着重算，否则页面上还是录入时的老数字
    holdingDays: buyDate ? daysSince(buyDate) : raw.holdingDays,
    // 这里的 fee 沿用历史行为 —— 编辑面板存进来的是本币原值，没有像新增持仓
    // 那样折成人民币。为不动已有数据口径，暂不修正，只把本币那份显式记下来。
    fee: feeNative,
    feeNative: feeNative,
    costMode: f.costMode || raw.costMode || '',
    negativeCost: !!f.negativeCost,
    taxRate: taxRate,
    taxOn: taxOn,
    divMode: f.divMode || raw.divMode || ''
  }

  const write = () => {
    if (raw.custom) store.updateAdded(id, patch)
    // 内置持仓：以「本地覆盖」的方式存一份补丁，不改 mock 源数据
    else store.patchBuiltin(id, patch)

    // 首次编辑时把建仓基准定下来：基准只放用户刚填的每股成本（不含手续费），
    // 手续费由 fee 字段单独记着，重算时再摊进来。
    // 已冻结过的不动 —— 那份基准代表「用户当初录入的起点」，编辑不该改写它。
    if (raw.seedShares === undefined || raw.seedShares === null) {
      writeHoldingPatch(id, {
        seedShares: shares,
        seedCost: costNative,
        seedCostNative: costNative,
        seedDate: buyDate
      })
    }

    // 与新建持仓同一口径：编辑后的成本也要把手续费摊进去。
    // 否则用户在编辑面板改完成本，看到的还是「不含手续费」的那个数 ——
    // 而新建出来的是含的，同一只持仓两个入口两个结果。
    const cur = store.getHolding(id)
    if (cur) {
      const trades = (readRecords()[id] || {}).trade || []
      applyTradesToHolding(cur, trades)
    }

    return ok(holdingVM(store.getHolding(id)))
  }

  // 分红口径和税率都没动，就不用重算 dps
  if (!f.divMode && f.taxRate === undefined && f.taxOn === undefined) return write()

  const idx = Math.max(0, DIV_MODES.indexOf(f.divMode))
  const custom = Number(f.customDividend)

  // 自定义口径直接用用户填的金额
  if (idx === 3 && custom > 0) {
    patch.dps = custom
    patch.dpsNative = custom
    return write()
  }

  // 其余口径要按真实派息基数重算，否则预测分红不会跟着变
  return resolveBaseDps(raw, idx).then((base) => {
    patch.dps = base > 0 ? Number(netDpsOf(base, taxOn ? taxRate : 0).toFixed(6)) : raw.dps
    // 与上面那支分支保持一致：dps 存的就是本币值，原值直接跟着写一份
    patch.dpsNative = patch.dps
    return write()
  })
}

/**
 * 按口径取每股派息的基数（税前，本币）。
 *
 * 换口径时必须重新取一次真实分红记录 —— 记录里存的那份 baseDps 是**上一个口径**
 * 算出来的（比如原来是"近5年"的均值），拿来当"近3年"的基数只会越算越歪。
 * 所以顺序是：现取真实档案 → 取不到才退回记录里那份 → 都没有才用标的池。
 */
function resolveBaseDps(raw, idx) {
  return quote
    .fetchDividend({ code: raw.code, market: raw.market })
    .catch(() => null)
    .then((d) => {
      const base = d ? dpsBaseFor(d, idx, 0) : 0
      if (base > 0) return base
      const saved = Number(raw.baseDpsNative || raw.baseDps || 0)
      if (saved > 0) return saved
      const inPool = findStock(raw.code)
      return inPool ? inPool.dps : 0
    })
}

module.exports = {
  // 用户（登录 / 注册在 utils/cloud.js，这里只留账号相关的读操作）
  logout,
  getUser,
  // 持仓
  getHoldings,
  getHolding,
  getSummary,
  getCoverageBrief,
  // 进入持仓页前按实时行情刷新本地持仓价格
  refreshHoldingQuotes,
  addHolding,
  getAddHoldingOptions,
  getStockByCode,
  getStockDetail,
  searchStocks,
  estimateDividend,
  removeHolding,
  // 清仓归档（投资档案）
  getArchive,
  getArchivedHolding,
  archiveHolding,
  unarchiveHolding,
  setArchiveReason,
  // 心得类文本的字数上限：页面把它传给弹窗，保证「输入框能打多少」
  // 与「存下来多少」是同一个数
  MEMO_MAX,
  // 持仓排序 / 分组（同步纯计算，用于零延迟重绘）
  buildHoldingGroups,
  // 汇总指标（previewMetrics 为同步纯计算，其余为异步 IO）
  getMetricSettings,
  getDefaultMetricKeys,
  saveMetricSettings,
  previewMetrics: buildMetricLists,
  // 覆盖
  getCoverage,
  // 支出
  getOnboardingExpenses,
  getExpenses,
  saveExpenses,
  removeExpense,
  addCustomExpense,
  // 引导
  getOnboardingDemo,
  previewPlan,
  savePlan,
  // 日历（buildMonthCells 为同步纯计算，用于切月时零延迟重绘）
  getCalendar,
  buildMonthCells,
  getDayEvents,
  getYearOverview,
  // 发现 / 我的
  getDiscover,
  getProfile,
  // 社区：信息流 / 详情 / 投票
  getCommunityFeed,
  getCommunityPost,
  votePoll,
  // 个股新闻（会员）
  getStockNews,
  // 自动补记已到账的分红（冷启动 / 回前台调用）
  autoRecordDividends,
  // 修正「累计已收」的 received / receivedNative（自愈，见 healReceived 的说明）
  healReceived,
  // 会员：状态 / 兑换码 / 下单 / 支付结果查询 / 启动对齐
  membershipVM,
  getMembership,
  getPayChannels,
  redeemMembership,
  createMembershipOrder,
  getOrderStatus,
  syncMembership,
  notifyMembershipGrace,
  notifyMembershipExpiring,
  // 我的：显示货币 / 多账户 / 文档 / 注销
  getCurrencyOptions,
  saveCurrency,
  getAccounts,
  switchAccount,
  addAccount,
  removeAccount,
  getStandardDoc,
  getContactInfo,
  getLegalDoc,
  destroyAccount,
  // 发现：榜单 / 文章 / 搜索 / 工具
  getRank,
  getArticle,
  getYieldCompare,
  ensureYieldPool,
  searchAllStocks,
  // 同步纯计算：滑块拖动时零延迟重算
  previewCompound,
  previewDca,
  returnProjection,
  // 同步货币文案（页面内联拼金额时用，保证与显示货币一致）
  curSymbol,
  moneyText,
  fixedText,
  amountText,
  wanText,
  // 本币（港股港币 / 美股美元）折算与文案：页面提示输入单位时用
  nativeName,
  nativeSymbol,
  cnyPerUnit,
  fromCny,
  migrateNativeCurrency,
  // 实时汇率：启动时恢复缓存 + 联网刷新
  restoreFx,
  refreshFx,
  // 持仓详情：交易明细 / 分红记录 / 分红档案
  getHoldingRecords,
  addTradeRecord,
  addDividendRecord,
  removeTradeRecord,
  removeDividendRecord,
  updateHolding,
  // 把当前持仓校准为新的建仓基准（旧交易只作流水）
  resetSeedBase
}
