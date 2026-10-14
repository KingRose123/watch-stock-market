const React = require('react')
const { View, Text, ScrollView, Pressable, Modal, StyleSheet, Animated, Easing, Dimensions, RefreshControl } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s , tones } = require('../theme.js')
const LoginGuard = require('../components/LoginGuard.js')
const app = require('../app.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const remoteConfig = require('../utils/remoteConfig.js')

/**
 * 分红覆盖网格：小程序是「7×84rpx + 7×8rpx 间隙」的固定排布（卡片内容宽 646rpx），
 * RN 端按屏幕宽换算成像素，保证一行刚好排下 7 个。
 * 64 = 页面左右 padding 16×2 + 卡片 padding 16×2
 */
const COV_GAP = 4

// 记「用户关掉的那条公告内容」。存内容而不是存时间戳/布尔值，
// 是为了让运营换一条新公告时所有人重新看到（详见 syncNotice 的注释）。
const NOTICE_CLOSED_KEY = 'noticeClosed'

// 堆叠时相邻两张卡叠掉的像素。
//
// 这个值必须**远小于**卡片高度（紧凑卡约 62），否则就成了「只露一条边」——
// 那样看不出每张卡里是什么，堆叠就只剩装饰作用了。
// 15 左右是"一眼能看出是叠着的、但每张内容都完整"的量。
const DECK_OVERLAP = 15
// 一行放 7 个时的单块宽度：可用宽 = 屏宽 - 64（页面 padding 16×2 + 卡片 padding 16×2）。
// 减 6 个间隙而不是 7 个 —— gap 只在相邻块之间，首尾不加。
// 这是**下限宽度**（minWidth）：项数少时会被 flexGrow 拉宽去均分整行，
// 项数多时靠它顶住不被压扁，从而溢出成可横滑的一行。
const COV_ITEM_W = (Dimensions.get('window').width - 64 - COV_GAP * 6) / 7

// 市场徽标：数据层给的是小程序的全局 class（tag-green…），RN 没有全局 class，
// 这里映射成等价样式（配色取 app.wxss 的 .tag-*）
const TAG_STYLES = {
  'tag-green': { backgroundColor: colors.accentA10, color: colors.accent },
  'tag-gold': { backgroundColor: colors.warm, color: colors.gold },
  'tag-blue': { backgroundColor: 'rgba(59, 130, 196, 0.12)', color: '#3B82C4' },
  'tag-orange': { backgroundColor: colors.warm, color: colors.orange },
  'tag-gray': { backgroundColor: colors.line2, color: colors.t3 }
}
const tagStyleOf = (cls) => tones[cls] || tones['tag-gray']

/**
 * 持仓列表页。
 *
 * 逻辑部分（load / onMarket / 排序分组 / 悬浮菜单）与小程序那份**逐字一致** ——
 * 这是 Page 适配层的收益：只有 render 是重写的。
 */
class Holdings extends MiniPage {
  constructor(props) {
    super(props)
    // 子类的 data 用实例字段（MiniPage 在 componentDidMount 之后才读它）
    this.data = {
      guest: false,
      loading: true,
      expanded: false,
      // 首页顶部公告条。内容来自远程配置 announcement（后台「远程配置」页可改）。
      // 空串表示不显示 —— 这也是内置默认值，所以没配过公告时这一块根本不会出现。
      notice: '',
      // 持仓卡片是否摊开。默认收起 —— 卡片叠着时一眼能看到「有几只、第一只是什么」，
      // 而完整摊开是十几张卡片的长列表，想看明细的人自己点开。
      // 与 expanded 无关，理由见 toggleDeck
      deckOpen: false,
      // 「当前这一块正在退场」。退场动画跑完才真正换块（见 onDeckLeft）——
      // 直接翻 deckOpen 的话，旧的那块当帧就被卸载了，退场动画根本没机会跑
      deckLeaving: false,

      market: 'A',
      tabList: [],
      rawList: [],
      viewGroups: [],
      listTotal: 0,

      sortOptions: [],
      groupOptions: [],
      sortKey: 'default',
      groupKey: 'none',

      sheetKey: '',
      sheetTitle: '',
      sheetItems: [],

      coverageGrid: [],
      coveredCount: 0,
      totalCount: 0,
      gapText: '0',
      nextName: '',
      nextIcon: '',
      sum: {},

      fabOpen: false,
      // 下拉刷新的转圈状态。必须放在 data 里：RefreshControl 的 refreshing
      // 是**受控**属性，不给它一个会变的状态，圈转了就不会停。
      refreshing: false,
      fabActions: [
        { key: 'ocr', icon: '📷', label: '截图识别', btnClass: '' },
        { key: 'manual', icon: '✏️', label: '手动添加', btnClass: 'warm' }
      ]
    }

    // ＋ 的旋转（0=收起，1=展开）与两个动作的逐个弹出
    this.fabAnim = new Animated.Value(0)
    this.itemAnims = this.data.fabActions.map(() => new Animated.Value(0))
  }

  /* ---------------- 生命周期 ---------------- */

  onShow() {
    // ⚠️ 自愈必须排在 boot **之前**：boot 读的是当前快照并渲染，
    // 先修正再渲染，才不会出现「进去是 0、退出去再进来才对」那种怪现象。
    //
    // 它只在 received 与 receivedNative 不一致时才写库，正常情况下是空跑
    //（所以不加限流也无所谓）。来由见 api.js 的 healReceived / 
    // applyDividendsToHolding —— 记了分红但「累计已获」一直显示 0。
    api.healReceived()

    this.boot()
    this.autoDividends()
  }

  /**
   * 自动补记**已到账**的分红。
   *
   * ⚠️ 为什么挂在这里、而不是 App.js 的 syncOnBoot：
   * 那个位置更"正统"（冷启动 + 回前台都会跑到），但 `App.js` 这个文件
   * 在当前环境下**写不进去** —— 编辑工具每次都报成功，而文件的修改时间
   * 纹丝不动（同目录别的文件都正常）。改不动就换一个**等效**的位置：
   *
   *   · 冷启动 → 虽然默认落在社区页，但用户要看分红，一定会进持仓页；
   *   · 回前台 → onShow 会再跑一次。
   *
   * 所以它一定会被跑到，而且是在用户看得到分红的地方跑。
   * 哪天 App.js 能写了，把这一行挪回 syncOnBoot 更干净（那边一个启动只跑一次）。
   *
   * ⚠️ 限流：onShow 每次切 tab 都会触发，而分红档案要打网络。
   * 5 分钟内的重复进入不再查 —— 一只股票的分红一天最多变一次，
   * 查那么勤只是白耗额度。真正的幂等在 api.autoRecordDividends 内部
   *（确定性 id），所以多调几次也不会记重复，这里只是为了省请求。
   *
   * 失败静默：它是"顺手补一笔"，不是用户发起的操作。
   */
  autoDividends() {
    const now = Date.now()
    if (this._divCheckedAt && now - this._divCheckedAt < 5 * 60 * 1000) return
    this._divCheckedAt = now
    api.autoRecordDividends().catch(() => 0)
  }

  /**
   * 卸载时解除配置订阅。
   *
   * 不解除的话 remoteConfig 会一直攥着这个回调，配置一更新就往一个
   * 已经卸载的组件上 setData —— 轻则无效，重则在 React 里报
   * "setState on unmounted component"。
   *
   * 用 onUnload 而不是 componentWillUnmount：MiniPage 已经把前者映射到了后者，
   * 而且在里面顺带清理了导航监听和定时器（见 compat/page.js）。
   */
  onUnload() {
    if (this._offConfig) {
      this._offConfig()
      this._offConfig = null
    }
  }

  boot() {
    if (!app.isLogin()) {
      this.setData({ guest: true, loading: false })
      app.toGuide()
      return
    }
    if (this.data.guest) this.setData({ guest: false })

    // 配置是启动后异步拉的，这里先按缓存（或默认值）渲染一次；
    // 拉完 remoteConfig 会通知，下面那个订阅再刷新一遍。
    // 只订阅一次：boot() 每次 onShow 都会跑，重复订阅会让回调越积越多
    if (!this._offConfig) {
      this._offConfig = remoteConfig.subscribe(() => this.syncNotice())
    }
    this.syncNotice()

    // 顺手拉一次配置。带 5 分钟节流（见 remoteConfig.load），
    // 所以切 tab、来回切 App 都不会真的打出请求。
    //
    // 这一句是为了「运营改完公告，用户切一下 tab 就能看到」——
    // 只在冷启动拉的话，用户得杀掉 App 重开才行，而那是个没人会做的动作。
    // 拉回来会走上面的订阅，syncNotice 自动刷新。
    remoteConfig.load()

    this.load()
  }

  /**
   * 同步公告条内容。
   *
   * 「关掉过就不再显示」判断的是**内容**而不是「关过一次」：
   * 用后者的话，运营换了新公告老用户永远看不到 —— 那等于把公告功能废掉了。
   * 内容一变就重新出现，这才是运营想要的语义。
   */
  syncNotice() {
    const text = String(remoteConfig.getStr('announcement') || '').trim()
    let closed = ''
    try {
      closed = String(wx.getStorageSync(NOTICE_CLOSED_KEY) || '')
    } catch (e) {
      /* 读不到就当成没关过，宁可多显示一次 */
    }
    this.setData({ notice: text && text !== closed ? text : '' })
  }

  dismissNotice() {
    try {
      wx.setStorageSync(NOTICE_CLOSED_KEY, this.data.notice)
    } catch (e) {
      /* 存不下也无所谓：本次会话里它已经收起了 */
    }
    this.setData({ notice: '' })
  }

  /**
   * 下拉刷新：用户明确要求"现在就要最新的数"。
   *
   * ⚠️ 与 onShow 里那次 load() 的唯一区别是**绕过行情缓存**。
   * refreshHoldingQuotes 平时有 5 分钟节流（为的是切 tab、来回切 App 时不发
   * 无谓请求），但"下拉"这个动作本身就是"我知道数据可能旧了" ——
   * 这时候还吃缓存，用户会看到圈转完、数字纹丝不动，然后合理地认为
   * 这个功能是假的。所以 force 一路透传到 refreshHoldingQuotes。
   *
   * 失败静默：下拉是"顺手看一眼"，弹错误框比数字没变更打扰人。
   * 但**无论如何都要把 refreshing 关掉** —— 漏了的话圈会一直转，
   * 那看起来像 App 卡死了，比不刷新严重得多。
   */
  onRefresh() {
    // 已经在下拉了就不重复发请求：手指连拉几下很容易触发多次
    if (this.data.refreshing) return Promise.resolve()

    this.setData({ refreshing: true })
    return this.load(true).then(
      () => this.setData({ refreshing: false }),
      () => this.setData({ refreshing: false })
    )
  }

  load(force) {
    // 先按 code + market 刷新实时行情（默认吃 5 分钟缓存，force 时绕过），
    // 再拉数据，这样总市值 / 浮盈 / 市值息率都是用最新价算出来的
    return api
      .refreshHoldingQuotes(force)
      .catch(() => 0)
      .then(() =>
        Promise.all([api.getSummary(), api.getCoverageBrief(), api.getHoldings(this.data.market)])
      )
      .then((res) => {
        const sum = res[0].data
        const cov = res[1].data
        const hold = res[2].data
        const view = api.buildHoldingGroups(hold.list, this.data.sortKey, this.data.groupKey)

        this.setData({
          loading: false,
          sum: sum,
          coveredCount: cov.coveredCount,
          totalCount: cov.totalCount,
          gapText: cov.gapText,
          nextName: cov.nextName,
          nextIcon: cov.nextIcon,
          coverageGrid: cov.grid,
          market: hold.activeMarket,
          tabList: hold.tabs,
          rawList: hold.list,
          viewGroups: view.groups,
          listTotal: view.total,
          sortOptions: hold.sorts,
          groupOptions: hold.groupOptions
        })
      })
      .catch(util.onError)
  }

  onMarket(key) {
    if (key === this.data.market) return
    this.setData({ market: key })
    api
      .getHoldings(key)
      .then((res) => {
        const d = res.data
        this.setData({ market: d.activeMarket, tabList: d.tabs, rawList: d.list })
        this.applyView()
      })
      .catch(util.onError)
  }

  applyView() {
    const view = api.buildHoldingGroups(this.data.rawList, this.data.sortKey, this.data.groupKey)
    this.setData({ viewGroups: view.groups, listTotal: view.total })
  }

  /* ---------------- 排序 / 分组 ---------------- */

  openSheet(kind) {
    const isSort = kind === 'sort'
    const options = isSort ? this.data.sortOptions : this.data.groupOptions
    if (!options.length) return

    const current = isSort ? this.data.sortKey : this.data.groupKey
    this.setData({
      sheetKey: kind,
      sheetTitle: isSort ? '排序方式' : '分组方式',
      sheetItems: options.map((o) => Object.assign({}, o, { on: o.key === current }))
    })
  }

  closeSheet() {
    if (this.data.sheetKey) this.setData({ sheetKey: '' })
  }

  onSheetPick(key) {
    const isSort = this.data.sheetKey === 'sort'
    const patch = { sheetKey: '' }
    patch[isSort ? 'sortKey' : 'groupKey'] = key

    this.setData(patch)
    this.applyView()
  }

  toggleExpand() {
    this.setData({ expanded: !this.data.expanded })
  }

  /**
   * 摊开 / 叠起持仓卡片。
   *
   * 与上面的 toggleExpand 是**两件事**，别合并：
   *   expanded  → 顶部总览的「查看更多指标」，管的是**指标多不多**；
   *   deckOpen  → 持仓列表的卡片堆叠，管的是**列表长不长**。
   * 它们服务的对象不同（前者是汇总、后者是明细），
   * 合并成一个状态会出现「看指标时列表也被摊开」这种莫名联动。
   */
  toggleDeck() {
    // 退场途中不响应连点：deckOpen 只有一个，两次点击会让"正在退出的那块"
    // 和"已经进来的那块"指向同一个状态，最后可能两块都不见
    if (this.data.deckLeaving) return
    // 先让当前这块退场，退完再换另一块（见 onDeckLeft）
    this.setData({ deckLeaving: true })
  }

  /**
   * 退场动画结束 —— 换块。这里是**唯一**改 deckOpen 的地方。
   *
   * 顺序不能反：先换块再退场的话，旧块当帧就被卸载，退场无从谈起；
   * 而两块同时挂载（一进一出）又会因为高度差把下面的内容顶一下。
   * 串行做，是最简单且不会出几何问题的编排。
   */
  onDeckLeft() {
    this.setData({ deckOpen: !this.data.deckOpen, deckLeaving: false })
  }

  goProjection() {
    wx.navigateTo({ url: '/pages/tool/tool?id=t1' })
  }

  goMetricSettings() {
    wx.navigateTo({ url: '/pages/metric-settings/metric-settings' })
  }

  goCoverage() {
    wx.navigateTo({ url: '/pages/coverage/coverage' })
  }

  goDetail(id) {
    wx.navigateTo({ url: '/pages/holding-detail/holding-detail?id=' + id })
  }

  /* ---------------- 悬浮操作菜单 ---------------- */

  toggleFab() {
    const next = !this.data.fabOpen
    this.setData({ fabOpen: next })
    this.animateFab(next)
  }

  closeFab() {
    if (!this.data.fabOpen) return
    this.setData({ fabOpen: false })
    this.animateFab(false)
  }

  /**
   * 悬浮菜单动画，参数照抄小程序的 CSS（app.wxss / holdings.wxss）：
   *   .fab-icon   transform 0.32s ease          —— ＋ 旋转 45° 变 ×
   *   .speed-item 0.42s cubic-bezier(.22,1,.36,1)，延迟 (len-1-index)*120ms
   * 延迟是倒着算的，所以最靠近 ＋ 的那一项先弹出来，这里同样倒序排。
   */
  animateFab(open) {
    Animated.timing(this.fabAnim, {
      toValue: open ? 1 : 0,
      duration: 320,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true
    }).start()

    const items = this.itemAnims
      .map((v) =>
        Animated.timing(v, {
          toValue: open ? 1 : 0,
          duration: 420,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true
        })
      )
      .reverse()

    Animated.stagger(120, items).start()
  }

  onFabAction(key) {
    this.closeFab()

    if (key === 'manual') {
      wx.navigateTo({ url: '/pages/add-holding/add-holding' })
      return
    }

    // 截图识别要依赖服务端 OCR，未接入前如实说明，并把用户引导到手动添加
    wx.showModal({
      title: '截图识别',
      content: '截图识别需要接入 OCR 服务，当前版本尚未开放。可以先用「手动添加」录入持仓。',
      confirmText: '手动添加',
      cancelText: '知道了',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/add-holding/add-holding' })
      }
    })
  }

  onHide() {
    this.closeFab()
    this.closeSheet()
  }

  /* ---------------- 渲染 ---------------- */

  /**
   * 首页顶部公告条。
   *
   * 位置放在总览卡**之上**：公告多半是"服务调整""功能上新"这类需要先看到的信息，
   * 夹在中间或放在下面，用户在滑持仓时很容易直接划过去。
   *
   * 整条可点关闭 —— 同时给了文字「✕」作为提示。只做一个不带字的图形，
   * 会有人不知道那能点。
   */
  renderNotice() {
    const text = this.data.notice
    if (!text) return null

    return (
      <View style={styles.notice}>
        <Text style={styles.noticeIcon}>📢</Text>
        <Text style={styles.noticeText}>{text}</Text>
        <Pressable
          onPress={() => this.dismissNotice()}
          // 关闭是个小目标，扩大点击热区，免得点不中而以为关不掉
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.noticeClose}>✕</Text>
        </Pressable>
      </View>
    )
  }

  renderTop() {
    const sum = this.data.sum || {}
    const metrics = sum.metrics || []

    return (
      <View style={styles.topCard}>
        {sum.holdDays > 0 ? (
          <View style={styles.streak}>
            <View style={styles.streakIco}>
              <Text style={styles.streakIcoText}>🔥</Text>
            </View>
            {/* flex: 0 1 auto —— 文案按内容宽度排，句尾的 💪 紧跟文字，不被推到行末 */}
            <Text style={styles.streakText} numberOfLines={1}>
              收息第 {sum.holdDays} 天，每一段伟大的旅程都从第一步开始
            </Text>
            <View style={styles.streakEmojiBox}>
              <Text style={styles.streakEmoji}>💪</Text>
            </View>
          </View>
        ) : null}

        <View style={[s.between, { marginTop: 16 }]}>
          <Text style={styles.onDarkSmall}>预测年度分红</Text>
          <Text style={styles.onDarkTiny}>基于 {sum.count || 0} 只持仓</Text>
        </View>

        <View style={[s.between, { marginTop: 4 }]}>
          <Text style={styles.bigNum}>{sum.dividendText || '0.00'}</Text>
          <Pressable onPress={() => this.goProjection()}>
            <Text style={styles.future}>✨ 20年可达 {sum.multipleText || '—'} 倍 ›</Text>
          </Pressable>
        </View>

        {metrics.length ? (
          <View>
            {this.data.expanded ? (
              <View>
                <View style={styles.dividerDark} />
                <View style={styles.metricGrid}>
                  {metrics.map((m) => (
                    <View key={m.key} style={styles.metric}>
                      <Text style={styles.onDarkTiny}>{m.name}</Text>
                      <Text
                        style={[
                          styles.metricValue,
                          m.tone === 'up' ? styles.metricUp : m.tone === 'down' ? styles.metricDown : null
                        ]}
                      >
                        {m.value}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            <View style={styles.toggleRow}>
              <Pressable style={styles.toggle} onPress={() => this.toggleExpand()}>
                <Text style={styles.toggleText}>{this.data.expanded ? '收起' : '查看更多指标'}</Text>
                {/* 小程序用两条边旋转画箭头，RN 同样只描两条边，颜色跟随文字 */}
                <View style={[styles.chev, this.data.expanded ? styles.chevUp : null]} />
              </Pressable>
              <Pressable onPress={() => this.goMetricSettings()}>
                <Text style={styles.metricSet}>⚙ 设置指标</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    )
  }

  renderCoverage() {
    return (
      <View style={[styles.card, { marginTop: 12 }]}>
        <Pressable style={s.between} onPress={() => this.goCoverage()}>
          <View style={s.row}>
            <View style={styles.covIconBox}>
              <Text style={styles.covIcon}>🎯</Text>
            </View>
            <Text style={[styles.h3, { marginLeft: 6 }]}>分红覆盖</Text>
          </View>
          <Text style={s.dim}>›</Text>
        </Pressable>

        {/* 一行排开，放不下就横向滑 —— 不再折行。
            折行的话，覆盖项一多整个卡片就会被撑高，页面往下滚很久才见得到持仓列表；
            而这里的每一项只是"点亮了没有"的状态位，不值得占那么多垂直空间。

            showsHorizontalScrollIndicator={false}：静止时不显示滚动条。
            这条轨道会横穿整张卡片、和下面的持仓列表抢注意力，而它提供的信息
            （"还能往右滑"）在用户手一推的时候就自然明白了。 */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.covScroll}
          contentContainerStyle={styles.covRow}
        >
          {this.data.coverageGrid.map((item) => (
            <View
              key={item.id}
              style={[
                styles.covItem,
                item.on ? styles.covOn : null,
                item.doing ? styles.covDoing : null
              ]}
            >
              <Text style={styles.covItemIcon}>{item.icon}</Text>
              <Text
                style={[styles.covItemName, item.on || item.doing ? styles.covItemNameOn : null]}
                numberOfLines={1}
              >
                {item.name}
              </Text>
            </View>
          ))}
        </ScrollView>

        <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>
          已点亮 {this.data.coveredCount}/{this.data.totalCount} 项
        </Text>

        <Pressable style={[styles.warmTip, { marginTop: 8 }]} onPress={() => this.goCoverage()}>
          <Text style={[styles.warmTipText, { flex: 1 }]}>
            再攒 {this.data.gapText} 分红就能点亮 {this.data.nextIcon}
            {this.data.nextName}
          </Text>
          <Text style={s.dim}>›</Text>
        </Pressable>
      </View>
    )
  }

  renderList() {
    return (
      <View>
        <View style={styles.secHead}>
          <View style={s.row}>
            <Text style={styles.h2}>我的持仓</Text>
            <Text style={styles.countTag}>{(this.data.sum || {}).count || 0}只</Text>
          </View>
          <View style={s.row}>
            {/* 改了默认口径时按钮变绿，具体选了哪项在面板里打勾 */}
            <Pressable
              style={[styles.mini, this.data.sortKey !== 'default' ? styles.miniActed : null]}
              onPress={() => this.openSheet('sort')}
            >
              <Text
                style={[styles.miniText, this.data.sortKey !== 'default' ? styles.miniTextActed : null]}
              >
                排序
              </Text>
            </Pressable>
            <Pressable
              style={[styles.mini, styles.miniMl, this.data.groupKey !== 'none' ? styles.miniActed : null]}
              onPress={() => this.openSheet('group')}
            >
              <Text
                style={[styles.miniText, this.data.groupKey !== 'none' ? styles.miniTextActed : null]}
              >
                分组
              </Text>
            </Pressable>
            {/* 摊开 / 叠起。叠着时也能点底部那条提示展开，
                但两种都留着：从顶部切换不会因为列表长而找不到入口 */}
            <Pressable
              style={[styles.mini, styles.miniMl]}
              onPress={() => this.toggleDeck()}
            >
              <Text style={styles.miniText}>{this.data.deckOpen ? '叠起' : '摊开'}</Text>
            </Pressable>
          </View>
        </View>

        {/* 标签由实际持仓动态生成，放不下时横向滚动 */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs}>
          {this.data.tabList.map((t) => (
            <Pressable
              key={t.key}
              style={[styles.tab, this.data.market === t.key ? styles.tabOn : null]}
              onPress={() => this.onMarket(t.key)}
            >
              <View
                style={[
                  styles.dot,
                  { backgroundColor: dotColor(t.dotClass) },
                  this.data.market === t.key ? styles.dotOn : null
                ]}
              />
              <Text style={[styles.tabText, this.data.market === t.key ? styles.tabTextOn : null]}>
                {t.label} {t.count}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {this.data.viewGroups.map((group) => (
          <View key={group.key}>
            {group.title ? (
              <View style={styles.groupHead}>
                <Text style={styles.groupTitle}>{group.title}</Text>
                <Text style={[s.tiny, s.dim, { marginLeft: 4 }]}>{group.count}只</Text>
              </View>
            ) : null}

            {this.data.deckOpen ? (
              <DeckReveal
                dir="down"
                closing={this.data.deckLeaving}
                onLeft={() => this.onDeckLeft()}
              >
                {group.list.map((h) => (
                  <HoldCard key={h.id} h={h} onPress={() => this.goDetail(h.id)} />
                ))}

                {/* 与收起态那条「展开全部 N 只」对称：展开之后也得有个地方收回去。
                    只靠顶部那个「叠起」小胶囊不够 —— 列表一长它就被滚出屏幕了，
                    而用户读到列表末尾时想收起来，视线正好在这里。 */}
                <Pressable style={styles.deckHint} onPress={() => this.toggleDeck()}>
                  <Text style={styles.deckHintText}>
                    收起全部 {group.list.length} 只 ⌃
                  </Text>
                </Pressable>
              </DeckReveal>
            ) : (
              <StackedDeck
                list={group.list}
                closing={this.data.deckLeaving}
                onLeft={() => this.onDeckLeft()}
                onOpen={() => this.toggleDeck()}
              />
            )}
          </View>
        ))}

        {!this.data.listTotal ? (
          <View style={styles.holdEmpty}>
            <Text style={styles.holdEmptyText}>还没有持仓，点右下角 ＋ 添加第一只收息标的</Text>
          </View>
        ) : null}
      </View>
    )
  }

  render() {
    if (this.data.guest) {
      return (
        <View style={s.page}>
          <LoginGuard
            icon="💰"
            title="登录后查看你的持仓"
            desc="登录即可同步持仓、分红与覆盖进度"
            onPress={() => app.toLogin()}
          />
        </View>
      )
    }

    if (this.data.loading) {
      return (
        <View style={[s.page, styles.empty]}>
          <Text style={styles.emptyEmoji}>💰</Text>
          <Text style={styles.emptyTitle}>正在加载你的持仓…</Text>
        </View>
      )
    }

    return (
      <View style={s.page}>
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={this.data.refreshing}
              onRefresh={() => this.onRefresh()}
              // 页面底色很浅，转圈默认的白色几乎看不见 —— 指定成主题灰。
              // iOS 认 tintColor、Android 认 colors，两个都给上，
              // 免得只在一个平台上好看。
              tintColor={colors.t3}
              colors={[colors.accent]}
            />
          }
        >
          {this.renderNotice()}
          {this.renderTop()}
          <View style={styles.warmTip}>
            <Text style={styles.warmTipText}>☕ 今天的咖啡钱，可能已经被股息买单了</Text>
          </View>
          {this.renderCoverage()}
          {this.renderList()}
          {/* 给悬浮 ＋ 留出高度，最后一张卡不会被压住 */}
          <View style={styles.bottomSpace} />
        </ScrollView>

        {/* 悬浮操作：＋ 旋转成 ×，两个动作自下而上逐个弹出（与小程序一致） */}
        {this.data.fabOpen ? (
          <Pressable style={styles.fabMask} onPress={() => this.toggleFab()} />
        ) : null}

        {/* 收起时也要留在树里，否则没有收拢动画；靠 pointerEvents 挡住误触 */}
        <View style={[styles.fabMenu, { pointerEvents: this.data.fabOpen ? 'box-none' : 'none' }]}>
          {this.data.fabActions.map((a, i) => {
            const v = this.itemAnims[i]
            return (
              <Animated.View
                key={a.key}
                style={[
                  styles.fabItem,
                  {
                    opacity: v,
                    transform: [
                      { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
                      { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }
                    ]
                  }
                ]}
              >
                <Pressable style={styles.fabRow} onPress={() => this.onFabAction(a.key)}>
                  <Text style={styles.fabLabel}>
                    {a.icon} {a.label}
                  </Text>
                  <View style={[styles.fabMini, a.btnClass === 'warm' ? styles.fabMiniWarm : null]}>
                    <Text style={styles.fabMiniEmoji}>{a.icon}</Text>
                  </View>
                </Pressable>
              </Animated.View>
            )
          })}
        </View>

        <Pressable style={[styles.fab, this.data.fabOpen ? styles.fabOn : null]} onPress={() => this.toggleFab()}>
          {/* 加号用两条白线画，整体转 45° 就是叉号 —— 与小程序 .fab-icon 同一套做法 */}
          <Animated.View
            style={[
              styles.fabIcon,
              {
                transform: [
                  {
                    rotate: this.fabAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '45deg']
                    })
                  }
                ]
              }
            ]}
          >
            <View style={styles.fabBarH} />
            <View style={styles.fabBarV} />
          </Animated.View>
        </Pressable>

        {/* 排序 / 分组面板 */}
        <Modal visible={!!this.data.sheetKey} transparent animationType="slide" onRequestClose={() => this.closeSheet()}>
          <Pressable style={styles.sheetMask} onPress={() => this.closeSheet()} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{this.data.sheetTitle}</Text>
            {this.data.sheetItems.map((item) => (
              <Pressable key={item.key} style={styles.sheetItem} onPress={() => this.onSheetPick(item.key)}>
                <Text style={[styles.sheetItemText, item.on ? styles.sheetItemTextOn : null]}>
                  {item.desc}
                </Text>
                {item.on ? <Text style={styles.sheetTick}>✓</Text> : null}
              </Pressable>
            ))}
            <Pressable style={styles.sheetCancel} onPress={() => this.closeSheet()}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </Pressable>
          </View>
        </Modal>
      </View>
    )
  }
}

// 浮动盈亏配色：盈利红、亏损绿（与国内行情软件一致），持平走灰
/**
 * 整块内容的入场动画：淡入 + 落位，到位时**弹两下**才停。
 *
 * 堆叠与摊开是**整块被换掉**，没有过渡时是"啪"地一下换完，眼睛跟不上。
 * 这个组件负责把那一次替换讲清楚。
 *
 * ══ 三条踩过的坑 / 刻意的取舍 ══
 *
 * 1. **整块动一次，不是每张卡各自动一次**。原来每张卡是独立的动画组件、
 *    各带 index × 45ms 的递延，读起来是"起步 → 停 → 再起步"，七张卡就是
 *    七次 —— 观感上就是卡的（它其实并不掉帧，Choreographer 一条 Skipped
 *    frames 都没报）。另外逐个动画的合成代价是 N 份：卡片带圆角，Android
 *    为了正确的透明度要把它们各自离屏合成一遍；整块动一次只剩一层。
 *
 * 2. **用弹簧，不用匀速曲线**。要的是"跳跳球落地"那种物理感 —— 落到位之后
 *    在目标附近**来回弹两下**再静止。匀速曲线（Easing.out 之类）永远做不到
 *    这一点：它是单调趋近的，到位就是到位。弹簧是真实物理模拟，欠阻尼时
 *    自然就是"冲过头 → 弹回来 → 再冲一点 → 停"。
 *
 *    阻尼比 ζ = friction / (2·√tension) = 4.6 / (2·√70) ≈ 0.28。ζ < 1 就是
 *    欠阻尼，ζ 越小弹得越多：想更"硬"就把 friction 调大，想多弹几下就调小。
 *
 *    实际测过的过冲轨迹（把弹簧值逐帧打出来看的；1.000 = 就位）：
 *
 *      0.56 → 1.19 → 1.24 → 1.03 → 0.92 → 0.96 → 1.01 → 1.02 → 1.00
 *              冲过头           回弹            再越一次        收敛
 *
 *    它**两次越过目标再回来**才静止 —— 要的"收缩两下"就是这个。
 *
 *    ⚠️ 这条轨迹是临时把弹簧调软（tension 25 / friction 3，ζ≈0.3）测的：
 *    同样阻尼比下形状一致，只是慢 2 倍左右，慢下来才抓得到这几帧。
 *    下面用的 70/4.6 阻尼比相同、快一倍 —— 过冲幅度一样（约 40%），
 *    配 18dp 行程≈ 7dp 的弹跳，看得见在弹，又不会变成整块在晃。
 *
 * 3. **透明度单独走一条短曲线**，不跟位移共用弹簧。弹簧会冲到 1 以上，
 *    透明度被那样拽会一跳一跳地闪；淡入用 180ms 的缓出就够干净了。
 *
 * dir 决定从哪一侧进来，两个方向就是同一段动作正着放 / 倒着放：
 *   'down' —— 展开时用：从上方落到底（新的详细列表接管）
 *   'up'   —— 收起时用：从下方弹到顶（退回堆叠）
 *
 * 组件同时管**进场**和**退场**：
 *   · 进场 —— 挂载即开始，弹到位；
 *   · 退场 —— 由调用方把 closing 置 true 触发，方向相反、快得多，
 *             放完回调 onLeft。调用方在那一刻才把另一块换上来，
 *             于是两块不会在同一帧里一进一出（那样高度对不上，看着像跳了一下）。
 */
const REVEAL_DIST = 18

// 弹簧参数（见上面第 2 条）。
//
// ⚠️ 只能用 tension + friction 这一组，**不能再加 mass** —— RN 把弹簧参数
// 分成三组（bounciness/speed、tension/friction、stiffness/damping/mass），
// 同时给两组会直接抛 Render Error（踩过）。这一组的质量固定为 1，
// 所以阻尼比就是 ζ = friction / (2·√tension)。
const REVEAL_SPRING = { tension: 70, friction: 4.6 }

// 淡入单独走，短一些：位移还在弹的时候，透明度早就到位了
const REVEAL_FADE_MS = 180

// 退场时长。**比进场快得多**：进场要"看着它弹到位"（弹两下才是重点），
// 退场没人愿意等 —— 利落地让开位置，新的那块马上弹进来。
const REVEAL_LEAVE_MS = 220

class DeckReveal extends React.Component {
  constructor(props) {
    super(props)
    // 0 = 在起始位（屏幕外那侧），1 = 就位
    this.offset = new Animated.Value(0)
    this.fade = new Animated.Value(0)
    this.leaving = false
  }

  componentDidMount() {
    Animated.parallel([
      Animated.timing(this.fade, {
        toValue: 1,
        duration: REVEAL_FADE_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true
      }),
      Animated.spring(this.offset, Object.assign({ toValue: 1, useNativeDriver: true }, REVEAL_SPRING))
    ]).start()
  }

  componentDidUpdate(prev) {
    // 退场不是"挂载"出来的：调用方先照常把这块渲染出来，收起时再把 closing
    // 置 true。这样它才能留在原地淡出，而不是被直接卸载掉（那样就没有退场了）。
    if (!prev.closing && this.props.closing) this.leave()
  }

  /**
   * 退场：沿**进来的反方向**退出。
   *
   * 方向是白拿的 —— offset 回到 0 就等于回到入场起点：dir='down' 的那块
   * 于是往上走、dir='up' 的那块往下走，正好各自与入场相反。
   *
   * 这里**不用弹簧**：弹簧的尾巴是"在目标附近来回几下"，退场时那几下发生在
   * 屏幕外或半透明处，根本看不见，却会让下一块多等几百毫秒。
   */
  leave() {
    if (this.leaving) return
    this.leaving = true

    Animated.parallel([
      Animated.timing(this.fade, {
        toValue: 0,
        duration: REVEAL_LEAVE_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true
      }),
      Animated.timing(this.offset, {
        toValue: 0,
        duration: REVEAL_LEAVE_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true
      })
    ]).start(() => {
      // 退干净了才通知外面换块（见 Holdings.onDeckLeft）
      if (this.props.onLeft) this.props.onLeft()
    })
  }

  componentWillUnmount() {
    // 卡片可能在动画中途被移除（切市场、删持仓、切账户），
    // 不停的话回调会打到已卸载的组件上
    this.offset.stopAnimation()
    this.fade.stopAnimation()
  }

  render() {
    const from = this.props.dir === 'up' ? REVEAL_DIST : -REVEAL_DIST

    return (
      <Animated.View
        style={{
          opacity: this.fade,
          transform: [
            {
              translateY: this.offset.interpolate({
                inputRange: [0, 1],
                outputRange: [from, 0]
              })
            }
          ]
        }}
      >
        {this.props.children}
      </Animated.View>
    )
  }
}

/**
 * 一张完整的持仓卡片。
 *
 * 从 renderList 里抽出来，是为了让「摊开」和「堆叠」两条路径**共用同一个组件** ——
 * 否则叠卡展开后看到的卡片和顶层那张会长得不一样，改一处忘一处。
 */
function HoldCard(props) {
  const h = props.h
  return (
    <Pressable style={[styles.card, styles.holdCard]} onPress={props.onPress}>
      <View style={s.between}>
        <View style={s.row}>
          <View style={styles.stockIco}>
            <Text style={styles.stockIcoText}>{h.icon}</Text>
          </View>
          <View style={{ marginLeft: 6 }}>
            <View style={s.row}>
              <Text style={s.bold}>{h.name}</Text>
              <Text style={[s.tag, tagStyleOf(h.tagClass), { marginLeft: 4 }]}>{h.marketTag}</Text>
            </View>
            <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>{h.code}</Text>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.holdDividend, s.num]}>{h.dividendText}</Text>
          <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>预测分红</Text>
        </View>
      </View>

      <View style={styles.holdMeta}>
        <MetaCell label="市值" value={h.marketValueText} first />
        <MetaCell label="成本" value={h.costText} />
        <MetaCell label="持仓" value={h.sharesText} />
        <MetaCell label="股价息率" value={h.priceYieldText} tone="up" />
      </View>

      {/* 浮动盈亏（现市值 − 持仓成本）：单独一行，不占上面四格的位置 */}
      <View style={styles.profitRow}>
        <Text style={styles.profitLabel}>浮动盈亏</Text>
        {/* ⚠️ profitRight 是"按内容占宽、压住不缩"，两个 Text 都限一行。
            这里的约束一个都不能少：少于 9% 时看着正常，超过之后最后的 %
            会被切掉，屏幕上只剩「+10.91」—— 来由见 styles.profitRight
            上面那段注释（我第一版修反了方向，别再踩一遍）。 */}
        <View style={styles.profitRight}>
          <Text style={[styles.profitValue, s.num, profitToneOf(h)]} numberOfLines={1}>
            {h.floatProfitText}
          </Text>
          <Text style={[styles.profitPct, s.num, profitToneOf(h)]} numberOfLines={1}>
            {h.floatProfitPctText}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

/**
 * 堆叠态里的一张卡：**压缩版**的持仓。
 *
 * 与 HoldCard 的区别只在「露出多少」：
 *   · HoldCard 是完整卡片（四格 + 盈亏行），用于摊开后逐条细看；
 *   · 这张只留一只标的最要紧的三件事 —— 叫什么、持有多少、能收多少分红。
 *
 * 之所以要紧凑，是因为堆叠的前提是**一屏能看见好几张**。
 * 如果每张都做成完整卡片，叠起来仍然要滚很久，「堆叠」就只剩装饰作用了。
 *
 * 注意它与参考图的对应关系：大标题 = 标的名称，两个小标签 = 市场 + 代码/股数，
 * 右上角数字 = 预测分红。参考图那里的百分比和这张的分红是同一个位置 ——
 * 都是「这张卡最值得一眼看到的一个数」。
 */
function DeckCard(props) {
  const h = props.h
  return (
    <Pressable
      style={[styles.deckCard, props.first ? null : styles.deckCardStack]}
      onPress={props.onPress}
    >
      <View style={s.row}>
        <View style={styles.stockIco}>
          <Text style={styles.stockIcoText}>{h.icon}</Text>
        </View>

        <View style={{ flex: 1, marginLeft: 8 }}>
          <View style={s.row}>
            <Text style={styles.deckName} numberOfLines={1}>
              {h.name}
            </Text>
            <Text style={[s.tag, tagStyleOf(h.tagClass), { marginLeft: 5 }]}>{h.marketTag}</Text>
          </View>
          <Text style={styles.deckSub}>
            {h.code} · {h.sharesText}
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.deckAmt, s.num]}>{h.dividendText}</Text>
          <Text style={styles.deckSub}>预测分红</Text>
        </View>
      </View>
    </Pressable>
  )
}

/**
 * 收起的持仓：一摞紧贴的卡片。
 *
 * 与参考图一致的做法是**每张露出几乎全部内容**，只在相接处叠掉十几像素 ——
 * 叠掉的量必须远小于卡片高度，否则就成了「只露一条边」，
 * 那会看不出每张卡里是什么，堆叠也就失去了意义（这一点第一版做错过）。
 *
 * 卡内容用 DeckCard（紧凑版）而不是完整卡片：堆叠图的是「一屏能扫过好几只」，
 * 每张都塞满四格的话，叠起来照样要滚很久。
 */
function StackedDeck(props) {
  const list = props.list || []
  if (!list.length) return null

  return (
    // dir="up"：收起时整块从下方弹到顶 —— 与展开的落到位互为反向
    <DeckReveal dir="up" closing={props.closing} onLeft={props.onLeft}>
      <View style={styles.deck}>
        {/* 点任意一张都是**摊开整个列表**，而不是进这一只的详情：
            收起态的语义是「先看个大概」，点它表达的是「我要看全部」。
            进详情留给摊开之后 —— 那时每张卡都是完整的，点它才是「我要看这一只」。 */}
        {list.map((h, i) => (
          // zIndex 必须挂在**包住卡片的那一层**：它成了 DeckCard 的新同级兄弟。
          // 挂在 DeckCard 上只在自己那一层内排序、对外面无效 —— 那样堆叠会变成
          // "先渲染的压住后渲染的"，与预期正好相反。
          <View key={h.id} style={{ zIndex: i + 1 }}>
            <DeckCard h={h} first={i === 0} onPress={props.onOpen} />
          </View>
        ))}
      </View>

      {/* 提示条：卡片本身已经能点，但叠着的卡片"可点"这件事不是自明的 ——
          参考图每张卡右侧有个圆形箭头按钮来暗示可点，我们这边整张卡就是按钮，
          没有这个视觉线索，所以补一句文字说明。

          它放在 DeckReveal **里面**（原来是外面）：退场时得跟着卡片一起走，
          留在外面会"啪"地一下先消失，比卡片还早。 */}
      <Pressable style={styles.deckHint} onPress={props.onOpen}>
        <Text style={styles.deckHintText}>展开全部 {list.length} 只 ⌄</Text>
      </Pressable>
    </DeckReveal>
  )
}

function profitToneOf(h) {
  if (h.floatProfitUp) return styles.profitUp
  if (h.floatProfitDown) return styles.profitDown
  return styles.profitFlat
}

function MetaCell(props) {
  return (
    <View style={[styles.metaCell, props.first ? null : styles.metaCellLine]}>
      <Text style={styles.metaLabel}>{props.label}</Text>
      <Text style={[styles.metaValue, s.num, props.tone === 'up' ? styles.metaValueUp : null]}>
        {props.value}
      </Text>
    </View>
  )
}

// 标签页前面的小圆点。
//
// 原来每个市场一个颜色（A股红 / 港股绿 / ETF金 / 基金紫 / 美股蓝），取自小程序的
// .dot-a / .dot-hk / …。但它们和文字标签传达的是**同一个信息**（这是哪个市场），
// 颜色在这里纯属重复，代价却是凭空多出 4 个色相 —— 整个页面的颜色数量直接翻倍。
//
// 而且 A股的红/港股的绿还被误读成涨跌：那两个颜色和行情涨跌色一模一样。
//
// 统一成中性色：圆点退回它该有的角色（一个列表项标记），不再参与配色。
const DOT_COLOR = colors.t3

const DOT_COLORS = {
  'dot-a': DOT_COLOR,
  'dot-hk': DOT_COLOR,
  'dot-etf': DOT_COLOR,
  'dot-fund': DOT_COLOR,
  'dot-us': DOT_COLOR
}
function dotColor(name) {
  return DOT_COLORS[name] || colors.t3
}

const styles = StyleSheet.create({
  // 页面留白：小程序是 .page-flat（左右 24rpx、底部 60rpx）
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30 },
  bottomSpace: { height: 90 },

  // 卡片带小程序 .card 那层很淡的投影
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    shadowColor: '#172B23',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },

  empty: { paddingVertical: 45, alignItems: 'center' },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: { marginTop: 11, fontSize: 14, color: colors.t2 },

  /* ---------- 顶部深色卡 ---------- */
  topCard: { backgroundColor: '#232323', borderRadius: 14, padding: 14 },
  streak: { flexDirection: 'row', alignItems: 'center' },
  // 🔥 的底板：小程序是 150° 渐变（#FF9E8E → #F4586B），RN 没装渐变库，取中间色
  streakIco: {
    width: 26,
    height: 26,
    borderRadius: 8,
    marginRight: 6,
    backgroundColor: colors.upLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  streakIcoText: { fontSize: 14, lineHeight: 14 },
  // flex 0 1 auto：文案按内容宽度排，句尾的 💪 紧跟文字，不会被推到行末
  streakText: { flexShrink: 1, fontSize: 11, lineHeight: 15, color: 'rgba(255,255,255,0.88)' },
  streakEmojiBox: {
    height: 16,
    paddingHorizontal: 4,
    marginLeft: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.13)',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  streakEmoji: { fontSize: 10, lineHeight: 10 },

  onDarkSmall: { fontSize: 12, color: 'rgba(255,255,255,0.55)' },
  onDarkTiny: { fontSize: 11, color: 'rgba(255,255,255,0.55)' },
  bigNum: {
    fontSize: 33,
    fontWeight: '700',
    letterSpacing: -0.5,
    color: '#FFFFFF',
    fontVariant: ['tabular-nums']
  },
  future: { fontSize: 11, color: 'rgba(255,255,255,0.6)' },

  dividerDark: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginVertical: 12
  },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  metric: { width: '33.33%', paddingVertical: 7 },
  metricValue: { marginTop: 4, fontSize: 13, color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  // 顶部汇总里「按涨跌着色」的指标（浮动盈亏 / 盈亏率）。
  //
  // ⚠️ metricUp 曾经被当成**浮动盈亏的固定色**用 —— mock 的 metricCatalog 里给它
  // 标了 tone:'up'，页面就照着这个常量上色，于是**赚和亏是同一个橙色**。
  // 现在 tone 由 api 层按实际正负给出（metricToneOf），'up' 才真的表示涨。
  //
  // 两个色都比卡片上那组（colors.up / colors.down）亮一档：这里是深色卡，
  // 同样的红绿压上去会发闷、认不出方向。语义与卡片上的 profitToneOf 一致：
  // 盈利红、亏损绿、持平时两个都不加（走 metricValue 的白）。
  metricUp: { color: colors.upLight },
  metricDown: { color: colors.downLight },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  toggle: { flexDirection: 'row', alignItems: 'center' },
  toggleText: { fontSize: 12, lineHeight: 12, color: 'rgba(255,255,255,0.78)' },
  metricSet: { fontSize: 12, lineHeight: 12, color: 'rgba(255,255,255,0.65)' },
  // 箭头只描两条边再旋转，与小程序 .chev 同一套做法（不用字体符号，基线更稳）
  chev: {
    width: 6.5,
    height: 6.5,
    marginLeft: 6,
    marginTop: -3,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.78)',
    transform: [{ rotate: '45deg' }]
  },
  chevUp: { transform: [{ rotate: '-135deg' }], marginTop: 3 },

  /* ---------- 首页公告条 ----------
   *
   * 用主色的极浅底（accentA10）而不是暖色/白色：
   * 它要说的是"这是官方通知"，与下面那条咖啡钱的暖色调侃、以及
   * 半透明白的持仓卡都得分得开 —— 三者同屏，靠颜色区分比靠位置可靠。
   */
  notice: {
    flexDirection: 'row',
    // 用 flex-start 而不是 center：公告可能换行，图标和叉号应该跟第一行对齐，
    // 居中的话多行文本会把它们拉到中间，看着像浮在半空
    alignItems: 'flex-start',
    backgroundColor: colors.accentA10,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
    marginBottom: 12
  },
  noticeIcon: { fontSize: 13, marginRight: 7, marginTop: 1 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 19, color: colors.t1 },
  noticeClose: { fontSize: 14, color: colors.t3, marginLeft: 10, marginTop: 1 },

  /* ---------- 暖色提示条 ---------- */
  warmTip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    backgroundColor: colors.warm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warmLine,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  warmTipText: { fontSize: 13, lineHeight: 19, color: '#8A6A22' },

  // 小程序里 🎯 是装在 .icon-box（56rpx≈28px、圆角 16rpx、浅金底）里的，字号 30rpx≈15px；
  // RN 这端之前是裸 emoji 且字号更大，在 App 上看着发胖，补回同样的容器与字号
  h3: { fontSize: 15, fontWeight: '600', color: colors.t1 },

  // 小程序里 🎯 装在 .icon-box（56rpx≈28px、圆角 16rpx、浅金底）里，字号 30rpx≈15px
  covIconBox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(217, 169, 60, 0.14)'
  },
  covIcon: { fontSize: 15, lineHeight: 15 },
  // ScrollView 的外边距挂在它自己身上，不挂 contentContainer：
  // 挂在后者上虽然也生效，但那 12px 会被算进滚动内容的高度里，
  // 滚动条与滚动边界都按它算，多出来的这段空白说不清是谁的。
  covScroll: { marginTop: 12 },
  /**
   * 内容行：单纯一行，不换行。
   *
   * flexGrow: 1 是"少项时均分一屏宽"的关键 —— 横向 ScrollView 的内容区
   * 默认只占内容实际宽度，加了它之后会拉伸到**至少等于可视宽度**，
   * 里面的 flexGrow 子项才有富余空间可瓜分。
   *
   * gap 只在相邻块之间留白，首尾不算 —— 因此下面算 COV_ITEM_W 时
   * 减的是 (n-1) 个间隙而不是 n 个。
   */
  // minWidth: '100%' 与 flexGrow 一起用是双保险：前者明确要求内容区
  // 至少与可视区等宽，后者在 Row 内部把富余空间分给子项。
  // 只写 flexGrow 时，某些 RN 版本在横向 ScrollView 里不会拉伸内容区，
  // 表现就是"少项时右边仍然空着"—— 正是这次要修的那个现象。
  covRow: { flexDirection: 'row', gap: COV_GAP, flexGrow: 1, minWidth: '100%' },
  /**
   * 覆盖项。
   *
   * minWidth + flexGrow 的组合同时满足两种情形，不需要在 render 里按数量分支：
   *   · 项数 ≤ 7：minWidth 没机会生效，flexGrow 把它们**均分一屏宽**；
   *   · 项数 > 7：总和超过一行，minWidth 顶住不被压缩，于是溢出、可以横滑。
   *
   * 只用固定 width 的话，少项时右边会空一块；只用 flexGrow 的话，
   * 多项时会被无限压扁（每个只剩十来像素宽）。
   */
  covItem: {
    minWidth: COV_ITEM_W,
    flexGrow: 1,
    paddingTop: 7,
    paddingBottom: 6,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E9EDEB',
    backgroundColor: '#F7F9F8',
    alignItems: 'center',
    opacity: 0.45
  },
  covOn: {
    opacity: 1,
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentA30
  },
  // 「进行中」与「已完成」同色，只把实线换成虚线（小程序 .cov-item.doing）
  covDoing: {
    opacity: 1,
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentA30,
    borderStyle: 'dashed'
  },
  covItemIcon: { fontSize: 16, lineHeight: 17 },
  covItemName: { marginTop: 5, fontSize: 10, lineHeight: 10, color: colors.t3 },
  covItemNameOn: { color: colors.accent },

  /* ---------- 我的持仓 ---------- */
  secHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
    paddingHorizontal: 4
  },
  h2: { fontSize: 17, fontWeight: '600', color: colors.t1 },
  // 数量角标：小程序是浅灰底，不是绿色
  countTag: {
    marginLeft: 4,
    fontSize: 11,
    color: colors.t2,
    backgroundColor: '#EFF2F1',
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
    overflow: 'hidden'
  },

  mini: { backgroundColor: '#EFF2F1', borderRadius: 7, paddingHorizontal: 12, paddingVertical: 6 },
  miniMl: { marginLeft: 6 },
  miniActed: { backgroundColor: colors.accentA12 },
  miniText: { fontSize: 12, color: colors.t2 },
  miniTextActed: { color: colors.accent, fontWeight: '600' },

  tabs: { marginTop: 11, marginBottom: 11 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    marginRight: 8
  },
  // 选中态改用主色（原来是深色的 #232323，沿自小程序的 .tab.on）。
  //
  // 两个理由：一是底部导航的选中态本来就是主色，这里是深色，同一个 App 里
  // 出现两套"选中"语言；二是深色胶囊在浅灰底上分量很重，
  // 跟"切个市场标签"这种轻量操作不匹配 —— 它看着像主按钮。
  tabOn: { backgroundColor: colors.accent },
  tabText: { fontSize: 13, color: colors.t2 },
  tabTextOn: { color: '#FFFFFF', fontWeight: '600' },
  dot: { width: 7, height: 7, borderRadius: 3.5, marginRight: 6 },
  /**
   * 选中时圆点转白。
   *
   * 选中态的胶囊底就是主色（见 tabOn），主色的点压在主色的底上等于没有 ——
   * 而不选中的那些点是灰的（DOT_COLOR），于是选中态反而成了唯一一个"没有点"
   * 的标签，看着像漏画了。转白之后，点和同一行的白色文字是同一个信号：
   * 这一整条都选中了。
   *
   * 注意这里**不是**要恢复"每个市场一个颜色"（那套已经被推翻了，
   * 理由见上面 DOT_COLOR 附近的注释）。这里只是一条选中/未选中的对比。
   */
  dotOn: { backgroundColor: '#FFFFFF' },

  groupHead: { flexDirection: 'row', alignItems: 'center', paddingTop: 10, paddingBottom: 7 },
  groupTitle: { fontSize: 13.5, fontWeight: '600', color: colors.t1 },

  /**
   * 摊开态的持仓卡。
   *
   * ⚠️ 刻意**不带阴影**（下面把 card 的 elevation 覆盖掉），改用极浅描边。
   * 三条理由，任何一条单独都够：
   *
   *  1. 摊开后相邻两张只隔 10dp，而阴影本身往下铺 2~3dp —— 空隙被阴影填满，
   *     两张卡之间就出现一条灰带，像卡片底下漏了脏东西。
   *  2. **展开动画期间最明显**：整块内容是从半透明淡入的（见 DeckReveal），
   *     而 Android 的 elevation 阴影**不跟着 opacity 走** —— 卡片还半透明时
   *     阴影已经是全强度，于是能看到一片灰影围着卡片"飘"。这正是当初反馈的
   *     那个现象，也是它只在点击时才出现的原因。去掉 elevation 之后，
   *     动画就只剩干净的淡入 + 落位。
   *  3. 堆叠态的 DeckCard 本来就是描边、无阴影（见上面的注释）。堆叠与摊开是
   *     同一批卡片的两种呈现，不该一个浮在页面上、一个贴在页面上。
   */
  holdCard: {
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E7EBE9',
    elevation: 0,
    // iOS 的 shadow* 也要一起关掉，不然同一个问题换个平台再犯一次
    shadowOpacity: 0
  },

  // ---------- 持仓卡片堆叠 ----------
  deck: { marginBottom: 10 },
  // 紧凑卡：沿用完整卡片那一套视觉（白底、14 圆角、极浅描边），
  // 让堆叠态与摊开态看起来是"同一批卡片的两种呈现"，
  // 而不是两套不相干的东西 —— 切换时不会有换了个页面的感觉
  deckCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E7EBE9',
    paddingHorizontal: 12,
    paddingVertical: 11
  },
  // 叠上去：负边距把上一张的下缘盖掉一点。
  //
  // 这里能用负边距（而第一版只能用画的边），是因为重叠量**很小**：
  // 盖掉 15px、剩下四十几像素的内容，无论卡片实际高度是多少都够用。
  // 所以不依赖"知道卡片高度"这个算不准的量 —— 而当初想只露一条边时，
  // 盖掉的部分接近整张卡，就必须知道准确高度，那件事做不到。
  deckCardStack: { marginTop: -DECK_OVERLAP },
  deckName: { fontSize: 14.5, fontWeight: '600', color: colors.t1, maxWidth: '74%' },
  deckSub: { fontSize: 11, color: colors.t3, marginTop: 3 },
  deckAmt: { fontSize: 16, fontWeight: '700', color: colors.t1, letterSpacing: -0.2 },
  deckHint: { marginTop: 12, paddingVertical: 9, alignItems: 'center' },
  deckHintText: { fontSize: 12, color: colors.accent, fontWeight: '600' },
  // .stock-ico：64rpx 方块、18rpx 圆角、浅灰底
  stockIco: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: '#EDF0EF',
    alignItems: 'center',
    justifyContent: 'center'
  },
  stockIcoText: { fontSize: 15, color: colors.t2 },
  // 预测分红主数字用深色，橙色只留给息率等强调值
  holdDividend: {
    fontSize: 19,
    fontWeight: '700',
    color: colors.t1,
    letterSpacing: -0.25,
    lineHeight: 21
  },
  // 四列指标：浅灰底圆角容器，列内居中，列间细分隔线
  holdMeta: {
    flexDirection: 'row',
    marginTop: 13,
    backgroundColor: '#F7F9F8',
    borderRadius: 9,
    paddingVertical: 11
  },
  metaCell: { flex: 1, alignItems: 'center' },
  metaCellLine: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#E7EBE9' },
  metaLabel: { fontSize: 11, color: colors.t3 },
  metaValue: { marginTop: 5, fontSize: 13.5, fontWeight: '500', color: colors.t1 },
  metaValueUp: { color: colors.orange },

  // 浮动盈亏：标签在左、金额与比例在右；金额为主、比例退一档
  //
  // ⚠️ 这里**不能用 justifyContent: 'space-between'**。用过，是坏的：
  // 两端对齐时两侧都按**内容宽**分配，flex 算出来的可用宽比内容窄一截，
  // 右侧那组于是被压到放不下，最后的 % 被切掉（改成 numberOfLines 后
  // 变成省略号「+10.9...」—— 症状从"少了 %"变成"多了一串点"，
  // 本质是同一个：宽度不够）。
  //
  // 改成左侧标签按内容占位、右侧 flex: 1 吃满剩余空间再右对齐。
  // 这样右侧拿到的是"卡片宽度减去标签"的全部空间，而不是一个算出来的窄值。
  profitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingHorizontal: 2
  },
  // ⚠️ 这一组 flex 属性是修一个真实显示 bug 的，别顺手删掉，也别"优化"成
  // 让右侧收缩 —— 那样会把它改回坏的。
  //
  // bug：浮动盈亏超过 9% 时右边的 % 被切掉，屏幕上只剩「+10.91」。
  //（9.99% → 10.00% 只多一个字符，正好跨过那条线，所以看着像有个 9% 阈值。）
  // 数据是好的：uiautomator dump 出来的节点文本就是完整的「+10.91%」，
  // 切掉它的是渲染。signedPctText 也永远会拼上 %，从格式化角度查永远查不到。
  //
  // ⚠️ 我第一版修反了：给右侧容器加 flexShrink: 1，想让它"能被压缩"。
  // 结果更糟 —— 压缩改的是**布局宽度**，而 Text 的内容宽度不变，文字照样
  // 按原样画出去，超出的部分（正是最后的 %）被裁掉。容器只剩 172px，
  // 而 % 排在最后，第一个被牺牲。
  //
  // 正确方向是**不让右侧收缩**：按内容占宽（flexShrink: 0），
  // 于是「+¥1,859.41 +10.91%」整段都有地方放。
  // 让位的工作交给**左边的标签**（它只有四个字，缩得起）——
  // 实测这一行内容总共约 620px，卡片有 1095px，本来就放得下，
  // flexShrink 那一脚纯属多余。
  //
  // numberOfLines={1} 是配套的保险：万一以后金额长到真放不下，
  // 它会整段省略而不是画到卡片外面去（后者正是这次 bug 的形态）。
  //
  // ⚠️ 这三个值也是试出来的，最终形态：
  //   · 标签按内容占位（缩得起，它只有四个字）；
  //   · 右侧那一组 flex: 1 —— 吃满剩余空间，宽度是"卡片宽 − 标签宽"这个
  //     实数，而不是 space-between 下算出来的窄值。这一条是关键（见上面
  //     profitRow 的注释）；
  //   · 里面两个 Text 都不设 flexShrink —— 于是都按内容宽排，% 稳稳在。
  profitLabel: { fontSize: 11, color: colors.t3, marginRight: 8, flexShrink: 1 },
  profitValue: { fontSize: 14, fontWeight: '600' },
  profitPct: { fontSize: 12, fontWeight: '500', marginLeft: 6 },
  // 右侧那一组（金额 + 比例）：吃满剩余宽度，内容靠右。
  profitRight: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end'
  },
  // 红涨绿跌，与国内行情软件一致
  profitUp: { color: '#E5484D' },
  profitDown: { color: colors.down },
  profitFlat: { color: colors.t3 },

  holdEmpty: {
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 35,
    paddingHorizontal: 10,
    alignItems: 'center'
  },
  holdEmptyText: { fontSize: 12.5, color: colors.t3, textAlign: 'center' },

  /* ---------- 悬浮操作菜单 ---------- */
  fabMask: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.18)' },
  // .speed-dial：FAB 底部 150rpx + FAB 高 96rpx + 间距 20rpx
  fabMenu: { position: 'absolute', right: 16, bottom: 133, alignItems: 'flex-end' },
  fabItem: { marginBottom: 13 },
  fabRow: { flexDirection: 'row', alignItems: 'center' },
  /**
   * ⚠️ 这两个菜单元素**不要 elevation / 阴影**。
   *
   * 它们的出现与收起都是**靠 opacity 淡入淡出**的（animateFab 里动的是 opacity
   * 和 transform），而 Android 的 elevation 阴影**不跟着 opacity 走** ——
   * 元素已经透明了、阴影还在原强度上，于是页面上留着一片灰影，
   * 要等下一次整屏重绘才消失。用户反馈的"退回后残留阴影、很晚才消除"就是它
   * （菜单是在 onHide 里关的，所以动画正好发生在离开那一刻，回来才看见）。
   *
   * 这与 holdCard 那条注释里记的是同一个坑（那里还多一层：半透明淡入时更明显）。
   * 做法保持一致：**去掉阴影，改用 hairline 描边** —— 描边跟着 opacity 走，
   * 淡出就是干净的淡出。
   *
   * （下面那个常驻的 ＋ 按钮不在此列：它不淡出，阴影跟着它本体，没有这个问题。）
   */
  fabLabel: {
    fontSize: 13,
    color: colors.t1,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    marginRight: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.06)'
  },
  fabMini: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.06)'
  },
  // 小程序里手动添加那个是暖色底（.speed-btn.warm）
  fabMiniWarm: { backgroundColor: colors.warm },
  fabMiniEmoji: { fontSize: 18, lineHeight: 18 },

  // 与小程序 .fab 一致：96rpx 的黑圆底 + 阴影
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 75,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#232323',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 8
  },
  fabOn: { backgroundColor: '#101010' },
  fabIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  fabBarH: { position: 'absolute', width: 20, height: 2, borderRadius: 1, backgroundColor: '#FFFFFF' },
  fabBarV: { position: 'absolute', width: 2, height: 20, borderRadius: 1, backgroundColor: '#FFFFFF' },

  /* ---------- 排序 / 分组面板 ---------- */
  sheetMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingTop: 4,
    paddingBottom: 10
  },
  sheetTitle: {
    paddingTop: 15,
    paddingHorizontal: 16,
    paddingBottom: 9,
    textAlign: 'center',
    fontSize: 12.5,
    color: colors.t3
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line
  },
  sheetItemText: { flex: 1, fontSize: 14.5, color: colors.t1 },
  sheetItemTextOn: { color: colors.accent, fontWeight: '600' },
  sheetTick: { fontSize: 15, color: colors.accent },
  sheetCancel: {
    marginHorizontal: 12,
    marginTop: 10,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#F4F6F5',
    alignItems: 'center'
  },
  sheetCancelText: { fontSize: 15, color: colors.t2 }
})

module.exports = Holdings
