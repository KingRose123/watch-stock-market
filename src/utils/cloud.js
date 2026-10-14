/**
 * 服务端调用封装（React Native 版）。
 *
 * 与小程序那份的唯一区别是**身份来源**：
 *   小程序：云托管自动注入 X-WX-OPENID，客户端根本不用管登录；
 *   App：用户名 + 密码换 token，之后每个请求带 Authorization: Bearer。
 *
 * 请求形状和错误约定（resolve 服务端 JSON / reject { code, msg }）与原来**完全一致**，
 * 所以 utils/api.js 那一整套业务逻辑一行都不用改。
 */
const { API_BASE, DEFAULT_TIMEOUT, UPLOAD_TIMEOUT } = require('../config.js')
const storage = require('../compat/storage.js')
const { Platform } = require('react-native')

/**
 * 请求头里的应用标识。
 *
 * ⚠️ 不设它的话，安卓上发出去的是 okhttp 的默认 UA（`okhttp/4.9.2`），
 * iOS 上是 `CFNetwork/...` —— 后台「登录设备」那一列于是**每台设备都一模一样**，
 * 客服拿它什么都判断不出来（这一列本来就是为"这是不是他本人那台手机"存在的）。
 *
 * 带上平台和系统版本之后，至少能区分"一台安卓 vs 一台 iOS"，也能看出
 * 系统大版本 —— 用户说"我手机上有个问题"时，那是第一个要确认的东西。
 *
 * ⚠️ 这里**只用 Platform**，没去 require package.json 拿 App 版本号。
 * 那样写能让 UA 里多一个版本号，但代价是这个模块在**加载期**多一处可能失败
 * 的地方 —— 而它失败了就是整个 App 起不来。一个排查用的便利，不值得
 * 押上"App 能不能启动"。真需要版本号时，设置页里有，或者将来加一个
 * 构建期注入的常量。
 */
const APP_UA =
  'xiji-app (' + (Platform.OS === 'ios' ? 'iOS ' : 'Android ') + String(Platform.Version || '') + ')'

const TOKEN_KEY = 'authToken'
const UID_KEY = 'authUid'

// 401 时通知上层（App 会清登录态并跳登录页）
const listeners = new Set()

