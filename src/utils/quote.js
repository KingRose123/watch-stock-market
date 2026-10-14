/**
 * 行情数据源
 *
 * 两条通道，优先走服务端：
 *   1) 云托管代理（推荐）：客户端只调自己的后端，不用配 request 合法域名，
 *      所有用户共享服务端缓存，数据源也藏在后端；
 *   2) 直连东方财富（兜底）：后端没部署 / 断网时自动回退，本地开发不受影响。
 *
 * 无论走哪条通道，返回结构和字段口径完全一致，所以 api.js 无感。
 * 这一层只负责取数与字段归一化，吐原始数值 + yyyy-MM-dd 日期，
 * 货币换算、千分位、涨跌配色等展示逻辑统一放在 api.js。
 *
 * 直连通道需要在小程序后台把下面四个域名加进 request 合法域名
 * （勾了「不校验合法域名」可跳过）：
 *   https://push2.eastmoney.com             实时行情
 *   https://search-codetable.eastmoney.com  代码 / 名称搜索
 *   https://datacenter-web.eastmoney.com    分红档案
 *   https://fund.eastmoney.com              场外基金净值
 */

const cloud = require('./cloud.js')

const HOST = {
  quote: 'https://push2.eastmoney.com',
  search: 'https://search-codetable.eastmoney.com',
  data: 'https://datacenter-web.eastmoney.com',
  fund: 'https://fund.eastmoney.com'
}

const TIMEOUT = 8000

// 东财市场号 -> 本项目市场标识
// 0 深市 / 1 沪市 / 105·106·107 美股 / 116 港股 / 150 场外基金 / 90 板块
const MARKET_BY_NO = {
  0: 'A',
  1: 'A',
  105: 'US',
  106: 'US',
  107: 'US',
  116: 'HK',
  150: 'FUND'
}

// 行情字段（**批量接口** /api/qt/ulist.np/get 的编码）：
//   小数位 / 最新价 / 涨跌幅 / 涨跌额 / 成交量 / 成交额 / 振幅 / 换手率 /
//   市盈率 / 代码 / 市场号 / 名称 / 最高 / 最低 / 今开 / 昨收 / 总市值 / 流通市值 / 市净率
//
// ⚠️ 这套编码只属于批量接口。单只接口（/api/qt/stock/get）用的是另一套
// （f43/f57/f58/f59…），两套的字段名**和放大倍数**都不一样，混用会静默给错数。
// 服务端 server-go/internal/quote/quote.go 里有一张完整对照表。
const QUOTE_FIELDS = 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23'

/* ---------------- 基础工具 ---------------- */

function num(v) {
  const n = Number(v)
  return isNaN(n) ? 0 : n
}

// '2026-06-26 00:00:00' -> '2026-06-26'
function dateOf(v) {
  const s = String(v || '')
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''
}

// 时间戳 -> 'yyyy-MM-dd'
function dateOfTs(ts) {
  const d = new Date(num(ts))
  if (isNaN(d.getTime())) return ''
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// 去掉多余小数位：280.2423 -> '280.2423'，0.3460 -> '0.346'
function trimNum(v, digits) {
  const n = num(v)
  return String(Number(n.toFixed(digits === undefined ? 4 : digits)))
}

/**
 * 直连行情失败时的提示。
 *
 * 小程序那版要提示「域名没加白名单」——App 端没有白名单这回事（原生请求不受限），
 * 所以那条分支去掉了，只区分超时与一般网络故障。
 * RN 的网络错误大多是英文原文（Network request failed 之类），统一收成中文。
 */
function netError(e) {
  const msg = String((e && e.errMsg) || '')
  if (msg.indexOf('timeout') > -1 || /abort/i.test(msg)) return '行情接口超时，请稍后重试'
  return '行情接口连接失败，请检查网络后重试'
}

function request(url) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: url,
      timeout: TIMEOUT,
      header: { 'content-type': 'application/json' },
      success(res) {
        if (res.statusCode !== 200) {
          reject({ code: res.statusCode, msg: '接口返回 ' + res.statusCode })
          return
        }
        resolve(res.data)
      },
      fail(e) {
        reject({ code: 0, msg: netError(e) })
      }
    })
  })
}

