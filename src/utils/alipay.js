/**
 * App 端调起支付宝 App 支付。
 *
 * 与微信那条路（utils/wxpay.js）最大的差别是**服务端给了什么**：
 *
 *   微信 —— 服务端先向微信下单，拿到 prepayid，再交给客户端 7 个字段，
 *           客户端把它们映射成 SDK 要的驼峰参数；
 *   支付宝 —— 服务端只做「拼参数 + 签名」，客户端拿到的是一整串 orderStr，
 *             直接递给 SDK 即可。
 *
 * 所以这里不做任何字段映射，也**不要试图拆开重组 orderStr**：
 * 字符串的拼法本身就是签名的一部分，动一个字符支付宝就验不过。
 *
 * 原生 SDK 同样必须**运行时注入**，不能在这里静态 require ——
 * 原因见 utils/wxpay.js 里那段很长的说明（简言之：Metro 会把缺失的模块
 * 编译成一个"一执行就把 native 层搞崩"的桩，try/catch 接不住，
 * 用户侧的表现是点一下按钮直接闪退）。这里沿用同一套写法。
 */

let sdk = null

/**
 * 由「装了支付宝 SDK 的构建」在启动时调用一次，把原生模块交进来。
 *
 * 目前**没有任何地方调用它** —— 与微信那边同理：要用支付宝 App 支付，
 * 得有开放平台应用、完成签约、上传应用公钥，这些到位之后再在 App 启动处加：
 *
 *   alipay.register(require('react-native-alipay'))
 *
 * 放在**启动处**而不是本文件里，是因为那时模块一定存在（否则构建会失败），
 * 错误当场就能发现，不会拖到用户点击时才崩。
 */
function register(moduleOrNull) {
  // 剥掉 ESM 的 default 包装。
  //
  // @uiw/react-native-alipay 的入口是 `export default class Alipay`，
  // Metro 转成 CJS 之后 require 回来的是 { default: Alipay, __esModule: true }。
  // 不剥这一层的话，下面 sdk.alipay 就是 undefined，available() 判 false，
  // 界面上永远不出现支付宝 —— 看起来像"这个库不工作"，其实只差一层解包。
  const m = moduleOrNull
  sdk = (m && m.default) || m || null

  // 自检一行。
  //
  // 为什么值得留在开发包里：这个库在链接失败时会**静默降级** ——
  // available() 返回 false，界面上就是"少了一个支付方式"，
  // 而看不出断在哪一环（包没装？autolinking 没认到？native 没注册？
  // 还是方法名不对？）。打一行出来，一次就能分辨。
  //
  // 注意别去打印 NativeModules 本身：它是个惰性 Proxy，
  // console.log 走 ownKeys 会得到 {} —— 那个空对象**不代表模块不存在**
  // （这个库自己的启动日志就是这么误导人的）。
  if (__DEV__) {
    console.log('[alipay] 注册:', sdk ? sdk.constructor && sdk.constructor.name : 'null', '｜ 可用:', available())
  }

  return sdk
}

// 取已注册的 SDK。没有就是没有 —— 这里绝不主动 require 任何东西。
function alipaySdk() {
  return sdk
}

/**
 * 这个包里有没有可用的支付宝 SDK。
 *
 * ⚠️ 整段必须包在 try 里。@uiw/react-native-alipay 在 native 模块没链接上时，
 * 导出的是一个 **Proxy**，访问它任何属性都会直接 throw（它自己的 index.js 里
 * 就是这么写的）。于是连 `typeof s.alipay` 这句都会抛异常 ——
 * 结果不是"支付宝不可用"，而是**会员页整个渲染不出来**。
 *
 * 注意这与 utils/wxpay.js 开头说的那种错误不同：那种是 Metro 编出来的桩，
 * 会崩 native 层，try/catch 接不住；这个是普通 JS 异常，接得住。
 */
function available() {
  const s = alipaySdk()
  if (!s) return false
  try {
    // 方法名是 alipay，不是 pay —— 这个库的导出是 class，
    // 签名方法是 static alipay(orderInfo)。认错名字的后果同上。
    return typeof s.alipay === 'function'
  } catch (e) {
    return false
  }
}

// 缺失时给一句能照着做的说明。措辞对齐服务端口径（都是引导去别的方式）
function reason() {
  if (available()) return ''
  return '支付宝支付尚未开通，可以先用微信支付，或用兑换码开通会员。'
}

/**
 * 调起支付宝。
 * params 来自服务端：{ orderStr, outTradeNo }，orderStr 必须原样传下去。
 */
function pay(params) {
  if (!available()) return Promise.reject({ code: -1, msg: reason() || '支付宝 SDK 不可用' })

  const p = params || {}
  const orderStr = String(p.orderStr || '').trim()
  if (!orderStr) return Promise.reject({ code: -1, msg: '下单参数不完整，请重试' })

  return Promise.resolve(alipaySdk().alipay(orderStr)).then((res) => {
    // 支付宝 SDK 用数字码表达结果：9000 成功、6001 用户中途取消。
    // 不同的 RN 插件把码放在不同字段上（resultStatus / resultCode / code），
    // 所以挨个取一遍；一个都取不到就**当成成功** —— 交给服务端轮询去判定，
    // 那边才是权威（官方也明说调起支付的回调可能丢失）。
    const code = pickCode(res)
    if (code && code !== '9000') {
      return Promise.reject({ code: -2, errCode: code, errStr: describe(code) })
    }
    return true
  })
}

function pickCode(res) {
  if (!res) return ''
  const cand = [res.resultStatus, res.resultCode, res.code, res.status]
  for (let i = 0; i < cand.length; i++) {
    const v = cand[i]
    if (v !== undefined && v !== null && String(v) !== '') return String(v)
  }
  return ''
}

// 只列用户实际会遇到的几个码，其余给一句通用话术
function describe(code) {
  if (code === '6001') return '已取消支付'
  if (code === '4000') return '支付失败，请重试'
  if (code === '5000') return '重复请求，请到订单里查看结果'
  if (code === '6002') return '网络连接异常，请重试'
  return '支付未完成'
}

// "用户主动取消"的判断不放在这里：它需要同时认识微信的 -2 和支付宝的 6001，
// 属于调用方的知识（见 Membership.js 的 isCanceled）。放在渠道里只会各写一半。

module.exports = { register, available, reason, pay }