function onUnauthorized(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notifyUnauthorized(msg) {
  listeners.forEach((fn) => {
    try {
      fn(msg)
    } catch (e) {
      console.warn('[cloud] 401 回调出错', e && e.message)
    }
  })
}

function token() {
  return String(storage.get(TOKEN_KEY) || '')
}

function uid() {
  return String(storage.get(UID_KEY) || '')
}

function saveLogin(t, u) {
  storage.set(TOKEN_KEY, t)
  if (u) storage.set(UID_KEY, u)
}

function clearLogin() {
  storage.remove(TOKEN_KEY)
  storage.remove(UID_KEY)
}

function isLoggedIn() {
  return !!token()
}

/**
 * 就绪判断。小程序那份是「wx.cloud 能不能用」；
 * App 端没有这种不确定性 —— 本地数据读进内存就算就绪（见 index.js 的启动顺序）。
 */
function init() {
  return storage.isLoaded()
}

function enabled() {
  return init()
}

/**
 * 统一请求：成功 resolve 服务端 JSON，失败 reject 成 { code, msg }，
 * 与项目里 api.fail 的形状保持一致（页面上的 util.onError 靠这个判断）。
 *
 * ══ 超时必须自己保证 ══
 *
 * 这里原来只有 `signal: AbortSignal.timeout(...)`，而它被包在
 * "运行时有没有这个 API"的判断里 —— 没有的场合给的是 `signal: undefined`，
 * 也就是**完全没有超时**。
 *
 * 后果不是"慢"，而是"永远不动"：请求既不成功也不失败，页面的 loading
 * 状态不结束，`quote.js` 那边"失败就回退直连"的逻辑也永远等不到触发时机。
 * 用户看到的是一个永久转圈的界面 —— 这类**不产生任何异常和日志**的故障
 * 最难查，因为它看上去哪都没坏。
 *
 * 所以这里改成两道保险，且管的是**整件事**（含 res.text() 读 body ——
 * 只给 fetch 加超时的话，连接建好了但 body 迟迟不来，照样挂死）：
 *   1. 显式 AbortController：超时那一刻真正断掉连接，不把半开的连接留在
 *      手机的网络栈里；
 *   2. 独立的定时器 + Promise.race：即使运行时没有 AbortController，
 *      超时也一定能兑现。
 */
function request(path, method, data, timeout) {
  const t = token()
  const headers = { 'content-type': 'application/json' }
  // 见上面 APP_UA 的说明：不设的话后台那一列全是 okhttp/4.9.2。
  // 上传图片走的是另一个函数（uploadFile），但它的请求头里也带了这一行。
  headers['user-agent'] = APP_UA
  if (t) headers.authorization = 'Bearer ' + t
  const m = String(method || 'GET').toUpperCase()
  const ms = timeout || DEFAULT_TIMEOUT

  // 老运行时没有 AbortController 也能跑：超时由下面的 race 兜住，
  // 只是没法主动断掉底层连接
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null

  let timer = null
  let timedOut = false

  const work = fetch(API_BASE + path, {
    method: m,
    headers: headers,
    body: m === 'GET' || m === 'HEAD' ? undefined : JSON.stringify(data || {}),
    signal: ctl ? ctl.signal : undefined
  }).then((res) =>
    res.text().then((text) => {
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch (e) {
        // 网关偶尔会回一段 HTML（比如服务没起来），交给下面统一报错
        body = null
      }

      const okStatus = res.status >= 200 && res.status < 300
      if (okStatus && body && body.ok !== false) return body

      const msg = (body && body.msg) || '服务异常（' + res.status + '）'

      // token 过期/失效：清掉本地登录态并通知上层，避免后面每个请求都白跑
      if (res.status === 401 && token()) {
        clearLogin()
        notifyUnauthorized(msg)
      }

      throw { code: res.status, msg: msg }
    })
  )

  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      // 先断连接再 reject：下游拿到超时的同时，底层也别留个半开连接
      if (ctl) ctl.abort()
      reject({ code: 0, msg: '请求超时，请检查网络后重试' })
    }, ms)
  })

  return Promise.race([work, guard])
    .then(
      (v) => {
        clearTimeout(timer)
        return v
      },
      (e) => {
        clearTimeout(timer)
        throw e
      }
    )
    .catch((e) => {
      // 超时优先判定：abort 引发的 AbortError 和定时器几乎同时到达，
      // 靠 race 的先后去区分不可靠，用显式标记更稳
      if (timedOut) throw { code: 0, msg: '请求超时，请检查网络后重试' }
      // 上面主动抛的业务错误保持原样；这里只兜网络层
      if (e && e.code !== undefined) throw e
      throw { code: -1, msg: '网络异常，请检查网络后重试' }
    })
}

/* ---------------- 登录态 ----------------
 * 用户名 + 密码（注册时直接登录）。
 * 服务端只存 scrypt 哈希，密码本身不落库、也不会回传。
 */

// 注册：成功即登录，返回 token
function register(username, password) {
  return request('/api/auth/register', 'POST', { username: username, password: password })
}

// 登录：换 token
function loginByPassword(username, password) {
  return request('/api/auth/login', 'POST', { username: username, password: password })
}

// 冷启动校验 token 是否还有效
function me() {
  return request('/api/auth/me', 'GET')
}

function logout() {
  // 先请求再清本地：服务端删 token 需要带着它
  return request('/api/auth/logout', 'POST', {}).catch(() => null).then(() => {
    clearLogin()
    return true
  })
}

/**
 * 注销账号：服务端删账号 + 全部业务数据（本机那份由 api.destroyAccount 清）。
 * 注意它和 logout 不是一回事：logout 只让凭证失效、数据留着。
 */
function destroyAccount() {
  return request('/api/auth/account', 'DELETE')
}

/* ---------------- 用户数据快照 ---------------- */

function getState() {
  return request('/api/state', 'GET')
}

function saveState(payload) {
  return request('/api/state', 'PUT', { payload: payload }, UPLOAD_TIMEOUT)
}

function clearState() {
  return request('/api/state', 'DELETE')
}

/* ---------------- 会员 ---------------- */

function getMembership() {
  return request('/api/membership', 'GET')
}

function redeemMembership(code) {
  return request('/api/membership/redeem', 'POST', { code: code })
}

// 支付方式与「去哪买兑换码」的说明。文案在服务端，改渠道不用发版。
function getPayChannels() {
  return request('/api/membership/pay/channels', 'GET')
}