/* ---------------- 搜索 ---------------- */

// 指数 / 板块等非个股标的过滤掉
function isTradeable(typeName) {
  const t = String(typeName || '')
  return t.indexOf('指数') === -1 && t.indexOf('板块') === -1
}

// 东财条目 -> 本项目标的；市场号直接拼 secid，不用猜沪深前缀
function toStock(item) {
  const market = MARKET_BY_NO[item.market]
  if (!market || !isTradeable(item.securityTypeName)) return null

  // 场内基金（ETF / LOF）走行情接口，场外基金走净值接口
  const isFund = String(item.securityTypeName || '').indexOf('基金') > -1
  const key = market === 'A' && isFund ? 'ETF' : market

  return {
    code: String(item.code || ''),
    name: String(item.shortName || ''),
    market: key,
    secid: market === 'FUND' ? '' : item.market + '.' + String(item.code || ''),
    typeName: item.securityTypeName || ''
  }
}

// 关键字搜索：代码、中文名、拼音首字母都能命中
function directSearch(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return Promise.resolve([])

  const url =
    HOST.search +
    '/codetable/search/web?client=web&clientType=webSuggest&clientVersion=lastest' +
    '&pageIndex=1&pageSize=20&keyword=' +
    encodeURIComponent(kw)

  return request(url).then((res) => {
    const list = (res && res.result) || []
    return list.map(toStock).filter((s) => !!s)
  })
}

/* ---------------- 实时行情 ---------------- */

// 批量接口每批最多带几只。40 是在「URL 长度」和「请求数」之间的折中：
// 一轮持仓页/榜单通常十几只，40 够一次装完；极端长的名单也不会拼出超长 URL。
const QUOTE_BATCH = 40

/**
 * 批量直连东财（不经过自家服务端）。
 *
 * ⚠️ 用的是 /api/qt/ulist.np/get，**不是**单只的 /api/qt/stock/get。
 * 两个都是东财的接口，但服务端实测过：stock/get 会被上游按「机房出口 IP」
 * 持续拒答（TLS 通了、请求发出去了、然后连接被直接关掉），而同一个域名的
 * 批量接口完全正常。服务端那边因此换成了批量（见 server-go/internal/quote），
 * 客户端这里一并对齐 —— 两边同源，排查时才只有一个变量。
 *
 * 换成批量还顺带解决了两件事：
 *   1. 一次拉一批。榜单十几只从「十几+十几」个请求降到「1+十几」个，
 *      而请求量降下来正是缓解「手机 IP 被上游限流」最有效的办法；
 *   2. 美股那三个候选 secid（105/106/107）一次全传，上游只返回真实存在的
 *      那一个 —— 不用再「逐个试、命中即停」。
 *
 * 返回 { 'secid': quote }，取不到价格的标的不会出现在里面。
 */
function directQuotes(secids) {
  const list = (secids || []).filter((s) => !!s)
  if (!list.length) return Promise.resolve({})

  const chunks = []
  for (let i = 0; i < list.length; i += QUOTE_BATCH) chunks.push(list.slice(i, i + QUOTE_BATCH))

  return Promise.all(
    chunks.map((c) =>
      request(
        HOST.quote +
          '/api/qt/ulist.np/get?secids=' +
          encodeURIComponent(c.join(',')) +
          '&fields=' +
          QUOTE_FIELDS +
          // 刻意**不带 fltt=2**：带上上游返回除好的小数，不带则返回放大过的
          // 整数、由 toQuoteFromList 按 f1 还原。选后者是因为缩放规则掌握在
          // 自己手里 —— 带了 fltt 又按 f1 除一次，价格会缩小 100 倍（实测踩过，
          // 服务端那边也踩过同一个坑）。
          '&invt=2'
      )
    )
  ).then((resList) => {
    const out = {}
    resList.forEach((res) => {
      const rows = (res && res.data && res.data.diff) || []
      rows.forEach((row) => {
        const secid = listSecidOf(row)
        const q = toQuoteFromList(row)
        if (secid && q) out[secid] = q
      })
    })
    return out
  })
}

