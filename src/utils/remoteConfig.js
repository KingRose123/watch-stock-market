/**
 * 远程配置（后台可下发，改完立刻生效，不用发版）。
 *
 * ══ 为什么要"拉取 + 缓存 + 同步读" ═══════════════════════
 *
 * 调这个模块的地方（membership.limits()、各种 check*）都是**同步**的 ——
 * 它们在渲染路径上被调用，没法等一个 Promise。
 * 所以这里做成：
 *
 *   App 启动 → 异步拉一次 → 写进内存 + 本地存储
 *   各处调用 → 同步读（内存 → 本地存储 → 内置默认值）
 *
 * 于是"远程配置"对调用方而言是透明的：它看不到网络、看不到异步。
 *
 * ══ 三层兜底，缺一不可 ══════════════════════════════════
 *
 *   1. 内存：本次运行拿到的值
 *   2. 本地存储：上次成功拉取的值（离线启动时用）
 *   3. 内置默认值：这份 DEFAULTS（从没拉成功过时用）
 *
 * 三层都有的原因是：**配置读不到时绝不能报错**。
 * 一个网络抖动导致 App 首页崩溃，比"这次的额度是旧值"严重得多。
 *
 * ⚠️ 内置默认值必须与后端 schema.sql 里 app_config 的初始值**逐项一致**。
 * 两边不一致的后果很隐蔽：刚部署完、还没人动过后台，
 * 用户看到的行为却和服务端以为的不一样。改任何一边都要同步另一边。
 */
const KEY = 'remote_config_v1'

/** 内置默认值 —— 与 server-go/internal/db/schema.sql 的初始值保持一致 */
const DEFAULTS = {
  free_for_all: 'false',

  limits_free_holdings: '3',
  limits_free_accounts: '1',
  limits_free_overseas: 'false',
  limits_free_ocr: '5',
  limits_free_plans: '3',
  limits_free_fundamental: '5',
  limits_free_watch: '5',
  limits_free_analysis: 'false',
  limits_free_screener: '5',

  limits_lite_holdings: '-1',
  limits_lite_accounts: '1',
  limits_lite_overseas: 'false',

  limits_pro_holdings: '-1',
  limits_pro_accounts: '10',
  limits_pro_overseas: 'true',

  announcement: ''
}

// 内存缓存。null 表示"还没拉过"，此时回退到本地存储。
let memory = null