/**
 * 会员支付：App 端走「渠道可选」的下单接口。
 *
 * channel 取 wxpay / alipay；不传则由服务端挑第一个已就绪的渠道。
 *
 * 拿回来的东西两家**不一样，不要试图统一**：
 *   微信 —— appid / partnerid / prepayid / package / noncestr / timestamp / sign；
 *   支付宝 —— 一整串 orderStr。
 * 各自的 SDK 封装知道怎么用自己那份（utils/wxpay.js、utils/alipay.js）。
 *
 * 小程序那套虚拟支付在 App 里没有对应接口，服务端的 vpay 只留给小程序用。
 */
function payPrepay(plan, channel) {
  const body = { plan: plan }
  if (channel) body.channel = channel
  return request('/api/membership/pay/prepay', 'POST', body)
}

/**
 * 兼容旧路径：服务端把 /appay/prepay 当成「锁定微信」的别名留着 ——
 * 现网已装的 App 把它写死了，删掉等于让那批用户点支付就 404。
 * 等他们升上来之后可以删，与 /vpay/order 那个别名是同一回事。
 */
function appayPrepay(plan) {
  return request('/api/membership/appay/prepay', 'POST', { plan: plan })
}

/**
 * 订单状态：支付完成回到 App 后要回来查一次 ——
 * 微信的支付结果回调可能丢失，以服务端有没有发货为准。
 */
function getOrderStatus(outTradeNo) {
  return request('/api/membership/vpay/order?outTradeNo=' + encodeURIComponent(outTradeNo || ''), 'GET')
}

/* ---------------- 首页文章 ----------------
 * 内容由后台的「首页文章」页维护，改完立刻生效、不需要发版。
 *
 * 这两个接口是**公开**的（不需要登录），但这里仍然只在登录后才去拉 ——
 * 未登录时首页直接用内置内容（见 utils/api.js 的 getCommunityFeed），
 * 免得首屏多一次注定失败的往返。
 */
function getCommunityArticles() {
  return request('/api/community/articles', 'GET')
}

/**
 * 投票。读取是**公开**的（未登录也能看题目和选项），投票要求登录。
 *
 * 票为什么必须记在人身上：只有知道是谁投的，才有"一人一票"（服务端靠
 * poll_vote 的主键实现），统计也才有意义 —— 否则同一个人连点几次就是几票。
 * 所以 votePoll 是这里唯一一个会**因为没有登录而失败**的接口。
 */
function getCommunityPolls() {
  return request('/api/community/polls', 'GET')
}

function getCommunityPoll(id) {
  return request('/api/community/polls/' + encodeURIComponent(String(id || '')), 'GET')
}

function votePoll(id, option) {
  return request('/api/community/polls/vote', 'POST', { id: id, option: option })
}

function getCommunityArticle(id) {
  return request('/api/community/articles/' + encodeURIComponent(String(id || '')), 'GET')
}

/**
 * 个股新闻：公司公告 + 个股资讯 + 行业政策。
 *
 * ⚠️ 服务端要求**会员**，非会员回 **402**。App 那边 util.onError 认得这个码，
 * 会自动弹出"需要会员权限 → 去看看"的引导（见 utils/util.js 的 paywall），
 * 所以调用方**不必**自己再做一次会员判断 —— 不过页面想避免"一进来就弹窗"
 * 的话，可以先看 membership.current().isPaid（HoldingDetail 就是这么做的）。
 *
 * code 为空时只返回行业政策（"还没选股票就想看看"的场景，不是错误）。
 */
function getStockNews(code, market, limit) {
  return request(
    '/api/stock/news?code=' + encodeURIComponent(String(code || '')) +
      '&market=' + encodeURIComponent(String(market || '')) +
      '&limit=' + encodeURIComponent(String(limit || 30)),
    'GET'
  )
}

module.exports = {
  API_BASE,
  onUnauthorized,
  init,
  enabled,
  request,
  token,
  uid,
  isLoggedIn,
  saveLogin,
  clearLogin,
  register,
  loginByPassword,
  me,
  logout,
  destroyAccount,
  getState,
  saveState,
  clearState,
  getMembership,
  redeemMembership,
  getPayChannels,
  payPrepay,
  appayPrepay,
  getOrderStatus,
  getCommunityArticles,
  getCommunityArticle,
  getCommunityPolls,
  getCommunityPoll,
  votePoll,
  getStockNews
}