/**
 * 批量接口的一行 → 归一化行情。
 *
 * 批量接口返回的是**放大过的整数**（茅台 f2 = 123700），要按 f1（小数位）
 * 还原；百分比类字段固定放大 100 倍，成交量/成交额/市值是原值。
 * 与服务端 toQuoteFromList 逐项对应，改一处就得改两处。
 *
 * 取不到价格（停牌、代码不存在）返回 null：口径与旧版一致 ——
 * 「没有价格」就是「这只取不到」，让上层按无数据处理，而不是给一张全是 0 的卡。
 */
function toQuoteFromList(d) {
  if (!d || d.f2 === undefined || d.f2 === null || d.f2 === '-') return null

  // f1 缺失时按 2 位处理，与服务端的默认值保持一致 ——
  // 同一个标的在两条通道上位数不同的话，展示会跳。
  const digits = num(d.f1) || 2
  const scale = Math.pow(10, digits)

  return {
    code: String(d.f12 || ''),
    name: String(d.f14 || ''),
    price: num(d.f2) / scale,
    prevClose: num(d.f18) / scale,
    change: num(d.f4) / scale,
    changeRate: num(d.f3) / 100,
    open: num(d.f17) / scale,
    high: num(d.f15) / scale,
    low: num(d.f16) / scale,
    amplitude: num(d.f7) / 100,
    turnoverRate: num(d.f8) / 100,
    volume: num(d.f5),
    amount: num(d.f6),
    // 与旧接口（f162）口径略有不同（动/静之分），只用于展示、不参与计算
    pe: num(d.f9) / 100,
    pb: num(d.f23) / 100,
    marketCap: num(d.f20),
    floatCap: num(d.f21),
    digits: digits
  }
}

/**
 * 从批量接口的一行还原 secid。
 *
 * 批量接口回的是**数组**，不存在的标的会被直接省略、后面每一行往前挪位 ——
 * 所以不能按下标回填，必须用 f13(市场号) + f12(代码) 拼出 secid 精确匹配。
 */
function listSecidOf(d) {
  const no = d && d.f13
  const code = String((d && d.f12) || '')
  if (code === '' || no === undefined || no === null || no === '') return ''
  return String(no) + '.' + code
}

// 没有 secid 时按市场推：美股可能在纳斯达克 / 纽交所 / 美交所，逐个试
function secidCandidates(market, code) {
  const c = String(code || '').toUpperCase()
  if (!c) return []
  if (market === 'US') return ['105.' + c, '106.' + c, '107.' + c]
  if (market === 'HK') return ['116.' + c]
  if (market === 'FUND') return []
  // A股 / 场内基金：6、5、9 开头为沪市，其余归深市（含北交所）
  return [(/^[659]/.test(c) ? '1.' : '0.') + c]
}

// 一只标的的候选 secid：调用方带了 secid 就用它，没带才按市场推
function secidsFor(stock) {
  const s = stock || {}
  return s.secid ? [s.secid] : secidCandidates(s.market, s.code)
}

// 单只行情。走批量接口取（候选一次全传），命中即返回。
//
// 旧版是「候选逐个试、命中即停」，最坏要三次串行往返（美股三个前缀）。
// 现在候选一次全传，上游只返回存在的那一个，一次往返就够。
function directQuote(stock) {
  const list = secidsFor(stock)
  if (!list.length) return Promise.resolve(null)

  return directQuotes(list).then((map) => {
    for (let i = 0; i < list.length; i++) {
      if (map[list[i]]) return map[list[i]]
    }
    return null
  })
}

/* ---------------- 场外基金净值 ---------------- */

function matchStr(src, key) {
  const m = src.match(new RegExp('var\\s+' + key + '\\s*=\\s*"([^"]*)"'))
  return m ? m[1] : ''
}

