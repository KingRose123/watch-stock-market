const React = require('react')
const {
  View,
  Text,
  Image,
  ScrollView,
  Pressable,
  StyleSheet,
  Dimensions,
  Modal,
  FlatList,
  Animated,
  PanResponder,
  RefreshControl
} = require('react-native')
const { SafeAreaView } = require('react-native-safe-area-context')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const poll = require('../utils/poll.js')
const skel = require('../components/Skeleton.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

/**
 * 社区首页。
 *
 * 页面自己画顶部（品牌大字 + 搜索），不套 App 那条自绘标题栏 ——
 * 见 App.js 的 TAB_LIST 里 Community 那条 bare 标记。
 *
 * 为什么值得破这个例：其余三个 tab 是"工具"，顶部一条「持仓 / 分红日历 / 我的」
 * 正合适；而社区要立的是"这里有人、有内容"的场子感，一条小标题栏撑不起来。
 * 参照的是主流内容社区的做法：首屏第一眼是品牌，然后才是内容。
 */

// 轮播自转间隔。4 秒是"看得完一行标题、又不会等到不耐烦"的折中：
// 2 秒来不及看，8 秒用户早滑走了，自转就白转。
const SPOTLIGHT_MS = 4000

/**
 * 轮播每一屏的宽度 = 屏宽减去页面左右内边距（s.content 的 16×2）。
 *
 * 不用百分比：百分比在 ScrollView 的内容区里算不准，直接算像素。
 * 翻页对齐靠的是 SPOT_STEP（见下），所以这里只需保证"卡宽 = 内容区宽"。
 */
const SPOT_W = Dimensions.get('window').width - 32

/**
 * 轮播卡片之间的缝。
 *
 * 不能是 0：翻页时相邻两张会**贴在一起**，而卡片自带阴影（s.card 的
 * elevation），两张卡的阴影在接缝处叠加，四个角糊成一团深色。
 * 有缝之后每张卡各占一格，阴影也有地方散开。
 */
const SPOT_GAP = 10

// 每页前进的距离 = 卡宽 + 缝。snapToInterval 用它，翻页才对得齐。
const SPOT_STEP = SPOT_W + SPOT_GAP

// 放大态图集里"一页"的宽度 = 整个屏幕宽（不扣页面内边距）。
// 大图浮层是全屏的，页面那 16 的内边距在这里不适用；
// 而 pagingEnabled 按**可视宽度**翻页，所以它必须与屏宽严格相等。
const ZOOM_W = Dimensions.get('window').width
// 图集里一页的高度取整屏：这样"点任意处关闭"才真的覆盖任意处。
const ZOOM_H = Dimensions.get('window').height

/**
 * 双击判定窗口（毫秒）。
 *
 * ⚠️ 这个值同时决定**单击关闭的延迟**：单击得等满这个窗口才能确定
 * "没有第二下"，所以它不能太大（大了就点一下半天不关），也不能太小
 * （小了正常速度的双击会被拆成两次单击，等于关掉浮层）。
 * 280 是这两头之间比较稳的位置，与系统双击间隔同量级。
 */
const DOUBLE_TAP_MS = 230

/**
 * 刚打开浮层时的「关闭豁免」窗口（毫秒）。与 CommunityDetail 那份是同一个东西，
 * 原因也相同：打开浮层的那一次点击，其抬手会落到刚挂上来的浮层上，
 * 被"点任意处关闭"的热区接住 —— 浮层刚开就被关掉，看起来就是"点了没反应"。
 * 详情见 CommunityDetail.js 里 ZOOM_OPEN_GUARD_MS 的注释。
 */
const ZOOM_OPEN_GUARD_MS = 350

// 双击放大到多少倍。2.4 能看清细节，又不至于一眼只看得到纹理。
const ZOOM_BIG_SCALE = 2.4

/**
 * 放大浮层里"一块图"的基准边长（px，86% 屏宽）。
 *
 * ⚠️ 它**不再**是图片容器的宽度了 —— 容器现在铺满整页（见 zoomBox），
 * 图片按自己的比例完整显示。这个常量还剩两个用处：
 *
 *   1. 内置示例内容的占位块大小（zoomPh：一个色块 + 一个 emoji）；
 *   2. 放大后**能拖动多远**的上限（panLimit）。
 *
 * 第 2 条是它必须还留着的原因：拖动边界要有个确定的值，而它是个保守值 ——
 * 偏小一点不会让人把图拖出屏幕，偏大就会"拖到只剩空白"。
 */
const ZOOM_BOX_W = Math.round(Dimensions.get('window').width * 0.86)

// 列表里最多摆几张图。4 张正好一行铺满、每张还看得清是什么；
// 再多就该进详情了（理由见 renderThumbs）。
const THUMB_MAX = 4

const MONTHS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

/** '2026-09-21' → 「21 九月」 */
function dayLabel(date) {
  const p = String(date || '').split('-')
  const m = Number(p[1])
  if (!p[2]) return String(date || '')
  return Number(p[2]) + ' ' + (MONTHS[m - 1] || '') + '月'
}

/**
 * 按日期分组，新的在上。
 *
 * 分组键用**日期**而不是"多久以前"：后者是随时间变的量，同一份数据
 * 今天显示「今天」明天变「昨天」，缓存、截图对比、跨端对齐全对不上。
 * "多久以前"那种只在单条卡片上作为附属信息出现（timeText）。
 */
function groupByDate(list) {
  const map = {}
  ;(list || []).forEach((it) => {
    const k = it.date || ''
    if (!map[k]) map[k] = []
    map[k].push(it)
  })
  return Object.keys(map)
    .sort()
    .reverse()
    .map((date) => ({ date: date, label: dayLabel(date), items: map[date] }))
}

class Community extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      // 首屏还在取数（决定要不要画骨架，见 firstLoad）
      loading: true,
      // 用户下拉之后、新内容到手之前为 true。它只驱动那个转圈，
      // 页面上的内容照旧显示 —— 两者是两件事，见 fetch 的说明。
      refreshing: false,
      topics: [],
      promo: null,
      checkin: null,
      spotlight: [],
      feed: [],
      seg: 0, // 0 推荐 / 1 关注
      spot: 0, // 当前轮播序号
      topic: '', // 话题筛选，空串＝不筛
      // 图片放大：{ list, i } —— 整组图 + 起点下标。null＝没在放大。
      // 存整组而不是单张，是为了放大后还能左右滑动看完（见 openZoom）
      zoom: null,
      zoomAt: 0, // 滑动后当前停在第几张（只用来显示 "2 / 5"）
      zoomBig: false, // 双击放大态（再双击回到原大小）
      // 我在各道投票上选的是哪一项：{ [内容 id]: 选项下标 }。
      // 与详情页共用同一份本机存储（utils/poll.js），所以两边看到的票是同一票
      picks: {}
    }
    // 轮播定时器与信息流起始位置（用于筛选后滚过去）
    this.timer = null
    this.feedY = 0
    // 双击放大的缩放值（1＝原大小）。用 Animated.Value 是为了让它平滑过渡，
    // 直接 setState 换数值会"啪"地跳一下。
    this.zoomScale = new Animated.Value(1)
    this.tapTimer = null // 单击延迟关闭的定时器

    // 放大后拖动图片用的位移。Animated.Value 取不出当前值，所以位置另存一份。
    this.panX = new Animated.Value(0)
    this.panY = new Animated.Value(0)
    this.panPos = { x: 0, y: 0 }
    this.panStart = { x: 0, y: 0 }

    // 刚还原之后的一小段窗口，用来吞掉"双击的第二下"
    this.suppressUntil = 0

    /**
     * 放大后拖动查看图片的其他区域，同时也是放大态下的点击入口。
     *
     * ⚠️ 关键是 `onStartShouldSetPanResponder`：**按下的那一刻**就接管手势
     * （只在放大态）。这样外层那个"点空白关闭"的 Pressable 根本收不到这一下，
     * 拖动就不会被它判成"点击"而把浮层关掉 —— 之前用 onMoveShouldSet 时
     * 正是死在这里：移动之前外层已经拿住手势了。
     *
     * 没放大时这里一律不接管，横向拖动留给图集翻页
     * （配合 FlatList 的 `scrollEnabled={!zoomBig}`），两者不会抢。
     */
    this.pan = PanResponder.create({
      onStartShouldSetPanResponder: () => !!this.data.zoomBig,
      onPanResponderGrant: () => {
        this.panStart = { x: this.panPos.x, y: this.panPos.y }
      },
      onPanResponderMove: (e, g) => this.setPan(this.panStart.x + g.dx, this.panStart.y + g.dy),
      /**
       * 松手时回头看总位移：几乎没动 ＝ 这是一次点击（放大态下＝还原），
       * 动过 ＝ 这是一次拖动，什么都不做（位移已经在 move 里落下了）。
       *
       * 拖动和点击都由这**一个**手势处理器判定，不存在两个视图抢的问题 ——
       * 这也是选方案 A 的原因。
       */
      onPanResponderRelease: (e, g) => {
        if (Math.abs(g.dx) + Math.abs(g.dy) < 8) this.onZoomTap()
      },
      // 不把响应权让出去：让出去的话，拖到一半会被外层抢走、图片弹回去
      onPanResponderTerminationRequest: () => false
    })
  }

  /** 放大后图片最多能挪多远：四周溢出的那一半。 */
  panLimit() {
    return ((ZOOM_BIG_SCALE - 1) * ZOOM_BOX_W) / 2
  }

  /** 挪到 (x, y)，**夹在边界内** —— 不夹的话能把图片拖到屏幕外、只剩空白。 */
  setPan(x, y) {
    const lim = this.panLimit()
    const nx = Math.max(-lim, Math.min(lim, x))
    const ny = Math.max(-lim, Math.min(lim, y))
    this.panPos = { x: nx, y: ny }
    this.panX.setValue(nx)
    this.panY.setValue(ny)
  }

  resetPan() {
    this.panPos = { x: 0, y: 0 }
    this.panStart = { x: 0, y: 0 }
    this.panX.setValue(0)
    this.panY.setValue(0)
  }

  onLoad() {
    this.syncPicks()
    this.load()
  }

  /**
   * 回到本页时重新读一次投票。
   *
   * 光在 onLoad 读不够：用户可能进详情投了票再回来，而两个页面各有各的
   * data —— 不重读的话首页还停在"没投过"，同一道题在两级页面上就是两个答案。
   */
  onShow() {
    this.syncPicks()
  }

  onUnload() {
    if (this.timer) clearInterval(this.timer)
    // 延迟关闭的定时器要一起清掉，否则它会在页面卸载后跑一次 setData
    if (this.tapTimer) clearTimeout(this.tapTimer)
  }

  /** 把本机记录的投票读进 data.picks（列表渲染要用）。 */
  syncPicks() {
    const picks = {}
    ;(this.data.feed || []).forEach((it) => {
      if (it.kind !== 'poll') return
      const i = poll.myPick(it.id)
      if (i >= 0) picks[it.id] = i
    })
    this.setData({ picks: picks })
  }

  /**
   * 在列表里直接投票 / 改票。
   *
   * 与详情页共用同一份本机存储，所以这里投完、点进详情看到的是同一票。
   */
  onVote(id, i) {
    // 1) 先记本机：用户点下去的那一刻"我选的"就出现，不等网络回来。
    //    结果态的百分比也是拿本机这一票 + 服务端的票数算的。
    poll.setPick(id, i)
    const picks = Object.assign({}, this.data.picks)
    picks[id] = i
    this.setData({ picks: picks })

    // 2) 再上报服务端 —— 票数统计只有它做得出来（票要记在人身上才有一人一票）。
    //    它回来的 counts/total 是**所有人的真实票数**，用手上这份覆盖本机算的。
    api
      .votePoll(id, i)
      .then((res) => {
        // 本机那种没有服务端存储的投票（内置示例、老文章的正文块）不上报，
        // 拿它的空票数去覆盖界面反而会把结果清掉。
        if (!res || res.skipped) return

        // 只更新这一条，不整份 feed 重建：整份换掉会让正在看的位置跳一下
        //（列表在滚动中重建，视口会回到顶部附近）。
        const feed = (this.data.feed || []).map((x) =>
          x.id === id ? Object.assign({}, x, { counts: res.counts, voted: res.total }) : x
        )
        this.setData({ feed: feed })
      })
      .catch((e) => {
        // ⚠️ 失败**不回滚**本机那一票。
        //
        // 用户的选择是真实的，只是没进服务端统计（未登录 / 断网）。
        // 回滚的话他会看到自己刚投的票"弹回去"，以为没投上，于是再投一次 ——
        // 而本机记的那一票本来就是对的。
        wx.showToast({ title: (e && e.msg) || '这一票暂时没计入统计', icon: 'none' })
      })
  }

  load() {
    return this.fetch(false)
  }

  /** 下拉刷新（挂在 ScrollView 的 refreshControl 上）。 */
  onRefresh() {
    return this.fetch(true)
  }

  /**
   * 首屏还没有任何内容 —— 正在画骨架。
   *
   * 判断里必须带 `!feed.length`：下拉刷新时也可能正处于"取数中"，
   * 而那时用户正看着一份内容，把它换成灰块等于"内容被清空了"。
   */
  firstLoad() {
    return !!this.data.loading && !(this.data.feed || []).length
  }

  /**
   * 取首页内容。
   *
   * @param byPull 是不是用户下拉触发的
   *
   * 两条路只有"失败时做什么"不一样：
   *   · 首屏失败：本来就没有内容可留，弹一句错误，把骨架收掉；
   *   · 下拉失败：**保住原来那份内容**，只弹一句错误。把用户已经看到的
   *     内容清空，是一次失败能造成的最坏结果 —— 而它偏偏发生在网络最差的时候。
   */
  fetch(byPull) {
    if (byPull) this.setData({ refreshing: true })

    return api
      // 刷新时**不退回内置内容**：失败就得真的失败（见 getCommunityFeed 的说明），
      // 否则断网下拉一次，运营发的文章会被几篇示例悄悄替换掉，还没有任何提示。
      .getCommunityFeed(byPull ? { fallback: false } : null)
      .then((res) => {
        const d = res.data || {}
        this.setData({
          loading: false,
          refreshing: false,
          topics: d.topics || [],
          promo: d.promo || null,
          checkin: d.checkin || null,
          spotlight: d.spotlight || [],
          feed: d.feed || []
        })
        // 内容到手之后再对一次投票：onLoad / onShow 跑在这之前，
        // 那时 data.feed 还是空的，读不到任何一道题
        this.syncPicks()
        this.startSpin()
      })
      .catch((err) => {
        // 失败也要把 loading 落下来：不落的话骨架会一直呼吸下去，
        // 而它其实已经失败了 —— 一屏永远"在加载"比一句错误更难理解
        this.setData({ loading: false, refreshing: false })
        util.onError(err)
      })
  }

  /**
   * 轮播自转。
   *
   * 只有多于一条时才转 —— 一条的时候转起来除了耗电什么也换不来。
   * 定时器必须存下来并在 onUnload 里清掉：不清的话离开页面后它还在跑，
   * 每次 setData 都会去打一个已经卸载的组件。
   */
  startSpin() {
    if (this.timer) clearInterval(this.timer)
    if ((this.data.spotlight || []).length < 2) return
    this.timer = setInterval(() => {
      const n = this.data.spotlight.length
      if (n < 2) return
      this.goSpot((this.data.spot + 1) % n, true)
    }, SPOTLIGHT_MS)
  }

  /**
   * 切到第 i 屏。
   *
   * ⚠️ 自转必须**连同滚动一起做**：轮播现在是一个 ScrollView，只改 spot 的话
   * 指令点会走、卡片却不动 —— 两者各说各话，比不做自转更让人困惑。
   */
  goSpot(i, animated) {
    this.setData({ spot: i })
    if (this.spotScroll) this.spotScroll.scrollTo({ x: i * SPOT_STEP, animated: !!animated })
  }

  /**
   * 手滑之后对齐指令点，并处理末尾那张哨兵。
   *
   * 用 SPOT_STEP 而不是 layoutMeasurement.width 换算页码：每页现在比可视宽度
   * 多一条缝，"可视宽度"已经不等于"一页"了，拿它除会算错页码。
   */
  onSpotScroll(e) {
    const n = (this.data.spotlight || []).length
    if (n < 2) return

    const page = Math.round(e.nativeEvent.contentOffset.x / SPOT_STEP)

    // 停在哨兵上：它长得就是第一张，无声跳回真身即可，用户看不到接缝。
    // animated: false 是关键 —— 带动画会从结尾"倒着飞回去"，一眼就穿帮。
    if (page >= n) {
      this.setData({ spot: 0 })
      if (this.spotScroll) this.spotScroll.scrollTo({ x: 0, animated: false })
      return
    }

    if (page >= 0 && page < n && page !== this.data.spot) this.setData({ spot: page })
  }

  /* ---------------- 交互 ---------------- */

  onSeg(e) {
    const v = Number(e.currentTarget.dataset.i)
    if (v !== this.data.seg) this.setData({ seg: v })
  }

  /** 点话题＝切换筛选（再点一次取消）。空列表页没用，就地筛才看得到东西。 */
  onTopic(e) {
    const t = e.currentTarget.dataset.topic
    const next = this.data.topic === t ? '' : t
    this.setData({ topic: next })
    if (next && this.scroll && this.feedY) {
      this.scroll.scrollTo({ y: Math.max(0, this.feedY - 70), animated: true })
    }
  }

  /**
   * 主推卡四格的落点。两种形态：
   *   url   —— 推一个页面（分红日历、高股息榜、更多工具）
   *   topic —— 就地筛选信息流（持仓晒单）
   *
   * 不做 switchTab 分支：四格现在没有一个是 tab，留着那条分支只会是
   * 一段永远走不到的代码。哪天真有格子指向 tab，再按需加回来。
   */
  onPromo(e) {
    const ds = e.currentTarget.dataset
    if (ds.url) {
      wx.navigateTo({ url: ds.url })
      return
    }
    if (ds.topic) this.onTopic(tap({ topic: ds.topic }))
  }

  onSearch() {
    wx.showToast({ title: '搜索开发中', icon: 'none' })
  }

  onCheckin() {
    wx.showToast({ title: '发帖开发中', icon: 'none' })
  }

  open(id) {
    wx.navigateTo({ url: '/pages/community-detail/community-detail?id=' + id })
  }

  /* ---------------- 渲染：顶部 ---------------- */

  /** ① 品牌标题行 */
  renderHead() {
    return (
      <View style={styles.head}>
        <Text style={styles.brand}>收息佬社区</Text>
        <Pressable style={styles.searchBtn} onPress={() => this.onSearch()} hitSlop={10}>
          <Text style={styles.searchIco}>🔍</Text>
        </Pressable>
      </View>
    )
  }

  /** ② 分段 + 右侧条数。条数由数据算，不写死 —— 写死的数字迟早和内容对不上。 */
  renderSeg() {
    const segs = ['推荐', '关注']
    return (
      <View style={styles.segRow}>
        <View style={styles.segWrap}>
          {segs.map((t, i) => (
            <Pressable
              key={t}
              style={[styles.seg, this.data.seg === i ? styles.segOn : null]}
              onPress={() => this.onSeg(tap({ i: i }))}
            >
              <Text style={[styles.segText, this.data.seg === i ? styles.segTextOn : null]}>
                {t}
              </Text>
            </Pressable>
          ))}
        </View>
        {/* 骨架期间不显示条数：那一刻它必然是 0，而"共 0 条新动态"
            和"还没数出来"是两件事 —— 前者会让人以为这里根本没内容。 */}
        {this.firstLoad() ? null : (
          <Text style={styles.segRight}>
            {'共 '}
            <Text style={styles.segRightNum}>{this.data.feed.length}</Text>
            {' 条新动态 ›'}
          </Text>
        )}
      </View>
    )
  }

  /** ③ 主推卡：一句主张 + 一行四格入口 */
  renderPromo() {
    const p = this.data.promo
    if (!p) return null

    return (
      <View style={styles.promo}>
        <Pressable onPress={() => this.onPromo(tap({ topic: '分红实录' }))}>
          <View style={s.between}>
            <Text style={styles.promoTitle}>{p.title}</Text>
            <Text style={styles.promoArrow}>→</Text>
          </View>
          <Text style={styles.promoSub}>{p.sub}</Text>
        </Pressable>

        <View style={styles.promoRow}>
          {(p.entries || []).map((e, i) => (
            <Pressable
              key={e.id || e.name}
              style={[styles.promoCell, i ? { marginLeft: 8 } : null]}
              onPress={() => this.onPromo(tap(e))}
            >
              <Text style={styles.promoEmoji}>{e.emoji}</Text>
              <Text style={styles.promoName} numberOfLines={1}>
                {e.name}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    )
  }

  /** ④ 打卡条 */
  renderCheckin() {
    const c = this.data.checkin
    if (!c) return null

    return (
      <Pressable style={[s.card, styles.checkin]} onPress={() => this.onCheckin()}>
        <View style={s.row}>
          <View style={styles.checkinAvatar}>
            <Text style={styles.checkinEmoji}>{c.emoji}</Text>
          </View>
          <View style={[s.flex1, { marginLeft: 10 }]}>
            <View style={s.between}>
              <Text style={[s.mid, s.bold, s.flex1]} numberOfLines={1}>
                {c.title}
              </Text>
              <Text style={[s.tiny, s.dim]}>{c.sub + ' ›'}</Text>
            </View>
            {c.hint ? (
              <Text style={[s.tiny, s.dim, { marginTop: 5 }]} numberOfLines={1}>
                {c.emoji + ' ' + c.hint}
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    )
  }

  /* ---------------- 渲染：信息流 ---------------- */

  renderTopics() {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.topicBar}
        contentContainerStyle={styles.topicRow}
      >
        {this.data.topics.map((t) => (
          <Pressable
            key={t}
            style={[styles.topic, this.data.topic === t ? styles.topicOn : null]}
            onPress={() => this.onTopic(tap({ topic: t }))}
          >
            <Text style={[styles.topicText, this.data.topic === t ? styles.topicTextOn : null]}>
              {'# ' + t}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    )
  }

  /**
   * ⑦ 轮播（本周精选）。
   *
   * ⚠️ 它必须是**能左右滑的**。原来只是一个 Pressable，只能靠定时器自己转：
   * 用户看到卡片底下有三个点、知道后面还有两条，上手一划却纹丝不动 ——
   * 那是"这里有内容但你够不着"，比一开始就不给轮播更让人别扭。
   *
   * 用 ScrollView + snapToInterval，而不是自己算位移翻页：翻页的物理、回弹、
   * 惯性全交给平台，代码里只剩"现在停在第几屏"这一个判断。
   * （不用 pagingEnabled：它按**可视宽度**翻页，而这里每页比可视宽度多一条缝。）
   *
   * 指令点放在 ScrollView **外面**：放里面它会跟着一起滚走。
   */
  renderSpotlight() {
    const list = this.data.spotlight || []
    if (!list.length) return null
    const i = this.data.spot % list.length

    // 末尾补一张"第一张"当哨兵：滑到最后一张还能继续往前滑，
    // 停在哨兵上时再无声跳回真正的第一张（见 onSpotScroll）。
    //
    // 只在**末尾**补、不在开头补：开头补一张会让首屏落在哨兵上，
    // 需要"先滚到位再显示"的补救 —— 而安卓的 ScrollView 不支持
    // contentOffset（它是 iOS 专有属性），那段补救会被用户看见。
    const pages = list.length > 1 ? list.concat([list[0]]) : list

    return (
      <View style={styles.spotWrap}>
        <ScrollView
          ref={(r) => {
            this.spotScroll = r
          }}
          horizontal
          showsHorizontalScrollIndicator={false}
          // 用 snapToInterval 而不是 pagingEnabled：后者按「可视宽度」翻页，
          // 而我们每页比可视宽度多出一条缝，用它每次都会少走一条缝、越翻越偏。
          snapToInterval={SPOT_STEP}
          decelerationRate="fast"
          disableIntervalMomentum
          onMomentumScrollEnd={(e) => this.onSpotScroll(e)}
        >
          {pages.map((cur, k) => (
            <View key={cur.id + '-' + k} style={styles.spotPage}>
              <Pressable style={[s.card, styles.spot]} onPress={() => this.open(cur.id)}>
                <View style={s.row}>
                  <View style={styles.spotBadge}>
                    <Text style={styles.spotEmoji}>{cur.emoji}</Text>
                  </View>
                  <Text style={styles.spotLabel}>{cur.label}</Text>
                </View>

                <Text style={styles.spotTitle}>{cur.title}</Text>
                <Text style={[s.tiny, s.dim, { marginTop: 6, lineHeight: 18 }]} numberOfLines={2}>
                  {cur.sub}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>

        {/*
          指令点：**绝对定位压在卡片内部的下缘**，且不跟着滚动。

          两个位置都试错过：放进 ScrollView 里，它会跟着卡片一起滚走
          （而且每张卡各带一份点）；放在 ScrollView 外面又不加绝对定位，
          它就掉到白卡外面去了 —— 用户的原话是"选中按钮在白色框外"。
          pointerEvents="none"：它只是指示，不该挡住卡片的点击。
        */}
        <View style={styles.dots} pointerEvents="none">
          {list.map((x, k) => (
            <View key={x.id} style={[styles.dot, k === i ? styles.dotOn : null]} />
          ))}
        </View>
      </View>
    )
  }

  /** 筛选条：只有筛选中才出现，且自带「清除」—— 否则用户会以为内容丢了。 */
  renderFilter() {
    if (!this.data.topic) return null
    return (
      <View style={styles.filterRow}>
        <Text style={[s.tiny, s.dim]}>{'筛选：'}</Text>
        <View style={styles.filterChip}>
          <Text style={styles.filterChipText}>{'# ' + this.data.topic}</Text>
        </View>
        <Pressable onPress={() => this.setData({ topic: '' })} hitSlop={8}>
          <Text style={[s.tiny, { color: colors.accent, marginLeft: 8 }]}>清除</Text>
        </Pressable>
      </View>
    )
  }

  visibleFeed() {
    const t = this.data.topic
    if (!t) return this.data.feed
    return (this.data.feed || []).filter((x) => x.topic === t)
  }

  /**
   * 卡片头：左边话题，右边表态 / 时间。
   *
   * ⚠️ 三样都空时**整个头都不渲染**，而不是"渲染一个空的头"。
   *
   * 这一处返工过：原来只判了话题（没有就不画「#」），但右边那行是
   * **无条件**渲染的 —— `{it.timeText || ''}` 内容为空串时，那个 Text
   * 照样占一行的高度。而后台发的投票既没有 topic、也没有 reactions，
   * `pollToFeedItem` 又不带 timeText，于是卡片顶上凭空多出一条缝。
   *
   * 教训是：判空要判**整行**，不要逐个元素判。逐个判的话，以后每加一个
   * 字段都得记得回来补一次，而漏掉的那次表现就是"莫名其妙多一块空白"——
   * 没有任何报错，只能靠眼睛发现。
   */
  renderItemHead(it) {
    const rs = it.reactions || []
    const time = it.timeText || ''

    // 三样都没有：这一行没有任何内容，连容器一起别要
    if (!it.topic && !rs.length && !time) return null

    return (
      <View style={styles.itemHead}>
        {/* 没有话题就不渲染这一段。独立投票没有话题（它不属于任何话题），
            照原样渲染会在卡片左上角留一个孤零零的「# 」。 */}
        {it.topic ? (
          <Text style={styles.topicTag} numberOfLines={1}>
            {'# ' + it.topic}
          </Text>
        ) : null}
        {/* 右边：有表态显示表态，否则显示时间。**两者都没有时这里也不渲染**
            —— 理由和上面那个整体判断一样，空 Text 是占高度的。 */}
        {rs.length || time ? (
          <View style={s.row}>
            {rs.length ? (
              rs.map((r, i) => (
                <View key={i} style={[styles.react, i ? { marginLeft: 5 } : null]}>
                  <Text style={styles.reactEmoji}>{r.emoji}</Text>
                  <Text style={styles.reactNum}>{r.n}</Text>
                </View>
              ))
            ) : (
              <Text style={[s.tiny, s.dim]}>{time}</Text>
            )}
          </View>
        ) : null}
      </View>
    )
  }

  /**
   * 配图占位块。没有真实素材，用 emoji + 浅色底表示（见 mock.js 的说明）。
   *
   * 三条规则：
   *
   *  1. **最多显示 4 张**。列表是给人扫的，一路排下去会把卡撑得很长，
   *     后面几条动态全被挤到屏幕外 —— 那些内容等于白写。超出的进详情看
   *     （详情页不截断）。
   *  2. 第 4 张右上角压一个 **+N**，而不是把第 4 张整个换成 "+N"：
   *     前者还看得见一张图，后者会让用户以为这条只有 3 张。
   *  3. 张数少时也**铺满一行**（thumb 用 flex:1）：1 张就是一整张、2 张各半、
   *     3 张各三分之一。固定尺寸会在右边空一截，看着像没排完。
   */
  renderThumbs(images) {
    const all = images || []
    if (!all.length) return null

    const list = all.slice(0, THUMB_MAX)
    const rest = all.length - list.length

    return (
      <View style={styles.thumbRow}>
        {list.map((im, i) => (
          <Pressable
            key={i}
            style={[styles.thumb, { backgroundColor: im.tint }, i ? styles.thumbGap : null]}
            // 点图＝放大看，点卡片其余地方才是进详情。
            // 列表里的图太小，看不出内容，给它一个"就地看大图"的出口 ——
            // 否则用户想看仔细只能先进详情，再放大一次，多两步。
            //
            // 传的是 `all`（整组）而不是这一张：放大之后要能左右滑动看完，
            // 而列表里最多只显示 4 张（其余收进 "+N"），只传可见的几张等于
            // 把剩下的图藏死了。
            onPress={() => this.openZoom(all, i)}
          >
            {/* 两种图共用这一个位置：
                  · url  —— 后台「首页文章」上传的真实配图
                  · emoji + tint —— 内置示例内容里的占位块（见 mock.js 的说明） */}
            {/* ⚠️ 这里**要** cover（矩形裁切），不是 contain。
                这里是列表里的缩略图：一排格子必须**大小一致、对齐整齐**，
                而 contain 会让每张按自己的比例缩在格子里 —— 横图上下留一大条白、
                竖图左右留白，一排看过去参差不齐，而且图本身变小了。
                裁掉的那部分没有丢：点开就是完整的一张（放大浮层用的 contain）。 */}
            {im.url ? (
              <Image source={{ uri: im.url }} style={styles.thumbImg} resizeMode="cover" />
            ) : (
              <Text style={styles.thumbEmoji}>{im.emoji}</Text>
            )}
            {rest > 0 && i === list.length - 1 ? (
              <View style={styles.thumbMore}>
                <Text style={styles.thumbMoreText}>{'+' + rest}</Text>
              </View>
            ) : null}
          </Pressable>
        ))}
      </View>
    )
  }

  /**
   * 卡片的回应数。
   *
   * 没有回应时**整行不显示**，而不是显示「共 0 条回应」：
   * 后台发的文章目前还没有评论功能，每张卡片底下都挂一句"0 条回应"
   * 会让首页看起来像坏了。帖子那批有真实的回应数，照常显示。
   */
  renderReply(n) {
    if (!n) return null
    return <Text style={styles.reply}>{'共 ' + n + ' 条回应'}</Text>
  }

  /* ---------------- 图片放大 ---------------- */

  /**
   * 放大一张图。
   *
   * 用全屏浮层，而不是"在原来的位置变大"：社区里的图是**占位块**
   * （emoji + 底色，见 mock.js 的说明），就地放大只等于把那一个 emoji 的
   * 字号调大，看着像排版出错；铺满一屏之后它才像"一张图被摊开"，
   * 将来换成真实图片也不用改结构。
   *
   * 与详情页 CommunityDetail 那套是同一个做法（连遮罩浓度、留边比例都一致），
   * 同一个动作在两级页面上应该看起来是同一件事。
   */
  openZoom(list, i) {
    const pics = list || []
    // 记下**整组图**和起点。只传被点的那一张的话，放大后就只能看到它一张，
    // 图集里其余的没有入口 —— 而列表里那个 "+N" 角标恰恰是在说"还有更多"。
    this.zoomScale.setValue(1)
    this.resetPan()
    // 记下打开的时刻，供 closeZoom 挡掉"同一次点击的余波"（见 ZOOM_OPEN_GUARD_MS）
    this.zoomOpenedAt = Date.now()
    this.setData({ zoom: { list: pics, i: i || 0 }, zoomAt: i || 0, zoomBig: false })
  }

  /**
   * 浮层里的一次点击。
   *
   * 两态的规则不一样，这是刻意区分的：
   *
   *   未放大：单击＝关闭（要等一个双击窗口，否则双击永远等不到第二下）；
   *           双击＝放大。
   *   放大后：单击＝**还原**（立即，不等窗口 —— 还原是无副作用的动作，
   *           等窗口只会让人觉得迟钝）。
   *
   * 之所以放大态下"点图片"不等于"关闭"：那个手势位置和"拖动看图"重叠，
   * 一个位置既要能拖又要能关，误触率太高。
   *
   * ⚠️ 放大态下**没有**"点图片外的空白关闭"这一说了：图片现在铺满整页
   *（见 zoomBox），手指落下的地方永远是图片那一层。所以关掉是
   *「点一下还原、再点一下关闭」—— 两步，但每一步都看得见结果，
   * 比原来那种"看图时点到边角就把浮层关掉"更不容易误触。
   */
  onZoomTap() {
    const now = Date.now()

    // 刚还原过：这一下是双击的第二下，吞掉。不吞的话它会立刻把浮层关掉
    // （还原后 zoomBig 已经是 false，走的是"单击关闭"那条分支）。
    if (this.suppressUntil && now < this.suppressUntil) return

    const gap = now - (this.lastTap || 0)
    this.lastTap = now

    if (!this.data.zoomBig) {
      if (gap < DOUBLE_TAP_MS) {
        // 第二下来了：撤销那次待关闭，改成放大
        if (this.tapTimer) {
          clearTimeout(this.tapTimer)
          this.tapTimer = null
        }
        this.lastTap = 0 // 连点三下不要又算成一次双击
        this.toggleZoomBig()
        return
      }
      if (this.tapTimer) clearTimeout(this.tapTimer)
      this.tapTimer = setTimeout(() => {
        this.tapTimer = null
        this.closeZoom()
      }, DOUBLE_TAP_MS)
      return
    }

    // 放大态：还原（关掉是"再点一下"，见上面那段）
    this.toggleZoomBig()
    this.suppressUntil = now + DOUBLE_TAP_MS
    this.lastTap = 0
  }

  /** 双击：放大 ⇄ 还原。 */
  toggleZoomBig() {
    const big = !this.data.zoomBig
    this.setData({ zoomBig: big })
    // 还原时把位移一起归零：留着位移的话，图会停在一个偏心的位置
    if (!big) this.resetPan()
    Animated.spring(this.zoomScale, {
      toValue: big ? ZOOM_BIG_SCALE : 1,
      useNativeDriver: true,
      friction: 7,
      tension: 60
    }).start()
  }

  // 点任意位置关闭：放大态的下一步动作只有"看完了"，
  // 不该再让用户去找一个叉号
  closeZoom() {
    // 刚打开就不理关闭请求：那一下多半是"打开这次点击"的余波（见 ZOOM_OPEN_GUARD_MS）
    if (this.zoomOpenedAt && Date.now() - this.zoomOpenedAt < ZOOM_OPEN_GUARD_MS) return

    // 复位放在关闭时也做一次：万一哪条路径没走 openZoom（比如连点），
    // 下一次进来就不会带着上一张的缩放和位移
    this.zoomScale.setValue(1)
    this.resetPan()
    this.setData({ zoom: null, zoomBig: false })
  }

  /** 用户动态：头像 + 昵称 + 日期 + 九宫格 */
  renderPost(it) {
    return (
      <Pressable key={it.id} style={[s.card, styles.item]} onPress={() => this.open(it.id)}>
        {this.renderItemHead(it)}

        <View style={styles.authorBlock}>
          <View style={[styles.avatar, { backgroundColor: it.author.tint }]}>
            <Text style={styles.avatarText}>{String(it.author.name).slice(0, 1)}</Text>
          </View>
          <Text style={styles.authorName}>{it.author.name}</Text>
        </View>

        {it.dateText ? <Text style={styles.dateBig}>{it.dateText}</Text> : null}
        {this.renderThumbs(it.images)}
        {this.renderReply(it.comments)}
      </Pressable>
    )
  }

  /**
   * 长文：标题 + 摘要 + **一排图**。
   *
   * 图只在这一处。原来是"上面一张大封面 + 下面一排正文图"：三张图占掉大半屏，
   * 而且两组图各自独立 —— 点封面滑不到正文图。可对用户来说那是同一篇里的图，
   * 没有理由分成两组。
   *
   * 现在只调一次 renderThumbs，顺序即"封面 → 正文插图"的顺序
   *（由 utils/api.js 的 articleToFeedItem 定好），点哪张就从那张开始左右滑，
   * 整篇的图能一路滑完。
   */
  renderArticle(it) {
    // 三种来源归成一个列表，渲染就只剩一条路径：
    //   · gallery —— 后台发的文章：封面 + 正文插图
    //   · images  —— 内置的帖子/示例内容（见 mock.js）
    //   · cover   —— 只有一张封面的内置长文
    // ⚠️ 顺序不能颠倒：有 gallery 就不该再拼 cover，否则封面会在那一排里出现两次
    //    （gallery 里第一张本来就是封面）。
    const pics = it.gallery && it.gallery.length
      ? it.gallery
      : it.images && it.images.length
        ? it.images
        : it.cover
          ? [it.cover]
          : []

    return (
      <Pressable key={it.id} style={[s.card, styles.item]} onPress={() => this.open(it.id)}>
        {this.renderItemHead(it)}
        <Text style={styles.title}>{it.title}</Text>
        {it.excerpt ? (
          <Text style={[s.small, styles.excerpt]} numberOfLines={3}>
            {it.excerpt}
          </Text>
        ) : null}
        {this.renderThumbs(pics)}

        {/* 正文里内嵌的投票（后台「添加内容 → 问卷」插的那道题）。
            放在图的**下面**，与它在文章正文里的位置大体一致。

            ⚠️ 点选项＝投票、点卡片其余地方才进详情 —— 与 renderPoll 同一套
            （嵌套的 Pressable），两个动作共处一张卡不打架。
            ⚠️ 它的 id 是「文章 id + 块下标」（api.js 里算好的），所以这里投的票，
            点进详情看到的就是同一票 —— 这也是必须由服务端带上 index 的原因。 */}
        {it.pollBlock
          ? this.renderPollBody(it.pollBlock, (i) => this.onVote(it.pollBlock.id, i))
          : null}

        {this.renderReply(it.comments)}
      </Pressable>
    )
  }

  /**
   * 投票：问题 + 选项 + 结果。
   *
   * **列表里就能投**。原先是只读的（"选项在列表里只读，点整张卡进详情"），
   * 可这道题在卡片里已经是完整可答的：只为投一票就得先跳一层，回来还不知道
   * 自己刚才停在哪儿。选项做成**嵌套的 Pressable** —— 点选项＝投票、
   * 点卡片其余地方才是进详情，两个动作共处一张卡也不打架。
   *
   * 投过之后才显示结果（百分比 + 条形），理由见详情页 renderPoll：
   * 投之前亮结果会带偏选择，而且"多数人选哪个"会变成一种从众暗示。
   */
  /*
   * 抽成"主体"是为了**两处共用**：
   *   · 整条内容就是投票的卡片（renderPoll，外面还套着那张卡）
   *   · 文章卡片里内嵌的那道题（renderArticle —— 后台在正文里插的 poll 块）
   * 各写一份的话，同一种东西在首页会慢慢长出两种长相。
   *
   * onPick 由调用方给，而不是这里直接用 q.id：两道题的 id 算法不同 ——
   * 整条内容是投票时记在**内容 id** 上，正文里那道题记在「内容 id + 块下标」上
   *（见 utils/poll.js 的 pollId）。这个差别只有调用方知道。
   */
  renderPollBody(q, onPick) {
    const picked = typeof this.data.picks[q.id] === 'number' ? this.data.picks[q.id] : -1
    const st = poll.stats(q, picked)

    return (
      <React.Fragment>
        <Text style={styles.pollQ}>{q.question}</Text>

        {/* 补充说明。卡片上**截断**成 3 行：它是给题目做注解的，不是正文 ——
            想读完整就点进详情（那儿的选项和票数本来也更全）。
            没有说明时整块不渲染，不留一个空行在那儿。 */}
        {q.description ? (
          <Text style={styles.pollDesc} numberOfLines={3}>
            {q.description}
          </Text>
        ) : null}

        {st.rows.map((r) => (
          <Pressable
            key={r.i}
            style={[styles.option, r.mine ? styles.optionOn : null]}
            onPress={() => onPick(r.i)}
          >
            {/* 条形铺在文字底下（绝对定位），它只表达比例，不抢文字的读数 */}
            {picked >= 0 ? (
              <View style={[styles.pollBar, { width: r.pct + '%' }, r.mine ? styles.pollBarOn : null]} />
            ) : null}

            <View style={styles.optionRow}>
              <Text
                style={[styles.optionText, r.mine ? styles.optionTextOn : null]}
                numberOfLines={2}
              >
                {r.text}
              </Text>
              {r.mine ? <Text style={styles.mineTag}>我选的</Text> : null}
              {picked >= 0 ? (
                <Text style={[styles.optionPct, r.i === st.top ? styles.optionPctTop : null]}>
                  {r.pct + '%'}
                </Text>
              ) : null}
            </View>
          </Pressable>
        ))}

        <Text style={styles.pollMeta}>
          {picked >= 0
            ? st.total + ' 人已选择 · 换一项再点一下就能改'
            : q.voted
              ? q.voted + ' 人已选择'
              // 正文里那道题没有"多少人投过"这个数据源（票是本机的），
              // 所以这里不能拼出一个数字来 —— 编一个数还不如不显示。
              : '投一票看看别人怎么选'}
        </Text>
      </React.Fragment>
    )
  }

  /**
   * 整条内容本身就是一道投票的卡片。
   *
   * 它的题 id 是**内容 id 本身**（pollId 不传块下标）—— 与详情页、
   * 与文章卡片上内嵌的同一道题必须是同一个键，否则两处各投各的。
   */
  renderPoll(it) {
    return (
      <Pressable key={it.id} style={[s.card, styles.item]} onPress={() => this.open(it.id)}>
        {this.renderItemHead(it)}
        {this.renderPollBody(it, (i) => this.onVote(it.id, i))}
        {this.renderReply(it.comments)}
      </Pressable>
    )
  }

  renderCard(it) {
    if (it.kind === 'poll') return this.renderPoll(it)
    if (it.kind === 'article') return this.renderArticle(it)
    return this.renderPost(it)
  }

  renderGroups() {
    const groups = groupByDate(this.visibleFeed())

    if (!groups.length) {
      return (
        <View style={styles.empty}>
          <Text style={s.mid}>{'这个话题下还没有内容'}</Text>
          <Pressable onPress={() => this.setData({ topic: '' })}>
            <Text style={[s.small, { color: colors.accent, marginTop: 10 }]}>看全部动态</Text>
          </Pressable>
        </View>
      )
    }

    return groups.map((g) => (
      <View key={g.date}>
        <Text style={styles.dateHead}>{g.label}</Text>
        {g.items.map((it) => this.renderCard(it))}
      </View>
    ))
  }

  /**
   * 首屏骨架。
   *
   * 形状照抄真实版式：主推卡 → 打卡条 → 话题条 → 精选卡 → 两张信息流卡片。
   * 内容到了是"填进去"，而不是"换一屏" —— 这是骨架屏唯一的价值所在，
   * 也是它和那句"加载中…"的全部区别。
   *
   * 品牌行与分段**不盖骨架**（见 render）：它们是写死的，没有"正在加载"这回事，
   * 盖上只会让整页变灰、连按钮都显得不能点。
   */
  renderSkeleton() {
    return (
      <skel.Pulse>
        {/* ③ 主推卡：一句主张 + 一行四格入口 */}
        <skel.Card>
          <skel.Block w="52%" h={16} />
          <skel.Block w="78%" h={12} style={{ marginTop: 10 }} />
          <View style={[s.row, { marginTop: 14 }]}>
            {[0, 1, 2, 3].map((i) => (
              <skel.Block key={i} w={58} h={46} r={12} style={i ? { marginLeft: 8 } : null} />
            ))}
          </View>
        </skel.Card>

        {/* ④ 打卡条：一个圆头像 + 两行字 */}
        <skel.Card style={{ marginTop: 12 }}>
          <View style={s.row}>
            <skel.Block w={38} h={38} r={19} />
            <View style={[s.flex1, { marginLeft: 10 }]}>
              <skel.Block w="46%" h={14} />
              <skel.Block w="72%" h={11} style={{ marginTop: 8 }} />
            </View>
          </View>
        </skel.Card>

        {/* ⑦ 话题条 + ⑧ 精选轮播卡 */}
        <View style={[s.row, { marginTop: 22 }]}>
          {[0, 1, 2].map((i) => (
            <skel.Block key={i} w={74} h={26} r={13} style={i ? { marginLeft: 8 } : null} />
          ))}
        </View>
        <skel.Card style={{ marginTop: 12 }}>
          <skel.Block w="100%" h={92} r={12} />
          <skel.Block w="62%" h={13} style={{ marginTop: 12 }} />
          <skel.Block w="40%" h={11} style={{ marginTop: 8 }} />
        </skel.Card>

        {/* 信息流卡片 ×2：卡片头 / 标题两行 / 摘要两行 / 一排图 */}
        {[0, 1].map((i) => (
          <skel.Card key={i} style={{ marginTop: 12 }}>
            <View style={s.between}>
              <skel.Block w={66} h={13} />
              <skel.Block w={52} h={13} />
            </View>
            <skel.Block w="92%" h={18} style={{ marginTop: 16 }} />
            <skel.Block w="58%" h={18} style={{ marginTop: 8 }} />
            <skel.Block w="100%" h={12} style={{ marginTop: 16 }} />
            <skel.Block w="86%" h={12} style={{ marginTop: 8 }} />
            <View style={[s.row, { marginTop: 14 }]}>
              {[0, 1, 2].map((k) => (
                <skel.Block key={k} w={88} h={88} r={10} style={k ? { marginLeft: 6 } : null} />
              ))}
            </View>
          </skel.Card>
        ))}
      </skel.Pulse>
    )
  }

  render() {
    /**
     * 首屏还没有内容 → 画骨架。**不再用那句全屏的"加载中…"**：
     * 它等于告诉用户"这里什么都没有"，而真实情况是"内容在路上"。
     *
     * 页面壳（品牌行、分段）照常渲染，所以从骨架到内容是"长出来"，
     * 而不是换一屏。
     */
    const firstLoad = this.firstLoad()

    return (
      <SafeAreaView style={s.page} edges={['top']}>
        <ScrollView
          ref={(r) => {
            this.scroll = r
          }}
          contentContainerStyle={s.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={this.data.refreshing}
              onRefresh={() => this.onRefresh()}
              // 圈的颜色跟品牌色走。不设的话安卓是默认的灰，
              // 在这个浅底上几乎看不见，用户会以为"下拉没反应"
              tintColor={colors.accent}
              colors={[colors.accent]}
              progressBackgroundColor={colors.card}
            />
          }
        >
          {this.renderHead()}
          {this.renderSeg()}

          {firstLoad ? (
            this.renderSkeleton()
          ) : (
            <React.Fragment>
              {this.renderPromo()}
              {this.renderCheckin()}

              <View
                onLayout={(e) => {
                  this.feedY = e.nativeEvent.layout.y
                }}
              >
                <Text style={styles.sectionTitle}>最新动态</Text>
                {this.renderTopics()}
                {this.renderSpotlight()}
                {this.renderFilter()}
                {this.renderGroups()}
              </View>
            </React.Fragment>
          )}
        </ScrollView>

        {/*
          图片放大：铺满一屏，**可左右滑动**看图集里的每一张，点任意处关闭。
          与详情页同一套做法（连留边比例、遮罩浓度都一致）。

          用 FlatList + initialScrollIndex（而不是 ScrollView + 手动 scrollTo）：
          从第 3 张点进去就得**直接落在第 3 张**上。ScrollView 在安卓上设初始
          位置要靠 onLayout 里补一次 scrollTo，那一下会被看见（闪一下第一张），
          而 contentOffset 是 iOS 专有属性。FlatList 配 getItemLayout 是原子的。
        */}
        <Modal
          visible={!!this.data.zoom}
          transparent
          animationType="fade"
          onRequestClose={() => this.closeZoom()}
        >
          <View style={styles.zoomMask}>
            {/*
              ⚠️ 关闭热区必须铺在**最底层**，不能把 Pressable 套在 FlatList 外面。

              套在外面时（原来的写法）安卓上**一滑就退出**：外层 Pressable 和
              内层 ScrollView 抢同一个手势，结果外层赢了 —— 手指刚动就判成"点了
              一下空白处"，浮层直接关掉，根本滑不动。

              现在的层次是「底层关闭热区 → FlatList → 每一页」：
                · 手指落在图上 → 先由 FlatList 拿到手势，滑动正常；
                · 点一下（没有位移）→ 每一页自己的 Pressable 接住，关闭；
                · 点图片四周的空白 → 同样是那一页接住（页是整屏大小）。
            */}
            <Pressable style={StyleSheet.absoluteFill} onPress={() => this.closeZoom()} />

            {this.data.zoom ? (
              <React.Fragment>
                <FlatList
                  style={styles.zoomList}
                  data={this.data.zoom.list}
                  horizontal
                  pagingEnabled
                  // 放大时**关掉翻页**：横向拖动要用来挪图片，不能又翻页又挪图。
                  // 与图片上那个 PanResponder 的分工就是靠这一条切的。
                  scrollEnabled={!this.data.zoomBig}
                  showsHorizontalScrollIndicator={false}
                  initialScrollIndex={this.data.zoom.i}
                  getItemLayout={(d, index) => ({ length: ZOOM_W, offset: ZOOM_W * index, index })}
                  keyExtractor={(it, i) => 'z' + i}
                  onMomentumScrollEnd={(e) => {
                    const at = Math.round(e.nativeEvent.contentOffset.x / ZOOM_W)
                    if (at !== this.data.zoomAt) this.setData({ zoomAt: at })
                  }}
                  renderItem={({ item }) => (
                    // 页 = 整屏大小，所以"点任意处关闭"依旧成立，但它是在
                    // ScrollView **内部**的 Pressable —— 位移一超阈值就被
                    // ScrollView 接管、press 自动取消，标准且可靠。
                    //
                    // 点进来之后：单击关闭、双击放大/还原（判定见 onZoomTap）。
                    // 缩放挂在 Animated.View 上而不是外层 Pressable 上：
                    // 点击区域保持整屏不变，放大后依然"点任意处"有效。
                    //
                    // ⚠️ 图片铺满整页之后，这一层 Pressable 只在**未放大**时接得到
                    // 点击：放大态下 Animated.View 会在按下的瞬间接管手势
                    //（见 pan 的 onStartShouldSetPanResponder），所以"想拖一下却把
                    // 浮层关了"不会发生。放大态据此改成"点一下还原、再点一下关闭"。
                    <Pressable style={styles.zoomPage} onPress={() => this.onZoomTap()}>
                      <Animated.View
                        {...this.pan.panHandlers}
                        style={[
                          styles.zoomBox,
                          {
                            // 底色只在占位块那一层给（见 zoomPh）：这一层是整页，
                            // 给它上色会把整屏都染成那个浅色。
                            //
                            // 顺序要紧：translate 写在 scale **前面**（外层），
                            // so 拖动距离就是屏幕上的实际距离。写在后面会被
                            // 缩放一起放大，手感是"越拖越快"。
                            transform: [
                              { translateX: this.panX },
                              { translateY: this.panY },
                              { scale: this.zoomScale }
                            ]
                          }
                        ]}
                      >
                        {item.url ? (
                          // `big` 是**原图**（见 utils/api.js 的 articleToFeedItem）：
                          // 卡片上那张是压过的 @min，铺满一屏再放大就糊了。
                          // 没有 big 的（内置占位块、老数据）就用 url ——
                          // 那几种情况下 url 本身就是原图。
                          //
                          // ⚠️ contain：放大就是要看**整张图**。用 cover 会把横图
                          // 裁掉左右两边，而用户根本不知道自己没看全。
                          <Image
                            source={{ uri: item.big || item.url }}
                            style={styles.zoomImg}
                            resizeMode="contain"
                          />
                        ) : (
                          <View style={[styles.zoomPh, { backgroundColor: item.tint }]}>
                            <Text style={styles.zoomEmoji}>{item.emoji}</Text>
                          </View>
                        )}
                      </Animated.View>
                    </Pressable>
                  )}
                />
                {/* 只有一张时不显示 "1 / 1"：那是噪音，不是信息 */}
                {this.data.zoom.list.length > 1 ? (
                  <Text style={styles.zoomCount} pointerEvents="none">
                    {this.data.zoomAt + 1 + ' / ' + this.data.zoom.list.length}
                  </Text>
                ) : null}
              </React.Fragment>
            ) : null}
          </View>
        </Modal>
      </SafeAreaView>
    )
  }
}

const styles = StyleSheet.create({
  /* ---------- 顶部 ---------- */
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    paddingBottom: 4
  },
  // 品牌大字：这一屏第一眼看到的东西，字重和字号都要压得住
  brand: { fontSize: 26, fontWeight: '700', color: colors.t1, letterSpacing: -0.4 },
  searchBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.9)'
  },
  searchIco: { fontSize: 16 },

  segRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14
  },
  segWrap: { flexDirection: 'row', alignItems: 'center' },
  seg: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    marginRight: 8
  },
  // 选中态：白底 + 极淡的强调色描边。比"填一块实色"轻，和浅色底更融
  segOn: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.accentA30
  },
  segText: { fontSize: 14, color: colors.t3 },
  segTextOn: { fontSize: 14, fontWeight: '600', color: colors.t1 },
  segRight: { fontSize: 12, color: colors.t3 },
  segRightNum: { fontSize: 13, fontWeight: '700', color: colors.accent },

  /* ---------- 主推卡 ---------- */
  promo: {
    marginTop: 14,
    padding: 16,
    borderRadius: 18,
    backgroundColor: '#FBF6EC'
  },
  promoTitle: { fontSize: 16, fontWeight: '700', color: '#8A5A1E', flexShrink: 1 },
  promoArrow: { fontSize: 16, color: '#C08A3E', marginLeft: 8 },
  promoSub: { marginTop: 5, fontSize: 12, color: '#B08A5A' },
  promoRow: { flexDirection: 'row', marginTop: 16 },
  promoCell: { flex: 1, alignItems: 'center' },
  promoEmoji: { fontSize: 19 },
  promoName: { marginTop: 5, fontSize: 11, color: '#8A5A1E' },

  /* ---------- 打卡条 ---------- */
  checkin: { marginTop: 12, paddingVertical: 13, paddingHorizontal: 14 },
  checkinAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft
  },
  checkinEmoji: { fontSize: 18 },

  /* ---------- 信息流头 ---------- */
  sectionTitle: { marginTop: 24, fontSize: 18, fontWeight: '700', color: colors.t1 },
  // 负边距让话题条能滑到屏幕边（内容容器有 16 的左右内边距）
  topicBar: { marginTop: 12, marginHorizontal: -16 },
  topicRow: { paddingHorizontal: 16 },
  topic: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    marginRight: 8,
    backgroundColor: 'rgba(255,255,255,0.9)'
  },
  topicOn: { backgroundColor: colors.accentSoft },
  topicText: { fontSize: 12.5, color: colors.t2 },
  topicTextOn: { color: colors.accent, fontWeight: '600' },

  /* ---------- 轮播 ---------- */
  // relative：让下面的指令点能绝对定位到**卡片内部**（见 dots）
  spotWrap: { marginTop: 14, position: 'relative' },
  // 每页 = 卡宽 + 一条缝。卡片在页内**左对齐**，这样翻页位移正好等于 SPOT_STEP
  spotPage: { width: SPOT_STEP },
  /**
   * 卡片。
   *
   * ⚠️ 三处不能省：
   *
   *   · `width: SPOT_W`。页容器是 SPOT_STEP（卡宽 + 缝），而 View 默认
   *     `alignItems: stretch` —— 不写宽度的话卡片会撑满整页，缝就没了，
   *     相邻两张照样贴在一起（这一版第一次就是这么写错的）。
   *     写了宽度之后卡片在页内左对齐，右侧自然空出一条缝。
   *
   *   · `elevation: 0` / `shadowOpacity: 0`。s.card 自带一层阴影
   *     （theme.js 的 shadowCard）—— 在信息流里它是"浮在页面上"的交代，
   *     但轮播卡不该有：它下面紧挨着「最新动态」的列表，那圈灰会在卡片
   *     下缘糊出一条深色带、四角尤其明显，看着像卡片脏了。
   *     去掉之后它只剩白底和圆角，与下面的列表拉平。
   *     （iOS 用 shadowOpacity，Android 用 elevation，两个都要写。）
   *
   *   · `paddingBottom: 30` 给指令点 —— 它压在卡片里、不占布局高度。
   *
   * margin 一概不碰：多一个外边距，snapToInterval 就会与卡片错位。
   */
  spot: { width: SPOT_W, paddingBottom: 30, elevation: 0, shadowOpacity: 0 },
  spotBadge: {
    width: 26,
    height: 26,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.line2
  },
  spotEmoji: { fontSize: 14 },
  spotLabel: { marginLeft: 8, fontSize: 12, color: colors.t3 },
  spotTitle: { marginTop: 10, fontSize: 16, fontWeight: '600', color: colors.t1, lineHeight: 24 },
  /**
   * 指令点：绝对定位，压在**卡片内部**的下缘，且不跟着滚动。
   *
   * left/width 按一张卡的宽度算 —— 翻到第 k 页时可视区里正好是第 k 张卡，
   * 所以这层不用动就能一直对齐在当前那张卡上。
   */
  dots: {
    position: 'absolute',
    left: 0,
    width: SPOT_W,
    bottom: 14,
    flexDirection: 'row',
    justifyContent: 'center'
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginRight: 5,
    backgroundColor: colors.line
  },
  dotOn: { backgroundColor: colors.accent, width: 14 },

  /* ---------- 筛选条 ---------- */
  filterRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  filterChip: {
    marginLeft: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.accentSoft
  },
  filterChipText: { fontSize: 12, color: colors.accent, fontWeight: '600' },

  /* ---------- 日期分组 ---------- */
  dateHead: { marginTop: 22, marginBottom: 10, fontSize: 17, fontWeight: '700', color: colors.t1 },
  empty: { alignItems: 'center', paddingVertical: 40 },

  /* ---------- 卡片 ---------- */
  item: { marginBottom: 12 },
  itemHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  topicTag: { flexShrink: 1, fontSize: 12.5, color: colors.accent },
  react: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.line2
  },
  reactEmoji: { fontSize: 12 },
  reactNum: { marginLeft: 3, fontSize: 11, color: colors.t3 },

  // 动态卡：头像与昵称居中 —— 社区里的"晒现状"类内容，居中比左对齐更像在展示
  authorBlock: { alignItems: 'center', marginTop: 14 },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 20, fontWeight: '600', color: '#5A6472' },
  authorName: { marginTop: 8, fontSize: 14, fontWeight: '600', color: colors.t1 },
  dateBig: { marginTop: 14, fontSize: 17, fontWeight: '600', color: colors.t1 },

  thumbRow: { flexDirection: 'row', marginTop: 12 },
  // flex:1 + aspectRatio：张数少时也铺满整行（1 张就是一整张、2 张各半）。
  // 固定宽度会在右边空一截，看着像没排完。
  // overflow: 'hidden' 是给后台传上来的真图准备的：Image 不认父级的
  // borderRadius，不裁的话它会顶成方角、从圆角框里凸出来
  //
  // 1:1 的方格 + cover：一排整整齐齐的方块，每张都填满、不露白。
  // ⚠️ 别改成"按图片比例"—— 那一排就再也对不齐了（见 thumbImg 那段注释）。
  thumb: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center'
  },
  thumbGap: { marginLeft: 6 },
  thumbImg: { width: '100%', height: '100%' },
  thumbEmoji: { fontSize: 24 },
  // 超出 4 张时压在第 4 张右下角的角标。做角标而不是"盖住整张"：
  // 盖住的话用户会以为这条只有 3 张，而角标既保留了那张图、又标出了还有多少。
  thumbMore: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(20, 28, 25, 0.62)'
  },
  thumbMoreText: { fontSize: 11, fontWeight: '600', color: '#FFFFFF' },

  title: { marginTop: 12, fontSize: 19, fontWeight: '700', color: colors.t1, lineHeight: 28 },
  excerpt: { marginTop: 10, color: colors.t3, lineHeight: 22 },

  pollQ: { marginTop: 12, fontSize: 16, fontWeight: '600', color: colors.t1, lineHeight: 25 },
  // 补充说明（题目下面那段解释）。比题目小一号、灰一档 ——
  // 它是注解，读起来不该和题目一样重（一样重就又成了"两行加粗的字"，
  // 而那正是把投票从文章里抽出来要解决的事）。
  pollDesc: { marginTop: 6, fontSize: 13, color: colors.t3, lineHeight: 20 },
  // 结果态下这里要放一条绝对定位的条形，所以：
  //   · 不写 alignItems:'center' —— 它会把子元素收成内容宽，条形就铺不开；
  //   · 加 overflow:'hidden' —— 圆角才切得住那条铺满整宽的条形。
  option: {
    marginTop: 9,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden'
  },
  // 选中态只描边、不填底：填了底，底下那条"我选的"条形就看不出来了
  optionOn: { borderColor: colors.accent },
  optionRow: { flexDirection: 'row', alignItems: 'center' },
  // 选项文字改为**左对齐**（原先是居中）。结果态右边要挂百分比，
  // 居中的文字配一个贴右的百分比会两头不靠。
  optionText: { flex: 1, fontSize: 14, color: colors.t1 },
  optionTextOn: { color: colors.accent, fontWeight: '600' },
  /**
   * 条形：绝对定位铺在文字底下，长度＝百分比。用最浅的那层色 ——
   * 它只表达比例，不是"完成度"，不该比文字更抢眼。
   *
   * ⚠️ 名字必须带 `poll` 前缀，**不能叫 `bar`**。StyleSheet 就是个对象，
   * 同名 key 后写的会静默覆盖先写的。本文件目前没有别的 `bar`，但
   * CommunityDetail.js 里有（顶部工具条），那边就是这么被覆盖掉的 ——
   * 详情页工具条因此整块塌掉。两边统一用 pollBar，别再埋一颗。
   */
  pollBar: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.line2 },
  pollBarOn: { backgroundColor: colors.accentSoft },
  mineTag: { marginLeft: 6, fontSize: 11, fontWeight: '600', color: colors.accent },
  // minWidth 让各行的百分比右边缘对齐，不然 7% 和 63% 会参差不齐
  optionPct: {
    marginLeft: 8,
    minWidth: 38,
    textAlign: 'right',
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.t2
  },
  /**
   * 票数最高那一项：**只把百分比染色**，绝不额外加一行。
   *
   * 曾经在这里挂过一行「最多人选」，问题出在它长在**容器流里**：
   *   · 那一项比同题其它选项高出一行，四个盒子高低不齐，像排版坏了；
   *   · 更糟的是**投前投后尺寸会变** —— 手刚点完、盒子就长高，
   *     整块内容往下推，观感上像是"点歪了"。
   *
   * 名次本来也不必用一行字讲：条形长度 + 百分比已经说清楚了。
   */
  optionPctTop: { color: colors.accent },
  pollMeta: { marginTop: 12, fontSize: 12, color: colors.t3 },

  reply: { marginTop: 14, fontSize: 12.5, color: colors.t3 },

  /* ---------- 图片放大 ---------- */
  // 压得很暗（0.72）：放大态的注意力只该在图上，背后的正文越看不出越好。
  // 这一组数值与详情页 CommunityDetail 完全一致 —— 同一个动作在两级页面上
  // 应该看起来是同一件事。
  zoomMask: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)'
  },
  // 承载整条图集。宽度必须写满：上面是 alignItems:'center'，
  // 不写的话 FlatList 会缩成内容宽，page 就翻不动了。
  zoomList: { flex: 1, width: '100%' },
  /**
   * 一页 = **整屏**（宽 ZOOM_W / 高 ZOOM_H），图在页内居中。
   *
   * 两个尺寸都是硬要求：
   *   · 宽必须**恰好等于**屏宽 —— pagingEnabled 按可视宽度翻页，差一点就越翻越偏；
   *   · 高取整屏 —— 这样"点任意处关闭"才真的覆盖任意处，
   *     否则图片上下会露出接不到点击的死区。
   */
  zoomPage: {
    width: ZOOM_W,
    height: ZOOM_H,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // "2 / 5"：滑到第几张、一共几张。铺满一行再居中，
  // 这样它的位置不随文字宽度变。
  // bottom 给得比"贴屏幕底"高一些：整屏页之后它正好会压在底部导航栏那一带，
  // 抬起来才不会和导航栏叠在一起。
  zoomCount: {
    position: 'absolute',
    bottom: 64,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF'
  },
  /**
   * 放大浮层里的那一层：**铺满整页**，不再是一个正方框。
   *
   * 原来这里是 86% 宽的**正方形**：横图缩在框里、上下各留一大条，四周还看得见
   * 框的圆角 —— 而放大这件事要的就是"把这张图铺开看"，框本身是多余的，
   * 而且它会把图压小。
   *
   * 铺满整页，配 Image 的 resizeMode="contain"：图按**自己的比例完整显示**，
   * 屏幕多大就显示多大，剩下的地方就是遮罩底色（每个看图器都是这个样子）。
   */
  zoomBox: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center'
  },
  // 内置示例内容的占位块（emoji + 底色）仍然放在一个正方框里 ——
  // 那种"图"本来就是一个色块加一个 emoji，铺满全屏只会像页面坏了。
  zoomPh: {
    width: ZOOM_BOX_W,
    aspectRatio: 1,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center'
  },
  zoomImg: { width: '100%', height: '100%' },
  zoomEmoji: { fontSize: 96 }
})

module.exports = Community
