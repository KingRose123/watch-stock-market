const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, Modal, StyleSheet, Animated, Easing } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const wxpay = require('../utils/wxpay.js')
const alipay = require('../utils/alipay.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

/**
 * 客户端认识的支付渠道。
 *
 * enabled 问的是「这个包里装没装对应的原生 SDK」。它和服务端的就绪状态
 * 是**两个独立条件**：服务端配好了只代表后端能下单，客户端没装 SDK 照样调不起来。
 * 两个都满足才把选项显示出来 —— 否则用户点了才发现不行，那是我们造成的挫败感。
 *
 * 不认识的渠道名直接丢掉：服务端加了新渠道而客户端还没更新时，
 * 宁可不显示，也不要渲染一个点不动的按钮。
 */
const CHANNEL_META = {
  wxpay: { key: 'wxpay', name: '微信支付', enabled: () => wxpay.available() },
  alipay: { key: 'alipay', name: '支付宝', enabled: () => alipay.available() }
}

// 把服务端给的渠道名列表变成可渲染的选项（顺序跟随服务端，那是它的优先级）
function availableChannels(names) {
  const out = []
  ;(names || []).forEach((k) => {
    const meta = CHANNEL_META[k]
    if (!meta) return
    if (!meta.enabled()) return
    out.push(meta)
  })
  return out
}

/**
 * 判断「用户自己取消了支付」。
 *
 * 两家的取消码不同：微信 -2、支付宝 6001。它决定了要不要弹窗打扰 ——
 * 判错的代价是每次主动取消都弹一个「支付未完成」，次数多了很烦人。
 * 所以宁可多写一个判断，也不图省事一律弹窗。
 */
function isCanceled(e) {
  if (!e) return false
  const c = String(e.errCode === undefined ? e.code : e.errCode)
  return c === '-2' || c === '6001'
}

/**
 * 让 Pressable 也能吃 Animated 的 style。
 *
 * 收银台的遮罩和弹窗都要"可点"且"能动"，这两个能力分属 Pressable 和
 * Animated.View，只能把它们合起来用。
 */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * 收银台的两段动画时长（毫秒）。
 *
 * 遮罩和弹窗**必须分开驱动**。RN 的 Modal 只有一个 animationType，它把
 * 整块内容（遮罩 + 弹窗）当做一个整体：写 "slide" 是两样一起从底部推上来
 * —— 遮罩也跟着上移，看着像一整块幕布被吊起来；写 "fade" 则是一起渐显。
 * 想要「遮罩立刻出现、只有弹窗自己滑上来」，就得把动画从 Modal 手里拿回来。
 *
 * 280ms 是底部弹层的常用值：短于 200 显得仓促，长于 350 会让人等。
 */
const CASH_SLIDE_MS = 280
// 收起比展开快一档：退场没人愿意等，利落一点反而更好。
const CASH_CLOSE_MS = 220
// 弹窗高度的兜底值。
//
// 第一次打开时还不知道它有多高 —— onLayout 要等挂载之后才回调，而动画在
// 那之前就开始了。先用这个值把它摆到屏幕外，量到之后换成真实高度，
// 之后每次开合都精确。
const CASH_FALLBACK_H = 460

/** 会员页：当前档位 + 权益对比 + 方案选择。 */
class Membership extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      ready: false, // 本地权益数据已渲染
      error: false, // 连本地数据都拿不到（理论上不该发生，兜底用）
      submitting: false,

      status: {},
      tiers: [],
      features: [],
      plans: [],
      notes: [],
      // 当前选中的方案（底部购买栏读它）
      pickedKey: '',
      picked: {},
      // 权益表的标题与脚注：免费开放期会换成「档位规划」的说法，由 api 层给
      tableTitle: '',
      tableNote: '',
      // 兑换码弹窗（RN 没有 editable 的 showModal，自己画一个）
      codeOpen: false,
      code: '',
      // 「去哪买兑换码」的说明，来自服务端（卖码渠道会变，写死就得发版）。
      // 拿不到时为 null，页面用兜底文案。
      guide: null,
      guideOpen: false,
      // 可以用的支付渠道（服务端说已就绪 **且** 本机装了 SDK）。
      // 空数组 = 一个都用不了，购买入口会引导去兑换码。
      channels: [],
      // 当前选中的渠道。用户手动切过之后，页面刷新要保留他的选择。
      pickedChannel: '',
      // 是否处于「收银台开发预览」（服务端还没就绪，界面先按假数据画出来）。
      // 真实就绪时恒为 false，界面不会出现任何提示。
      payPreview: false,
      // 收银台弹层。点底部「立即开通」时才打开 ——
      // 支付方式是每次付款选一次的东西，不常驻在页面上（见 render 里的说明）。
      cashierOpen: false
    }

    // 收银台的两段动画。放在实例上而不是 data 里：它们每帧都在变，
    // 进 data 就等于每帧一次 setData（整页重渲染）。Animated.Value 交给
    // 原生驱动，本来就不经过 JS 渲染，没必要绕这一圈。
    this.maskFade = new Animated.Value(0) // 遮罩透明度
    this.sheetY = new Animated.Value(0) // 弹窗的纵向位移
    this.sheetH = 0 // 弹窗实测高度，决定"从多下面滑上来"
  }

  onLoad() {
    this.load()
  }

  // 开通 / 兑换回来，重新对齐一次档位
  onShow() {
    if (this.data.ready) this.load()
  }

  /* ---------------- 渲染 ---------------- */

  apply(d) {
    // 已选的方案优先保留，否则用默认档（热门 Pro）
    const keys = d.plans.map((p) => p.key)
    const pickedKey = keys.indexOf(this.data.pickedKey) > -1 ? this.data.pickedKey : d.defaultPlanKey

    this.setData({
      ready: true,
      error: false,
      status: d.status,
      tiers: d.tiers,
      features: d.features,
      plans: d.plans,
      notes: d.notes,
      tableTitle: d.tableTitle,
      tableNote: d.tableNote,
      pickedKey: pickedKey,
      picked: d.plans.filter((p) => p.key === pickedKey)[0] || {}
    })
  }

  /**
   * 权益表与方案都是本地定义，先同步渲染出来 ——
   * 这个页面是用户「看自己有哪些权益」的地方，不能因为一次网络请求慢或失败就一片空白。
   * 渲染完再去服务端对齐档位（换设备登录后需要），拿到后重渲染一次。
   */
  load() {
    try {
      this.apply(api.membershipVM())
    } catch (e) {
      console.error('[membership] 权益数据渲染失败', e)
      this.setData({ ready: false, error: true })
      return Promise.resolve()
    }

    // 购买指引跟主数据**并行**取，而且失败不算错：
    // 它只是「去哪买码」的一段说明，拿不到就退化成兜底文案，
    // 不能让这页本身跟着失败（api 层已经把失败转成空结果了）。
    api.getPayChannels().then((res) => {
      const d = (res && res.data) || {}
      let chans = availableChannels(d.channels)
      let preview = false

      /**
       * 【开发期预览】服务端一个渠道都没就绪时，用假列表把收银台画出来。
       *
       * 为什么需要它：收银台的显示条件是「服务端已就绪 **且** 本机装了 SDK」，
       * 而凭证（商户号、开放平台应用）往往要等很久。在那之前这一整块是空的 ——
       * 布局、文案、切换手感都没法看。
       *
       * ⚠️ 三条边界，缺一条就会变成"假的当成真的"：
       *   1. 只在 __DEV__ 下生效，正式包不会走到这里；
       *   2. 只在**服务端返回空**时兜底 —— 配好任意一个渠道后它就自动让位；
       *   3. 用 CHANNEL_META 直接取，**不过 availableChannels 的 SDK 过滤** ——
       *      预览本来就是为了看"两个都长什么样"，而微信的 SDK 还没装。
       *      正因如此，下面必须把 preview 标出来，让界面和点击都区别对待。
       */
      if (__DEV__ && !chans.length) {
        chans = [CHANNEL_META.wxpay, CHANNEL_META.alipay]
        preview = true
      }

      // 已选的渠道优先保留（用户刚切到支付宝，一次页面刷新不该把它改回去），
      // 但它要是变得不可用了（服务端下架、或 SDK 不可用），就退回第一个可用的。
      const keys = chans.map((c) => c.key)
      const picked = keys.indexOf(this.data.pickedChannel) > -1 ? this.data.pickedChannel : keys[0] || ''
      this.setData({
        guide: d.guide || null,
        channels: chans,
        pickedChannel: picked,
        payPreview: preview
      })
    })

    return api
      .syncMembership()
      .then((changed) => {
        if (changed) this.apply(api.membershipVM())
      })
      .catch(() => null)
  }

  onRetry() {
    this.setData({ error: false })
    this.load()
  }

  /* ---------------- 方案选择 ---------------- */

  onPick(e) {
    const key = e.currentTarget.dataset.key
    this.setData({
      pickedKey: key,
      picked: this.data.plans.filter((p) => p.key === key)[0] || {}
    })
  }

  /* ---------------- 开通 ---------------- */

  /**
   * 打开收银台。两段动画分开走，这是这个弹层的全部重点：
   *
   *   · **遮罩不做淡入**，挂载即到位。付款是一个明确的状态切换，
   *     慢慢淡进来会让头两百毫秒处在"半暗不暗"的暧昧状态；而遮罩一亮，
   *     用户立刻知道"我进到付款这一步了"。（iOS 的操作表也是这么做的。）
   *
   *   · **弹窗从屏幕下方滑上来**，带减速 —— 需要"被看见"的是它。
   *
   * 如果哪天改回 Modal 的 animationType，这两个效果会一起消失：
   * 那个属性管的是整块内容，做不到一半立刻生效、一半慢慢来。
   */
  openCashier() {
    this.setData({ cashierOpen: true })
    this.maskFade.setValue(1)
    // 先摆到屏幕外，再滑回来。起点用上次量到的高度（首次用兜底值）。
    this.sheetY.stopAnimation()
    this.sheetY.setValue(this.sheetH || CASH_FALLBACK_H)
    Animated.timing(this.sheetY, {
      toValue: 0,
      duration: CASH_SLIDE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    }).start()
  }

  /**
   * 带动画地收起收银台。
   *
   * **必须等动画结束再卸载 Modal**。反过来先 setData 收起的话，弹层会直接
   * 消失，用户看到的是"啪"地一下不见了，而不是滑走 —— 那比不做动画更糟。
   *
   * 遮罩同时淡出。它和弹窗现在是**兄弟**关系，所以淡出不会连带把弹窗也变透明
   * （父子关系就会，那会让弹窗一边下滑一边消隐）。
   */
  closeCashier() {
    this.sheetY.stopAnimation()
    Animated.timing(this.sheetY, {
      toValue: this.sheetH || CASH_FALLBACK_H,
      duration: CASH_CLOSE_MS,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true
    }).start(() => this.setData({ cashierOpen: false }))
    Animated.timing(this.maskFade, {
      toValue: 0,
      duration: CASH_CLOSE_MS,
      useNativeDriver: true
    }).start()
  }

  /**
   * 开通：服务端下单签名 → 微信 SDK 调起支付 → 回来轮询等发货。
   *
   * 与小程序那版的差别：那边是 wx.requestVirtualPayment（小程序虚拟支付通道），
   * App 端没有这个接口，走的是微信支付 APIv3 的 APP 支付，靠原生 SDK 调起
   * （见 utils/wxpay.js）。
   *
   * 点这个按钮**不直接发起支付**，只负责打开收银台 —— 真正下单在 onPay。
   * 顺序不能反：那样用户每切一次支付方式就会多出一个待支付订单。
   *
   * 链路要走起来得同时满足两件事：服务端至少有一个渠道就绪 + 包里装了对应的
   * 原生 SDK。缺任何一个，这里都会把人引向兑换码那条路（见下面 channels 的判断）。
   */
  onBuy() {
    // 免费开放期不卖会员 —— 兜底拦一道，万一入口被绕过也不该收钱
    if (this.data.status && this.data.status.selling === false) {
      wx.showToast({ title: '当前全员免费，无需开通', icon: 'none' })
      return
    }

    const plan = this.data.picked
    if (!plan || !plan.key || this.data.submitting) return

    // 一个渠道都拿不到时直接引导去兑换码，别弹一个空收银台
    // （原生 SDK 没打进包里、或服务端凭证还没配齐，都会走到这里）
    if (!this.data.channels.length) {
      wx.showModal({
        title: '暂不支持在线支付',
        content: wxpay.reason() || '可以先用兑换码开通会员。',
        showCancel: false
      })
      return
    }

    // 只开收银台，**不下单** —— 下单挪到 onPay（用户选完点「确认支付」）。
    // 顺序反了的话，用户每切换一次支付方式就会多出一个待支付订单。
    this.openCashier()
  }

  /**
   * 收银台里点「确认支付」：下单 → 调起对应的支付 SDK。
   *
   * 渠道校验放在这一步而不是 onBuy：收银台打开时只能保证"至少有一个可用渠道"，
   * 而用户可能在里面切到另一个 —— 中间任何一步都不该指望旧值。
   */
  onPay() {
    const plan = this.data.picked
    const channel = this.data.pickedChannel
    if (!plan || !plan.key || this.data.submitting) return

    // 先收起银台再发起支付：调起 SDK 时它会被支付 App 盖住，
    // 留着的话用户付完回来会看到一个还开着的弹层，以为没付成功。
    //
    // 这里是**直接卸载、不做动画**（不同于 closeCashier）：下一步要么是
    // 支付 App 整个盖上来，要么是一个原生提示框，都在弹层之上 ——
    // 再让弹层滑两百毫秒，只会和后面那个界面打架。
    this.setData({ cashierOpen: false })

    // 预览模式下不真的下单：服务端那个渠道压根没就绪，请求必然失败，
    // 而弹出来的"下单失败"会把人引向错误方向 —— 真正的原因是凭证没配，
    // 不是下单逻辑有问题。
    if (this.data.payPreview) {
      wx.showModal({
        title: '界面预览',
        content: '支付凭证还没配置，这里只是先看收银台的样子。配好之后，点这里才会真正调起支付。',
        showCancel: false
      })
      return
    }

    const meta = CHANNEL_META[channel]
    if (!meta || !meta.enabled()) {
      wx.showModal({
        title: '暂不支持该支付方式',
        content: wxpay.reason() || '请换一种支付方式，或使用兑换码。',
        showCancel: false
      })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '创建订单', mask: true })

    api
      .createMembershipOrder(plan.key, channel)
      .then((res) => {
        wx.hideLoading()
        if (!res || res.code !== 0) throw { msg: (res && res.msg) || '下单失败' }
        this.pay(channel, res.data)
      })
      .catch((e) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        util.onError(e)
      })
  }

  /**
   * 按渠道调起收银台。参数全部来自服务端，客户端不改动其中任何一个。
   *
   * 两家 SDK 的入参形状完全不同（微信要 7 个字段，支付宝要一整串 orderStr），
   * 所以分派放在这里、各自的处理放在 utils 里 —— 这一层只认渠道名，
   * 不认识任何一家的字段，加第三个渠道时这里不用动逻辑。
   *
   * ⚠️ outTradeNo 从**服务端响应**里取，不依赖 SDK 的回调返回：
   * 两家都明说调起结果可能丢（尤其 Android 上进程被回收时），
   * 而"这笔单子的号"是服务端给的，比 SDK 报的可靠。
   */
  pay(channel, params) {
    const sdk = channel === 'alipay' ? alipay : wxpay
    const outTradeNo = (params && params.outTradeNo) || ''

    sdk
      .pay(params)
      .then(() => this.awaitDelivery(outTradeNo))
      .catch((e) => {
        this.setData({ submitting: false })
        // 用户主动取消（微信 -2 / 支付宝 6001）不必打扰
        if (isCanceled(e)) return
        wx.showModal({
          title: '支付未完成',
          content: (e && (e.errStr || e.msg)) || '请稍后重试',
          showCancel: false
        })
      })
  }

  /**
   * 支付成功后等发货。
   * 官方明确说调起支付的回调可能丢失，所以不能只看它 ——
   * 回来轮询服务端的订单状态，以服务端有没有发货为准。
   */
  awaitDelivery(outTradeNo) {
    if (!outTradeNo) return this.load()

    wx.showLoading({ title: '开通中', mask: true })
    let tries = 0

    const tick = () => {
      tries++

      api
        .getOrderStatus(outTradeNo)
        .then((res) => {
          const d = (res && res.data) || {}

          if (d.status === 'paid') {
            wx.hideLoading()
            this.setData({ submitting: false })
            wx.showToast({ title: '已开通', icon: 'success' })
            this.load()
            return
          }

          if (tries >= 6) {
            wx.hideLoading()
            this.setData({ submitting: false })
            wx.showModal({
              title: '正在开通',
              content: '支付已成功，开通可能还需一会儿。稍后回到本页会自动刷新；若长时间未开通，请联系我们。',
              showCancel: false
            })
            this.load()
            return
          }

          setTimeout(tick, 1500)
        })
        .catch(() => {
          wx.hideLoading()
          this.setData({ submitting: false })
          wx.showToast({ title: '支付已成功，稍后自动开通', icon: 'none' })
          this.load()
        })
    }

    tick()
  }

  /* ---------------- 兑换码 ---------------- */

  // 兑换码：校验在服务端，本地不硬编码任何码
  onRedeem() {
    this.setData({ codeOpen: true, code: '' })
  }

  closeCode() {
    this.setData({ codeOpen: false })
  }

  // 「怎么拿到兑换码」。没有独立页面，用一个弹窗就够 ——
  // 内容只有几句：去哪买、怎么收到码、在哪兑换。
  openGuide() {
    this.setData({ guideOpen: true })
  }

  closeGuide() {
    this.setData({ guideOpen: false })
  }

  submitCode() {
    const code = String(this.data.code || '').trim()
    // 空码时以前是静默返回，用户点了「确定」像没反应；这里给出明确提示
    if (!code) {
      wx.showToast({ title: '请输入兑换码', icon: 'none' })
      return
    }
    if (code.length < 4) {
      wx.showToast({ title: '兑换码长度不对', icon: 'none' })
      return
    }

    this.setData({ codeOpen: false })
    util
      .submit(this, api.redeemMembership(code), { loadingText: '兑换中', success: '已开通' })
      .then((res) => {
        if (res) this.load()
      })
  }

  /* ---------------- 渲染 ---------------- */

  renderPlan(item) {
    const on = item.key === this.data.pickedKey

    return (
      <Pressable
        key={item.key}
        style={[styles.plan, on ? styles.planOn : null]}
        onPress={() => this.onPick(tap({ key: item.key }))}
      >
        {item.badge ? (
          <View style={[styles.planBadge, item.best ? styles.planBadgeBest : null]}>
            <Text style={[styles.planBadgeText, item.best ? styles.planBadgeBestText : null]}>
              {item.badge}
            </Text>
          </View>
        ) : null}

        <View style={styles.planHead}>
          <View style={s.flex1}>
            <View style={s.row}>
              <Text style={styles.planName}>{item.name}</Text>
              {item.owned ? <Text style={styles.planOwn}>使用中</Text> : null}
            </View>
            {item.subText ? <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>{item.subText}</Text> : null}
          </View>
          <View style={styles.planPrice}>
            <Text style={[styles.planNum, s.num]}>{item.priceText}</Text>
            {item.unit ? <Text style={styles.planUnit}>{item.unit}</Text> : null}
            {item.originText ? <Text style={styles.planStrike}>{item.originText}</Text> : null}
          </View>
        </View>

        {item.metaText ? <Text style={styles.planMeta}>{item.metaText}</Text> : null}
        {item.tip ? <Text style={styles.planTip}>💡 {item.tip}</Text> : null}
      </Pressable>
    )
  }

  /**
   * 一行支付方式 —— 单选，不是多选按钮：一次只能用一个渠道付。
   *
   * 用自绘的单选圈而不是系统的 RadioButton：本页所有选中态（方案卡片、
   * 权益表的 Pro 列）都是"描边 + 浅底"这一套，混进一个系统控件会突兀。
   */
  renderChannel(ch) {
    const on = ch.key === this.data.pickedChannel
    return (
      <Pressable
        key={ch.key}
        style={[styles.payMethod, on ? styles.payMethodOn : null]}
        onPress={() => this.setData({ pickedChannel: ch.key })}
      >
        <Text style={[s.mid, s.flex1]}>{ch.name}</Text>
        <View style={[styles.payRadio, on ? styles.payRadioOn : null]}>
          {on ? <View style={styles.payRadioDot} /> : null}
        </View>
      </Pressable>
    )
  }

  render() {
    if (this.data.error) {
      return (
        <View style={s.page}>
          <View style={[s.card, styles.err]}>
            <Text style={styles.errEmoji}>😵</Text>
            <Text style={[s.h3, { marginTop: 8 }]}>会员权益加载失败</Text>
            <Text style={[s.tiny, s.dim, { marginTop: 8, textAlign: 'center' }]}>
              请点重试；如果一直失败，可通过「我的 → 联系我们」反馈
            </Text>
            <Pressable style={styles.errBtn} onPress={() => this.onRetry()}>
              <Text style={styles.errBtnText}>重试</Text>
            </Pressable>
          </View>
        </View>
      )
    }

    const st = this.data.status
    const selling = st.selling

    // 购买指引（服务端下发）。没取到时 steps 为空，弹窗里走兜底文案，
    // 所以这里不需要为「guide 是 null」单独写一套渲染。
    const guide = this.data.guide || {}
    const steps = guide.steps || []
    const contact = guide.contact || ''

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          {/* 当前档位 */}
          <View style={styles.status}>
            <View style={s.between}>
              <View style={s.row}>
                <Text style={styles.crown}>👑</Text>
                <View style={{ marginLeft: 12 }}>
                  <Text style={styles.statusName}>{st.tierName}</Text>
                  <Text style={[s.tiny, s.dimOnDark, { marginTop: 8 }]}>{st.statusText}</Text>
                </View>
              </View>
              {st.isPaid ? <Text style={styles.statusTag}>剩 {st.daysLeft} 天</Text> : null}
            </View>
            {!st.isPaid ? <Text style={styles.statusFree}>{st.freeText}</Text> : null}
          </View>

          {/* 免费开放期：说清楚哪些权益已经免费，避免有人为「本来就免费的功能」付钱 */}
          {!selling ? (
            <View style={[s.card, styles.freeOpen]}>
              <View style={s.row}>
                <Text style={styles.freeEmoji}>🎉</Text>
                <View style={[s.flex1, { marginLeft: 12 }]}>
                  <Text style={[s.mid, s.bold]}>全员免费开放中</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 8, lineHeight: 18 }]}>
                    持仓数量、港股美股、多账户等功能全部免费使用，无需开通。后续如调整档位会提前公告。
                  </Text>
                </View>
              </View>
            </View>
          ) : null}

          {/* 权益对比 */}
          <View style={[s.card, styles.cardGap]}>
            <Text style={styles.secTitleCenter}>{this.data.tableTitle}</Text>

            <View style={styles.tHead}>
              <Text style={styles.cName}>功能</Text>
              <Text style={styles.cVal}>免费</Text>
              <Text style={styles.cVal}>Lite</Text>
              <Text style={[styles.cVal, styles.proCol]}>Pro</Text>
            </View>

            {this.data.features.map((item) => (
              <View key={item.name} style={styles.tRow}>
                <View style={styles.cName}>
                  <Text style={styles.cell}>{item.name}</Text>
                  {item.soon ? <Text style={styles.soon}>即将上线</Text> : null}
                </View>
                <Text style={[styles.cVal, item.free === '不支持' ? styles.off : null]}>{item.free}</Text>
                <Text style={[styles.cVal, item.lite === '不支持' ? styles.off : null]}>{item.lite}</Text>
                <Text style={[styles.cVal, styles.proCol, styles.on]}>{item.pro}</Text>
              </View>
            ))}

            <Text style={styles.tableNote}>{this.data.tableNote}</Text>
          </View>

          {/* 选择方案 */}
          <Text style={[styles.secTitle, { marginTop: 16 }]}>选择方案</Text>
          {this.data.plans.map((p) => this.renderPlan(p))}

          {/* 支付方式不在这里了 —— 点底部的「立即开通」才弹收银台。
              理由：选支付方式是**付款动作的一部分**（每次付款都要重选一次），
              常驻在页面上会让人以为是个偏好设置；而且这一页本来就长，
              把它塞在方案下面，得滑很久才看得到。 */}

          {/* 说明 */}
          <View style={styles.notes}>
            {this.data.notes.map((n, i) => (
              <View key={i} style={styles.noteRow}>
                <Text style={styles.tick}>✓</Text>
                <Text style={[s.small, s.flex1, { marginLeft: 8 }]}>{n}</Text>
              </View>
            ))}
          </View>

          {/* 兑换码的两个入口：跟购买入口同生共死 —— 免费开放期隐藏，改回收费自动出现。
              「还没码」那个是给新用户看的：点支付发现不支持、点兑换又没码，
              如果这时候没地方可去，这条路就断了。 */}
          {selling ? (
            <View style={styles.redeemRow}>
              <Pressable onPress={() => this.onRedeem()}>
                <Text style={styles.redeem}>有兑换码？点击兑换 ›</Text>
              </Pressable>
              <Pressable onPress={() => this.openGuide()}>
                <Text style={[styles.redeem, styles.redeemSub]}>还没码？看看怎么获取 ›</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>

        {/* 底部栏：免费开放期整条换成说明条，不给付款入口 */}
        {this.data.ready && !selling ? (
          <View style={styles.buyBar}>
            <View style={styles.buyInfo}>
              <Text style={styles.buyPriceFree}>免费开放中</Text>
              <Text style={styles.buySub}>全部功能已解锁，无需开通</Text>
            </View>
            <View style={[styles.buyBtn, styles.buyBtnOff]}>
              <Text style={styles.buyBtnText}>已免费</Text>
            </View>
          </View>
        ) : null}

        {this.data.ready && selling ? (
          <View style={styles.buyBar}>
            <View style={styles.buyInfo}>
              <Text style={styles.buyPrice}>
                {this.data.picked.priceText}
                {this.data.picked.unit ? (
                  <Text style={styles.buyUnit}>{this.data.picked.unit}</Text>
                ) : null}
              </Text>
              <Text style={styles.buySub}>
                {this.data.picked.name}
                {this.data.picked.subText ? ' · ' + this.data.picked.subText : ''}
              </Text>
            </View>
            <Pressable
              style={[styles.buyBtn, this.data.submitting ? styles.buyBtnOff : null]}
              onPress={() => this.onBuy()}
            >
              <Text style={styles.buyBtnText}>{this.data.submitting ? '处理中…' : '立即开通'}</Text>
            </Pressable>
          </View>
        ) : null}

        {/* 收银台：点「立即开通」才弹出来。
            做成底部弹层 —— 这是"在几个选项里挑一个"在手机上的通用形态，
            用户一看就知道这是付款的最后一步。
            遮罩立刻出现、弹窗单独滑上来，两段动画见 openCashier。 */}
        <Modal
          visible={this.data.cashierOpen}
          transparent
          // 刻意用 "none"：Modal 的 animationType 管的是**整块内容**，
          // 遮罩和弹窗只能一起滑或一起淡，做不到"一半立刻生效、一半慢慢来"。
          // 两段动画由 openCashier / closeCashier 自己驱动。
          animationType="none"
          onRequestClose={() => this.closeCashier()}
        >
          {/* 遮罩和弹窗是**兄弟**，不是父子。
              做成父子的话，遮罩的透明度会顺带作用到弹窗上 ——
              收起时弹窗会一边下滑一边消隐，而不是干净地滑出屏幕。 */}
          <View style={styles.cashLayer}>
            {/* 遮罩：点它关闭 */}
            <AnimatedPressable
              style={[styles.cashMask, { opacity: this.maskFade }]}
              onPress={() => this.closeCashier()}
            />
            {/* 弹窗。外面这层 Pressable 是为了挡住冒泡 ——
                少了它，点选项或按钮都会顺带关掉弹层。 */}
            <AnimatedPressable
              style={[styles.cashBox, { transform: [{ translateY: this.sheetY }] }]}
              onPress={() => {}}
              onLayout={(e) => {
                this.sheetH = e.nativeEvent.layout.height
              }}
            >
              <View style={s.between}>
                <Text style={s.h3}>选择支付方式</Text>
                <Pressable onPress={() => this.closeCashier()}>
                  <Text style={styles.cashClose}>✕</Text>
                </Pressable>
              </View>

              {/* 把「买的是什么」摆出来：用户在弹层里最容易忘的就是
                  自己刚选的是哪个方案、多少钱 */}
              <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>
                {this.data.picked.name}
                {this.data.picked.priceText ? ' · ' + this.data.picked.priceText : ''}
              </Text>

              {this.data.channels.map((ch) => this.renderChannel(ch))}

              {this.data.payPreview ? (
                <Text style={[s.tiny, s.dim, { marginTop: 10, lineHeight: 17 }]}>
                  开发预览：支付凭证尚未配置，这里只是界面效果，点击不会真正发起支付。
                </Text>
              ) : null}

              <Pressable
                style={[styles.cashPay, this.data.submitting ? styles.buyBtnOff : null]}
                onPress={() => this.onPay()}
              >
                <Text style={styles.buyBtnText}>{this.data.submitting ? '处理中…' : '确认支付'}</Text>
              </Pressable>
            </AnimatedPressable>
          </View>
        </Modal>

        {/* 兑换码弹窗：RN 的 showModal 不支持输入，自己画一个 */}
        <Modal
          visible={this.data.codeOpen}
          transparent
          animationType="fade"
          onRequestClose={() => this.closeCode()}
        >
          <View style={styles.codeMask}>
            <View style={styles.codeBox}>
              <Text style={s.h3}>输入兑换码</Text>
              <TextInput
                style={[s.input, { marginTop: 14 }]}
                value={this.data.code}
                onChangeText={(v) => this.setData({ code: validate.code(v, { max: 32 }) })}
                placeholder="请输入兑换码"
                placeholderTextColor={colors.t3}
                autoCapitalize="characters"
              />

              {/* 在这里也放一个「怎么获取」：用户多半是听说要用码才点进来的，
                  打开发现手里没有码 —— 正好是他最需要知道去哪买的时候 */}
              <Pressable
                style={{ marginTop: 12, alignItems: 'center' }}
                onPress={() => {
                  this.closeCode()
                  this.openGuide()
                }}
              >
                <Text style={[s.tiny, styles.guideLink]}>还没有兑换码？看看怎么获取 ›</Text>
              </Pressable>

              <View style={[s.row, { marginTop: 16 }]}>
                <Pressable style={[s.flex1, styles.codeBtn]} onPress={() => this.closeCode()}>
                  <Text style={[s.mid, s.dim]}>取消</Text>
                </Pressable>
                <View style={styles.codeGap} />
                <Pressable style={[s.flex1, styles.codeBtn, styles.codeBtnOn]} onPress={() => this.submitCode()}>
                  <Text style={[s.mid, { color: colors.primary }]}>兑换</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* 「怎么拿到兑换码」。
            内容由服务端下发：卖码渠道会变（今天闲鱼、明天淘宝、后天加客服微信），
            写死在 App 里意味着每改一句话都要发版等审核。
            改服务端的 REDEEM_GUIDE_* 环境变量重启即可，App 一行都不用动。 */}
        <Modal
          visible={this.data.guideOpen}
          transparent
          animationType="fade"
          onRequestClose={() => this.closeGuide()}
        >
          <View style={styles.codeMask}>
            <View style={styles.codeBox}>
              <Text style={s.h3}>{guide.title || '如何获取兑换码'}</Text>

              {steps.length ? (
                <View style={{ marginTop: 16, alignSelf: 'stretch' }}>
                  {steps.map((t, i) => (
                    <View key={i} style={styles.stepRow}>
                      <View style={styles.stepNo}>
                        <Text style={styles.stepNoText}>{i + 1}</Text>
                      </View>
                      <Text style={[s.small, s.flex1, styles.stepText]}>{t}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={[s.small, s.dim, styles.guideFallback]}>
                  兑换码通过购买或活动获得。如果不知道该从哪里拿，请联系我们。
                </Text>
              )}

              {contact ? (
                <View style={styles.contactBox}>
                  <Text style={[s.small, styles.contactText]}>{contact}</Text>
                </View>
              ) : null}

              {/* 底部按钮直接给「去兑换」：看完说明的人下一步几乎一定是这个动作，
                  让他关掉弹窗再去找入口是多余的一步 */}
              <Pressable
                style={[styles.guideBtn, { alignSelf: 'stretch', marginTop: 18 }]}
                onPress={() => {
                  this.closeGuide()
                  this.onRedeem()
                }}
              >
                <Text style={[s.mid, { color: colors.primary }]}>我已拿到码，去兑换</Text>
              </Pressable>

              <Pressable style={{ marginTop: 12, alignItems: 'center' }} onPress={() => this.closeGuide()}>
                <Text style={[s.mid, s.dim]}>关闭</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  /* 错误兜底 */
  err: { marginTop: 12, alignItems: 'center', paddingVertical: 34 },
  errEmoji: { fontSize: 38 },
  errBtn: {
    marginTop: 16,
    paddingHorizontal: 28,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: colors.primarySoft
  },
  errBtnText: { fontSize: 14, color: colors.primary, fontWeight: '600' },

  /**
   * 卡片之间的统一间距。
   *
   * 这一页的每一块（状态卡、权益表、方案区…）都是**独立卡片**，相邻关系
   * 靠各自带的 marginTop 表达 —— 内容容器本身没有 gap。
   *
   * 权益对比那张原来漏了这个 marginTop。之所以一直没被发现，是因为
   * 免费开放期的提示卡（freeOpen）带着 marginTop 顶在它前面，把缺口遮住了；
   * 而 freeOpen 只在免费期显示，正常收费期它是隐藏的 —— 于是黑色状态卡
   * 和权益表就直接贴在一起，连成一片。
   *
   * 所以规矩是：**卡片类元素各自带 marginTop**，别指望"前面那块正好有间距"。
   */
  cardGap: { marginTop: 12 },

  /* 当前档位 */
  status: { backgroundColor: colors.dark, borderRadius: 16, padding: 18, marginTop: 12 },
  crown: { fontSize: 26 },
  statusName: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
  statusTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.16)',
    fontSize: 11,
    color: '#FFFFFF',
    overflow: 'hidden'
  },
  statusFree: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.14)',
    fontSize: 11.5,
    lineHeight: 19,
    color: 'rgba(255,255,255,0.66)'
  },

  /* 免费开放期 */
  freeOpen: {
    // 与 cardGap 取同一个值：这样"有免费提示"和"没有"两种情况下，
    // 卡片之间的节奏是一样的，切换 selling 不会让这一页忽然变松或变紧。
    marginTop: 12,
    borderWidth: 1,
    borderColor: 'rgba(47, 181, 126, 0.28)',
    backgroundColor: 'rgba(47, 181, 126, 0.08)'
  },
  freeEmoji: { fontSize: 22, flexShrink: 0 },

  /* 权益对比表 */
  secTitleCenter: {
    marginBottom: 12,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '600',
    color: colors.t1
  },
  secTitle: { marginBottom: 10, paddingHorizontal: 4, fontSize: 15, fontWeight: '600', color: colors.t1 },
  tHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  tRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line2
  },
  cName: { flex: 1.7, flexDirection: 'row', alignItems: 'center', paddingRight: 6 },
  cVal: { flex: 1, textAlign: 'center', fontSize: 11.5, color: colors.t2 },
  cell: { fontSize: 12.5, color: colors.t1 },
  proCol: { color: colors.primary },
  on: { fontWeight: '600' },
  off: { color: colors.t3 },
  soon: {
    marginLeft: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: colors.line2,
    fontSize: 9,
    color: colors.t3,
    overflow: 'hidden'
  },
  tableNote: { marginTop: 13, fontSize: 11, lineHeight: 18, color: colors.t3 },

  /* 方案卡 */
  plan: {
    marginBottom: 10,
    padding: 15,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.line
  },
  planOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  planBadge: {
    alignSelf: 'flex-start',
    marginBottom: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.line2,
    overflow: 'hidden'
  },
  // 「最超值」标签。
  //
  // 原来这里是绿色底（colors.primary = #1F9D6B）配 planBadgeText 的灰色字
  // （colors.t2 = #6B7370）—— 两者亮度接近，对比度只有约 1.8:1，
  // 远低于正文可读所需的 4.5:1，实际就是一团糊。
  //
  // 换成金色底 + 深棕字，对比度约 7:1。选金色还有个语义上的好处：
  // 「最超值」是推荐标记，本来就该用暖色，而绿色在本页是"已选中 / 主操作"
  // 的颜色（planOn 的描边、底部开通按钮），拿它当徽章底色会和选中态打架。
  planBadgeBest: { backgroundColor: '#F0A83C' },
  // 灰色取 #5C6360 而不是 colors.t2(#6B7370)：后者配浅灰底只有 4.49:1，
  // 恰好卡在 4.5 的达标线下面 —— 差 0.01 也是不合格，而且这种"差一点点"
  // 靠肉眼根本发现不了，只有算出来才知道。这一档深灰是 5.5:1。
  planBadgeText: { fontSize: 10, fontWeight: '600', color: '#5C6360' },
  // 与 planBadgeText 同字号字重，只换颜色 —— 分开定义而不是覆盖，
  // 是因为「热门」那个徽章继续用浅灰底 + 灰字（4.3:1，及格），不该被牵连。
  planBadgeBestText: { fontSize: 10, fontWeight: '600', color: '#4A3200' },
  planHead: { flexDirection: 'row', alignItems: 'flex-start' },
  planName: { fontSize: 15, fontWeight: '700', color: colors.t1 },
  planOwn: {
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: colors.primarySoft,
    fontSize: 10,
    color: colors.primary,
    overflow: 'hidden'
  },
  planPrice: { flexDirection: 'row', alignItems: 'flex-end', flexShrink: 0 },
  planNum: { fontSize: 20, fontWeight: '700', color: colors.t1 },
  planUnit: { marginLeft: 2, fontSize: 11, color: colors.t3 },
  planStrike: {
    marginLeft: 8,
    fontSize: 11,
    color: colors.t3,
    textDecorationLine: 'line-through'
  },
  planMeta: { marginTop: 10, fontSize: 11.5, color: colors.t2 },
  planTip: { marginTop: 6, fontSize: 11, color: colors.orange },

  /* 支付方式（收银台） */
  // 视觉上刻意与方案卡片用同一套：描边 + 选中时换成主色描边与浅底。
  // 两处选中态长得一样，用户才会感觉这是"同一个选择流程里的两步"。
  payMethod: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingVertical: 14,
    paddingHorizontal: 15,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.card
  },
  payMethodOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  payRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center'
  },
  payRadioOn: { borderColor: colors.primary },
  payRadioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },

  /* 说明 */
  notes: { marginTop: 6, marginBottom: 4 },
  noteRow: { flexDirection: 'row', alignItems: 'center', marginTop: 7 },
  tick: { fontSize: 12, color: colors.primary },

  /* 兑换码的两个入口 */
  redeemRow: { marginTop: 20, alignItems: 'center' },
  redeem: { textAlign: 'center', fontSize: 12, color: colors.primary },
  // 第二个入口（还没码）弱一档：两行一样抢眼反而看不出哪个是主路径
  redeemSub: { marginTop: 10, color: colors.t2 },

  /* 底部栏 */
  buyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: '#FFFFFF'
  },
  buyInfo: { flex: 1 },
  buyPrice: { fontSize: 19, fontWeight: '700', color: colors.t1 },
  buyPriceFree: { fontSize: 19, fontWeight: '700', color: colors.primary },
  buyUnit: { fontSize: 11, color: colors.t3 },
  buySub: { marginTop: 3, fontSize: 11, color: colors.t3 },
  buyBtn: {
    paddingHorizontal: 26,
    paddingVertical: 11,
    borderRadius: 24,
    backgroundColor: colors.dark
  },
  buyBtnOff: { backgroundColor: colors.primarySoft },
  buyBtnText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },

  /* 收银台弹层 */
  // 形态与下面的兑换码弹窗刻意不同：那个是居中的小方框（输入一个码），
  // 这个从底部滑出（在几个选项里挑一个）—— 形态本身就在提示怎么操作。
  //
  // 里面分两层：定位层 → 遮罩 + 弹窗（**兄弟**）。
  // 遮罩铺满整屏、弹窗贴底，靠的是定位层的 justifyContent: 'flex-end'。
  cashLayer: { flex: 1, justifyContent: 'flex-end' },
  // 绝对定位铺满：遮罩只是"一层膜"，不参与布局，弹窗的位置由上层决定。
  // 做成 flex:1 的容器当然也能铺满，但那样遮罩和弹窗就变成父子了 ——
  // 遮罩的透明度会连带把弹窗也弄透明（见 render 里的说明）。
  cashMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)'
  },
  cashBox: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    // 底部多留一截：带手势条的机型上，贴边的按钮很容易被系统手势抢走触摸
    paddingBottom: 30
  },
  cashClose: { paddingHorizontal: 8, paddingVertical: 2, fontSize: 16, color: colors.t3 },
  // 与底部那个「立即开通」同色同圆角，让"最后一步"看起来是同一个动作的延续
  cashPay: {
    marginTop: 18,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.dark
  },

  /* 兑换码弹窗 */
  codeMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32
  },
  codeBox: { width: '100%', padding: 20, borderRadius: 16, backgroundColor: '#FFFFFF' },
  codeBtn: { height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.line2 },
  codeBtnOn: { backgroundColor: colors.primarySoft },
  codeGap: { width: 12 },

  /* 「怎么获取兑换码」弹窗 */
  guideLink: { color: colors.primary },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  stepNo: {
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1
  },
  stepNoText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  stepText: { marginLeft: 9, lineHeight: 20, color: colors.t1 },
  guideFallback: { marginTop: 14, lineHeight: 21, textAlign: 'center' },
  // 联系方式单独框出来：它是要被拿去加微信/发邮件的，
  // 混在步骤文字里很容易看漏
  contactBox: {
    alignSelf: 'stretch',
    marginTop: 16,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.primarySoft
  },
  contactText: { textAlign: 'center', fontWeight: '600', color: colors.primary },
  guideBtn: {
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: colors.primarySoft
  }
})

module.exports = Membership