function matchArray(src, key) {
  const m = src.match(new RegExp(key + '\\s*=\\s*(\\[[\\s\\S]*?\\]);'))
  if (!m) return []
  try {
    return JSON.parse(m[1])
  } catch (e) {
    return []
  }
}

// 净值走势里带 unitMoney 的就是分红送配记录
function fundDividendOf(trend) {
  return trend
    .filter((p) => p && p.unitMoney && String(p.unitMoney).indexOf('派现金') > -1)
    .map((p) => {
      const m = String(p.unitMoney).match(/([\d]+(?:\.\d+)?)\s*元/)
      const dps = m ? num(m[1]) : 0
      return {
        period: dateOfTs(p.x),
        planText: String(p.unitMoney),
        dps: dps,
        exDate: dateOfTs(p.x),
        recordDate: '',
        payDate: '',
        progress: ''
      }
    })
    .filter((r) => r.dps > 0)
}

// pingzhongdata 一次给全：名称、最新净值、日涨幅、历史分红
function directFund(code) {
  return request(HOST.fund + '/pingzhongdata/' + code + '.js').then((text) => {
    const src = typeof text === 'string' ? text : ''
    if (!src) return null

    const trend = matchArray(src, 'Data_netWorthTrend')
    if (!trend.length) return null

    const last = trend[trend.length - 1]
    const prev = trend.length > 1 ? trend[trend.length - 2] : last
    const price = num(last.y)
    const prevClose = num(prev.y)

    return {
      quote: {
        code: String(code),
        name: matchStr(src, 'fS_name'),
        price: price,
        prevClose: prevClose,
        change: Number((price - prevClose).toFixed(4)),
        changeRate: last.equityReturn === undefined ? 0 : num(last.equityReturn),
        priceDate: dateOfTs(last.x),
        digits: 4
      },
      dividend: {
        source: '天天基金 · 基金分红',
        list: fundDividendOf(trend)
      }
    }
  })
}

/* ---------------- 分红档案 ---------------- */

function periodOf(reportDate) {
  const s = dateOf(reportDate)
  if (!s) return ''
  const year = s.slice(0, 4)
  const md = s.slice(5)
  if (md === '12-31') return year + '年报'
  if (md === '06-30') return year + '中报'
  if (md === '09-30') return year + '三季报'
  if (md === '03-31') return year + '一季报'
  return year + '年度'
}

// A股 / 场内基金：每 10 股派息（税前）
function toDividendA(r) {
  const per10 = num(r.PRETAX_BONUS_RMB)
  if (!(per10 > 0)) return null

  return {
    period: periodOf(r.REPORT_DATE),
    planText: '每 10 股派 ' + trimNum(per10) + ' 元（含税）',
    dps: per10 / 10,
    unit: '股',
    exDate: dateOf(r.EX_DIVIDEND_DATE),
    recordDate: dateOf(r.EQUITY_RECORD_DATE),
    payDate: '',
    progress: r.ASSIGN_PROGRESS || ''
  }
}

/**
 * 按「报告期」倒序取，而不是按除息日倒序。
 * 已经公告但还没实施的分红方案没有除息日（EX_DIVIDEND_DATE 为 null），
 * 按除息日倒序时 null 会排到最后，pageSize 一截就把最新方案整个丢掉。
 * 报告期（REPORT_DATE）一定有值，最新的中报 / 年报方案永远排在最前。
 */
function dividendA(code, size) {
  const url =
    HOST.data +
    '/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=' +
    encodeURIComponent('(SECURITY_CODE="' + code + '")') +
    '&pageNumber=1&pageSize=' + (size || 10) +
    '&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB'

  return request(url).then((res) => {
    const rows = (res && res.result && res.result.data) || []
    return {
      source: '东方财富 · 分红送配',
      list: rows.map(toDividendA).filter((r) => !!r)
    }
  })
}