function storageGet() {
  try {
    // 用 compat/storage 而不是直接调 wx.*：它在 App 端是 AsyncStorage 的同步封装、
    // 在小程序端就是 wx.getStorageSync，两边行为一致（见 compat/storage.js）
    const storage = require('../compat/storage.js')
    const raw = storage.get(KEY)
    if (!raw) return null
    // storage 里存的可能是字符串（首次写入时 JSON.stringify 过），
    // 也可能是对象（有些平台的实现会自己序列化），两种都要认
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (e) {
    // 存储损坏（比如上次写入被强杀截断）不该让 App 起不来，
    // 直接当成"没有缓存"，走内置默认值
    return null
  }
}

function storageSet(obj) {
  try {
    const storage = require('../compat/storage.js')
    storage.set(KEY, JSON.stringify(obj))
  } catch (e) {
    /* 存不下就算了：下次启动重新拉一遍即可，不影响本次运行 */
  }
}

/** 读一个配置项（同步）。 */
function get(key) {
  const src = memory || storageGet() || {}
  const v = src[key]
  if (v === undefined || v === null || v === '') {
    return DEFAULTS[key]
  }
  return v
}

function getBool(key) {
  return String(get(key)) === 'true'
}

/**
 * 读一个数字。
 *
 * 解析失败时回退到内置默认值而不是 0：
 * 0 在额度语义里是"一个都不许"，会让用户直接没法用；
 * 而 -1（默认值里的"不限"）至少不会把功能锁死。
 */
function getInt(key) {
  const n = parseInt(get(key), 10)
  if (isNaN(n)) {
    const d = parseInt(DEFAULTS[key], 10)
    return isNaN(d) ? -1 : d
  }
  return n
}

function getStr(key) {
  const v = get(key)
  return v === undefined || v === null ? '' : String(v)
}

/**
 * 按档位取出整张额度表。
 *
 * 键名规则 limits_<tier>_<item>，与后端 schema.sql 的约定一致。
 * 这样以后加额度项只要加键，这里不用改 ——
 * 如果写成一个个 getBool('limits_free_overseas')，加一项就要改一次代码。
 */
function limitsFor(tier, fallback) {
  const t = ['free', 'lite', 'pro'].indexOf(tier) >= 0 ? tier : 'free'
  const num = (item) => {
    const k = 'limits_' + t + '_' + item
    return k in DEFAULTS ? getInt(k) : fallback[item]
  }
  const bool = (item) => {
    const k = 'limits_' + t + '_' + item
    return k in DEFAULTS ? getBool(k) : fallback[item]
  }

  // 只覆盖「有远程键」的那几项，其余（ocr/plans/...）沿用传入的 fallback。
  // 这样即使后台只配了部分项，也不会把没配的项变成 undefined。
  const out = Object.assign({}, fallback)
  ;['holdings', 'accounts', 'ocr', 'plans', 'fundamental', 'watch', 'screener'].forEach((k) => {
    if ('limits_' + t + '_' + k in DEFAULTS) out[k] = num(k)
  })
  ;['overseas', 'analysis'].forEach((k) => {
    if ('limits_' + t + '_' + k in DEFAULTS) out[k] = bool(k)
  })
  return out
}

/**
 * 配置更新后的通知。
 *
 * 为什么需要它：配置是**启动后异步拉**的，而首页公告要在拉完之后才能显示 ——
 * 页面首次渲染时读到的往往是上一轮的缓存（或者内置默认值，也就是空）。
 * 没有这个通知的话，用户要切一次 tab 再回来才看得见公告。
 *
 * 用回调数组而不是事件总线：现在只有首页公告一个订阅方，
 * 引入一套 on/emit 机制反而是负担。等订阅方多起来再说。
 */
const listeners = []

/** 订阅配置更新，返回取消订阅的函数。 */
function subscribe(fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.push(fn)
  return () => {
    const i = listeners.indexOf(fn)
    if (i >= 0) listeners.splice(i, 1)
  }
}

function notifyChanged() {
  // 复制一份再遍历：订阅方在回调里取消订阅是常见写法，
  // 直接遍历原数组会跳过元素
  listeners.slice().forEach((fn) => {
    try {
      fn()
    } catch (e) {
      // 一个订阅方出错不该连累其他订阅方，
      // 更不该让"配置拉取成功"这件事本身看起来失败了
    }
  })
}

/**
 * 上次拉取的时间 + 最小间隔。
 *
 * 为什么需要节流：load() 除了启动时会调，页面 onShow 也会调 ——
 * 而 onShow 在「切 tab」和「从后台回到前台」时都会触发，
 * 用户手上切几下就会打出七八个请求。配置的变更频率是「运营偶尔改一次」，
 * 完全没必要这么勤。
 *
 * 30 秒是权衡出来的：
 *   · 再长（试过 5 分钟）会让「后台改完 → 切个 tab 看看」这个动作失效 ——
 *     而运营验证公告的方式恰恰就是它，看不到就会以为改坏了；
 *   · 再短没有意义：人来回切几次 App 就能打出十几个请求，
 *     而配置的变更频率是「偶尔改一次」。
 *
 * 想立刻看到最新配置，最可靠的仍然是**冷启动**（那条路径不走节流）。
 */
const MIN_RELOAD_GAP = 30 * 1000
let lastLoadAt = 0

/**
 * 从服务端拉一次配置。
 *
 * 失败**不抛错**：调用方（App.js）在启动时不 await 它，
 * 它自己吞掉异常并保留旧缓存 —— 配置拉不到就用旧的，是这里唯一合理的行为。
 *
 * @param {boolean} force 跳过节流强制拉取（调试或"刚改完配置"时用）
 */
function load(force) {
  const now = Date.now()
  if (!force && now - lastLoadAt < MIN_RELOAD_GAP) {
    // 节流期内不动网络。注意这里 resolve(false) 而不是把上次的结果缓存下来 ——
    // false 的语义就是"本次没有新数据"，与网络失败时一致，
    // 调用方不需要为"被节流"单独写一个分支
    return Promise.resolve(false)
  }
  lastLoadAt = now

  let cloud
  try {
    cloud = require('./cloud.js')
  } catch (e) {
    return Promise.resolve(false)
  }

  return cloud
    .request('/api/config', 'GET')
    .then((res) => {
      const cfg = res && res.data ? res.data.config : null
      if (cfg && typeof cfg === 'object') {
        memory = cfg
        storageSet(cfg)
        notifyChanged()
        return true
      }
      return false
    })
    .catch(() => {
      // 拉不到就沿用缓存里的旧值。**这里绝不能抛错，也不能清空缓存** ——
      // 一次网络抖动不该让用户看到"额度突然变了"，
      // 更不该让首页因为配置拉取失败而白屏
      return false
    })
}

/** 当前配置快照（调试用）。 */
function snapshot() {
  return Object.assign({}, DEFAULTS, storageGet() || {}, memory || {})
}

module.exports = {
  KEY,
  DEFAULTS,
  load,
  subscribe,
  get,
  getBool,
  getInt,
  getStr,
  limitsFor,
  snapshot,
  /** 仅供测试：注入一份配置 */
  _setForTest(obj) {
    memory = obj
  }
}