/**
 * 港股：方案原文有两种写法，必须分开认 ——
 *   以港币宣派：「每股派港币0.024元」
 *   以人民币宣派：「每股派人民币0.154元(相当于港币0.177元)」
 *
 * 后者在港股里非常常见（中资公司多按人民币记账，中国食品 00506 就是），
 * 而原来只取「原文里第一个数字」，拿到的是**人民币**金额却当成本币（港币）用。
 * 后果不是固定打几折，而是随当期汇率浮动，表现就是「股息率和市场公布的对不上、
 * 而且怎么调税率都对不上」—— 因为错在基数本身。
 *
 * 所以优先取括号里的港币等值（公司公告的官方折算值），其次认「派港币X元」，
 * 最后才退回第一个数字兜底。
 */
function toDividendHK(r) {
  const text = String(r.PLAN_EXPLAIN || '')

  const equivalent = text.match(/(?:相当于|折合|相等于)\s*港(?:币|元)\s*([\d]+(?:\.\d+)?)/)
  const declaredHkd = text.match(/派\s*港(?:币|元)\s*([\d]+(?:\.\d+)?)/)
  const fallback = text.match(/([\d]+(?:\.\d+)?)/)

  const m = equivalent || declaredHkd || fallback
  const dps = m ? num(m[1]) : 0
  if (!(dps > 0)) return null

  return {
    period: r.ASSIGN_PERIOD || '',
    planText: text,
    dps: dps,
    unit: '股',
    exDate: dateOf(r.EX_DIVIDEND_DATE),
    recordDate: dateOf(r.RECORD_DATE),
    payDate: dateOf(r.DIVIDEND_DATE),
    progress: r.ASSIGN_PROGRESS || ''
  }
}

/**
 * 港股报告里没有 REPORT_DATE，改用公告日（NOTICE_DATE）倒序：
 * 同样是为了让「刚公告、还没除息」的方案排在最前，不被 pageSize 截掉。
 */
function dividendHK(code, size) {
  const url =
    HOST.data +
    '/api/data/v1/get?reportName=RPT_HKF10_INFO_DIVIDEND&columns=ALL&filter=' +
    encodeURIComponent('(SECUCODE="' + code + '.HK")') +
    '&pageNumber=1&pageSize=' + (size || 10) +
    '&sortColumns=NOTICE_DATE&sortTypes=-1&source=WEB&client=WEB'

  return request(url).then((res) => {
    const rows = (res && res.result && res.result.data) || []
    return {
      source: '东方财富 · 港股派息',
      list: rows.map(toDividendHK).filter((r) => !!r)
    }
  })
}

// 返回 null 表示这个市场没有可用的分红档案（美股），页面按「无数据」展示
// opts.size 用于统计「连续分红年数」这类需要更长历史的场景
function directDividend(stock, opts) {
  const market = (stock && stock.market) || ''
  const size = (opts && opts.size) || 10
  if (market === 'A' || market === 'ETF') return dividendA(stock.code, size)
  if (market === 'HK') return dividendHK(stock.code, size)
  return Promise.resolve(null)
}

/* ---------------- 聚合 ---------------- */

// 一次取齐：实时行情 + 分红档案（直连通道）
function directDetail(stock) {
  if (!stock || !stock.code) {
    return Promise.reject({ code: 400, msg: '缺少标的代码' })
  }

  // 场外基金净值与分红同源，一次请求拿全
  if (stock.market === 'FUND') {
    return directFund(stock.code).then((d) => ({
      quote: d ? d.quote : null,
      dividend: d ? d.dividend : null
    }))
  }

  return Promise.all([directQuote(stock), directDividend(stock)]).then((arr) => ({
    quote: arr[0],
    dividend: arr[1]
  }))
}

/* ================= 对外通道：优先服务端，失败回退直连 ================= */

function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .map((k) => k + '=' + encodeURIComponent(params[k]))
    .join('&')
}

// 连续失败就先别试服务端了：否则后端没部署时每次都要白等一轮超时
let failStreak = 0
let skipUntil = 0
const FAIL_LIMIT = 3
const SKIP_MS = 60 * 1000

// 记一次服务端失败；连续到阈值就先停用服务端一分钟
function noteFail(reason) {
  failStreak++
  if (failStreak >= FAIL_LIMIT) {
    failStreak = 0
    skipUntil = Date.now() + SKIP_MS
    console.warn('[quote] 服务端连续失败，' + SKIP_MS / 1000 + 's 内改走直连')
  }
  console.warn('[quote] 服务端取数失败，回退直连：' + reason)
}

/**
 * 批量接口的「到底有没有拿到东西」。
 *
 * 判定用**任意一条非空**，不是全部非空：个别标的停牌 / 退市 / 没有档案
 * 拿不到是正常的，不该因为一条空的就把整批退回直连 —— 那会把已经拿到的
 * 那几条白拿一次，还要多等一轮直连往返。
 */
function anyQuote(map) {
  const keys = Object.keys(map || {})
  for (let i = 0; i < keys.length; i++) {
    if (map[keys[i]]) return true
  }
  return false
}

// /api/details 的每条是 { quote, dividend } 对象，**对象本身总是真的**，
// 所以不能拿它判断非空，必须看里面两个字段（这正是漏判过一次的地方：
// 后端连不上东财时它返回的每条都是 { quote: null, dividend: null }）。
function anyDetail(map) {
  const keys = Object.keys(map || {})
  for (let i = 0; i < keys.length; i++) {
    const row = map[keys[i]] || {}
    if (row.quote || row.dividend) return true
  }
  return false
}

/**
 * 云托管优先，直连兜底。
 *  - cloud 未启用（后端没部署 / 基础库不支持）→ 直接走直连，不打无谓请求；
 *  - 服务端调用失败（超时 / 上游 5xx）→ 回退直连；
 *  - **服务端调用"成功"、但里面没有可用数据 → 同样回退直连**；
 *  - 连续失败到阈值 → 一分钟内直接走直连，避免每次都白等一次超时。
 *
 * 第三条是后补的，也是真踩过的坑：后端连不上东财时，它的表现**不是报错**，
 * 而是返回 200 + 空数据（`{"data":{"A:600519":null}}`）。原来的实现把这当成
 * "成功"，于是带着空数据一路往下走，最后在页面上报一句「行情获取失败」——
 * 明明客户端自己就能直连东财，却压根没去试。
 *
 * 「有没有数据」每种返回的口径都不一样（单只是 null、批量是一个 map、
 * 详情还要看内层字段），所以判定由调用方通过 hasData 传进来；
 * 不传就表示"空是合法结果"（比如搜索无匹配、某市场没有分红档案）。
 */
function pick(cloudCall, directCall, hasData) {
  if (!cloud.enabled() || Date.now() < skipUntil) return directCall()

  return cloudCall().then(
    (value) => {
      if (hasData && !hasData(value)) {
        noteFail('返回空数据')
        return directCall()
      }
      failStreak = 0
      return value
    },
    (e) => {
      noteFail((e && e.msg) || '请求失败')
      return directCall()
    }
  )
}

function search(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return Promise.resolve([])
  return pick(
    () => cloud.request('/api/quote/search?' + qs({ kw })).then((r) => r.data || []),
    () => directSearch(kw)
  )
}

function fetchQuote(stock) {
  const s = stock || {}
  return pick(
    () =>
      cloud
        .request('/api/quote?' + qs({ code: s.code, market: s.market, secid: s.secid }))
        .then((r) => r.data || null),
    () => directQuote(s),
    // 单只：null 就是没拿到。代码写错时直连同样给 null，多花一次请求，
    // 换"后端挂了也照样出数"—— 这个交换很值。
    (v) => !!v
  )
}

function fetchFund(code) {
  if (!code) return Promise.resolve(null)
  return pick(
    () => cloud.request('/api/fund?' + qs({ code })).then((r) => r.data || null),
    () => directFund(code),
    (v) => !!v
  )
}

/* ---------------- 汇率 ----------------
 * 港币 / 美元兑离岸人民币（CNH）。用离岸价是因为投资者的视角就是它，
 * 而且东财只提供 CNH（没有在岸 CNY 的行情）。
 * 返回值是「1 单位外币 = 多少人民币」：{ CNY: 1, HKD: 0.8534, USD: 6.6953 }。
 */
const FX_SECID = { HKD: '133.HKDCNH', USD: '133.USDCNH' }

function fetchFx() {
  const codes = Object.keys(FX_SECID)

  return Promise.all(
    codes.map((c) =>
      request(HOST.quote + '/api/qt/stock/get?secid=' + FX_SECID[c] + '&fields=f43,f59')
        .then((res) => {
          const d = (res && res.data) || {}
          // f43 是放大过的整数，f59 是小数位数
          const price = Number(d.f43) / Math.pow(10, Number(d.f59) || 0)
          return price > 0 ? { code: c, price: price } : null
        })
        .catch(() => null)
    )
  ).then((arr) => {
    const out = { CNY: 1 }
    arr.forEach((r) => {
      if (r) out[r.code] = r.price
    })
    return out
  })
}

/**
 * 按公告原文再校正一次港股的每股派息。
 *
 * 服务端有可能还是「取方案原文里第一个数字」的老口径：以人民币宣派的港股
 * （原文形如「每股派人民币0.154元(相当于港币0.177元)」）会被低估一截，
 * 偏差还随当期汇率浮动，表现就是「股息率和市场公布的对不上」。
 *
 * 服务端返回里带着 planText（公告原文），所以客户端能自己重解析一遍。
 * 放在这一层是因为 dividend / detail / details 三条通道取回的分红都经过它，
 * 上游（持仓、详情、榜单、档案）不用各自处理。
 * 服务端更新后两边结果一致，这里自然成为空操作 —— 幂等，不会互相打架。
 */
function fixHkDividend(dividend) {
  if (!dividend || !dividend.list || !dividend.list.length) return dividend

  let changed = false
  const list = dividend.list.map((r) => {
    const m = String((r && r.planText) || '').match(
      /(?:相当于|折合|相等于)\s*港(?:币|元)\s*([\d]+(?:\.\d+)?)/
    )
    if (!m) return r
    const hkd = num(m[1])
    if (!(hkd > 0) || hkd === r.dps) return r
    changed = true
    return Object.assign({}, r, { dps: hkd })
  })

  return changed ? Object.assign({}, dividend, { list: list }) : dividend
}

// 档案挂在 detail / details 的返回值里，配套两个包装
function fixHkDetail(d) {
  if (!d) return d
  return Object.assign({}, d, { dividend: fixHkDividend(d.dividend) })
}

function fixHkDetailMap(map) {
  if (!map) return map
  const out = {}
  Object.keys(map).forEach((k) => {
    out[k] = fixHkDetail(map[k] || {})
  })
  return out
}

function fetchDividend(stock, opts) {
  const s = stock || {}
  const size = (opts && opts.size) || 10
  // 服务端对「该市场没有分红档案」的返回是 data:null，客户端原样透出去
  return pick(
    () =>
      cloud
        .request('/api/dividend?' + qs({ code: s.code, market: s.market, size }))
        .then((r) => (r.data === undefined ? null : r.data)),
    () => directDividend(s, opts)
  ).then(fixHkDividend)
}

function fetchDetail(stock) {
  const s = stock || {}
  if (!s.code) return Promise.reject({ code: 400, msg: '缺少标的代码' })
  return pick(
    () =>
      cloud
        .request('/api/detail?' + qs({ code: s.code, market: s.market, secid: s.secid }))
        .then((r) => r.data || { quote: null, dividend: null }),
    () => directDetail(s),
    // 两个字段都空才算"没拿到"：有些标的确实没有分红档案，
    // 只要有行情就说明服务端是通的
    (v) => !!(v && (v.quote || v.dividend))
  ).then(fixHkDetail)
}

/* ================= 批量：一次请求拿齐多只标的 =================
 * 持仓页刷新、榜单、息率对比都是「十几只标的一次拉」的场景。
 * 走批量接口后，客户端请求数从 2N 降到 1，也天然避开了小程序
 * 单会话最多 10 个并发请求的限制。返回结构是 { '市场:代码': 数据 }。
 */

// 与批量接口约定的键格式，调用方用它回填
function batchKey(stock) {
  return (
    String((stock && stock.market) || '') + ':' + String((stock && stock.code) || '').toUpperCase()
  )
}

// 直连兜底时自己限流：上游是公开接口，压太高容易被风控
function mapLimit(list, limit, fn) {
  const src = list || []
  const out = new Array(src.length)
  let cursor = 0

  function run() {
    if (cursor >= src.length) return Promise.resolve()
    const i = cursor++
    return Promise.resolve(fn(src[i], i)).then((v) => {
      out[i] = v
      return run()
    })
  }

  const workers = []
  const n = Math.min(limit, src.length)
  for (let i = 0; i < n; i++) workers.push(run())
  return Promise.all(workers).then(() => out)
}

/**
 * 批量直连行情，返回 { '市场:代码': quote|null }。
 *
 * 与 directQuote 的差别只在**输出形状**：批量接口按 secid 给结果，
 * 而所有调用方要的都是按「市场:代码」的键。把这次转换收在这里，
 * 免得每个调用方各写一遍、再各自写错一次。
 */
function directQuotesOf(items) {
  const plan = items.map(secidsFor) // 每只的候选 secid

  // 摊平成一串 secid 再一次性请求 —— 同一只的多个候选也一并带上，
  // 由上游告诉你哪个真实存在
  const all = []
  plan.forEach((secids) => {
    secids.forEach((secid) => {
      if (all.indexOf(secid) < 0) all.push(secid)
    })
  })

  return directQuotes(all).then((map) => {
    const out = {}
    items.forEach((s, i) => {
      let hit = null
      plan[i].forEach((secid) => {
        if (!hit && map[secid]) hit = map[secid]
      })
      out[batchKey(s)] = hit
    })
    return out
  })
}

// 批量实时行情
function fetchQuotes(list) {
  const items = (list || []).filter((s) => s && s.code)
  if (!items.length) return Promise.resolve({})

  return pick(
    () => cloud.request('/api/quotes', 'POST', { items }).then((r) => r.data || {}),
    // 直连也走批量。原来是一只一个请求（mapLimit 限并发 4），
    // 十几只的榜单就是十几个请求 —— 那正是最容易被上游风控盯上的形态。
    () => directQuotesOf(items),
    anyQuote
  )
}

/**
 * 直连版的「行情 + 分红」。
 *
 * 两条腿**并行**、而且请求量的分配是刻意不均的：
 *   · 行情走批量，一次拉齐（directQuotesOf）—— 它是大头；
 *   · 分红仍是逐只 —— 它在另一个接口（datacenter-web），而且 12 小时才变
 *     一次，为它单独做批量不划算。
 *
 * 并行是必要的，不是顺手：串起来的话，十几只标的的分红会一只只排队，
 * 用户看到的是「价格先出来了、息率还在一个个跳」，像页面在抽搐。
 */
function directDetails(items) {
  return Promise.all([
    directQuotesOf(items).catch(() => ({})),
    mapLimit(items, 4, (s) => directDividend(s).catch(() => null))
  ]).then((res) => {
    const quotes = res[0] || {}
    const dividends = res[1] || []

    const out = {}
    items.forEach((s, i) => {
      const key = batchKey(s)
      out[key] = { quote: quotes[key] || null, dividend: dividends[i] || null }
    })
    return out
  })
}

// 批量「行情 + 分红」，持仓页刷新用
function fetchDetails(list) {
  const items = (list || []).filter((s) => s && s.code)
  if (!items.length) return Promise.resolve({})

  return pick(
    () => cloud.request('/api/details', 'POST', { items }).then((r) => r.data || {}),
    // 见 directDetails：行情批量拉齐、分红逐只，两者并行
    () => directDetails(items),
    anyDetail
  ).then(fixHkDetailMap)
}

module.exports = {
  HOST,
  MARKET_BY_NO,
  request,
  search,
  fetchQuote,
  fetchFund,
  fetchDividend,
  fetchDetail,
  fetchQuotes,
  fetchDetails,
  fetchFx,
  batchKey
}
