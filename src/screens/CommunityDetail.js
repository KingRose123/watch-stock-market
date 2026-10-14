const React = require('react')
const {
  View,
  Text,
  Image,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  StyleSheet,
  Share,
  FlatList,
  Dimensions,
  Animated,
  PanResponder
} = require('react-native')
// 矢量图标（Feather 的路径数据）。为什么不用图标字体见 components/Icon.js
const Icon = require('../components/Icon.js')
// 按图片真实比例定高度的图：详情页的图要"完整且不留白"，两者的交点只有它
const FitImage = require('../components/FitImage.js')
const { SafeAreaView } = require('react-native-safe-area-context')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const { goTool } = require('../utils/toolRoutes.js')
const poll = require('../utils/poll.js')
const skel = require('../components/Skeleton.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

/**
 * 一次读出这一页上**所有**题的票。
 *
 * 在拿到内容之后、渲染之前调（见 load）：这一步必须和内容在同一次 setData
 * 里落地。分两次的话，先渲染出来的是"还没投过"的选项列表，下一帧才跳成
 * 结果态 —— 用户看到的是"刚才那一下没投上"。
 *
 * 只记投过的（poll.myPick 返回 -1 表示没投），没投的连键都不建 ——
 * 渲染那边缺键就是 -1。
 */
function readPicks(contentId, item) {
  const ids = []
  if (item && item.kind === 'poll') ids.push(poll.pollId(contentId))
  ;((item && item.body) || []).forEach((b, i) => {
    if (b.t === 'poll') ids.push(poll.pollId(contentId, i))
  })

  const out = {}
  ids.forEach((pid) => {
    const v = poll.myPick(pid)
    if (v >= 0) out[pid] = v
  })
  return out
}

// 放大态图集里"一页"的宽度 = 整个屏幕宽（不扣页面内边距）。
// 大图浮层是全屏的，页面的 16 内边距在这里不适用；而 pagingEnabled 按
// **可视宽度**翻页，所以它必须与屏宽严格相等，多一寸少一寸都会越翻越偏。
const ZOOM_W = Dimensions.get('window').width
// 图集里一页的高度取整屏：这样"点任意处关闭"才真的覆盖任意处。
const ZOOM_H = Dimensions.get('window').height

/**
 * 双击判定窗口（毫秒）。
 *
 * ⚠️ 它同时决定**单击关闭的延迟**：单击要等满这个窗口才能确定"没有第二下"，
 * 所以不能太大（大了点一下半天不关）、也不能太小（小了正常速度的双击会被
 * 拆成两次单击，等于把浮层关掉）。280 与系统双击间隔同量级。
 */
const DOUBLE_TAP_MS = 230

/**
 * 刚打开浮层时的「关闭豁免」窗口（毫秒）。
 *
 * ⚠️ 这是修一个"点了图片毫无反应"的 bug 的，别删。
 *
 * 打开浮层的动作本身就是一次点击，而这次点击的**抬手**会落到刚刚挂上来的
 * 浮层上（安卓上 Modal 是一个新窗口）—— 而浮层整页都是"点任意处关闭"的热区，
 * 于是它立刻被判成"点了空白处"，刚开就被关掉。
 *
 * 现象是：点一下图片，浮层闪一下就没了，看起来和"没反应"完全一样。
 * 排查时最直接的证据是打个日志看状态：会看到 zoom 从 0 立刻变回 -1。
 *
 * 350 比双击窗口（230）略长一点：盖住"同一次点击的余波"就够，
 * 再长会让"打开后马上点空白关闭"变迟钝。
 */
const ZOOM_OPEN_GUARD_MS = 350

// 双击放大到多少倍。2.4 能看清细节，又不至于一眼只看得到纹理。
const ZOOM_BIG_SCALE = 2.4

/**
 * 放大浮层里"一块图"的基准边长（px，86% 屏宽）。
 *
 * ⚠️ 它**不再**是图片容器的宽度了 —— 容器现在铺满整页（见 zoomBox），
 * 图片按自己的比例完整显示。这个常量还剩两个用处（与 Community.js 一致）：
 * 内置示例内容的占位块大小（zoomPh）、放大后能拖动多远的上限（panLimit）。
 */
const ZOOM_BOX_W = Math.round(Dimensions.get('window').width * 0.86)

/**
 * 社区二级页：一条内容的完整正文 + 回应。
 *
 * 顶部不用 App 那条自绘标题栏，而是参照内容社区常见的「✕ / ☆ / ↗」——
 * 底层是浏览行为（读完就关），而不是"从一个菜单点进来的子页"，
 * 一个叉号比一个返回箭头更贴近这个动作。
 *
 * 底部是常驻的写想法输入条。它不做成"滑到底才出现"：
 * 看完一段想回一句的冲动是即时的，等滑到底再给入口，那句话已经忘了。
 */

// 表态条。三个 emoji 的语义分别是「有启发 / 赞同 / 学到了」，
// 比一个笼统的"点赞"更贴近内容社区里的实际反馈。
const REACTIONS = [
  { key: 'idea', emoji: '💡', label: '有启发' },
  { key: 'agree', emoji: '👍', label: '赞同' },
  { key: 'learn', emoji: '🙌', label: '学到了' }
]

/**
 * 收藏的存储键与读写。
 *
 * 目前是**本机收藏**：后端还没有收藏接口，先把 id 存在 storage 里。
 * 用 id 数组而不是 {id: true} 的对象：它唯一的用途就是"这条在不在里面"，
 * indexOf 足够，也省掉维护一个永远为 true 的字段。
 *
 * ⚠️ 存本地意味着换设备不跟着走。等后端有了收藏接口，把这两个函数换成
 * api 调用即可 —— 页面那层不用动。
 */
const FAV_KEY = 'communityFavs'

function readFavs() {
  const v = wx.getStorageSync(FAV_KEY)
  return v instanceof Array ? v : []
}

function writeFavs(list) {
  wx.setStorageSync(FAV_KEY, list)
}

// 顶部三个图标的尺寸。21 是量出来的：比它大就显得抢正文的注意力，
// 比它小则和 36×36 的点击区不成比例、看着像没对齐。
const BAR_ICON = 21

/**
 * 跳转后"以跳转目标为准"的有效时长（毫秒）。
 *
 * jumpTo 会触发一次平滑滚动，那次滚动同样会走 onScroll。如果一滚就把
 * 跳转目标作废，"跳转完再打开目录"就又会去按滚动位置反推，于是又回到
 * 差一节的老问题（见 openToc）。这个时间窗把跳转自己那次滚动和用户之后
 * 的手动滚动区分开：滚动动画大约 300ms，给到 600ms 留足余量。
 */
const PIN_MS = 600

class CommunityDetail extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      // 取数失败（断网、后端挂了）。与 loading 分开存：
      // "还在加载"和"已经失败了"对用户是两件事，骨架一直转下去最让人费解。
      failed: false,
      item: null,
      comments: [],
      reacted: {}, // 本地表态状态（还没接后端，先只影响界面）
      // 我投的票：{ [题 id]: 选项下标 }。缺键＝这道题还没投。
      //
      // 用一个映射而不是一个数字（原来是 picked）：这一页会有**两处**出题 ——
      // 整条内容本身就是一道题（kind=poll），正文里还可能内嵌好几道
      //（poll 块）。题 id 的规则见 poll.pollId()。
      picks: {},
      zoomAt: 0, // 放大态里滑动后停在第几张（只用来显示 "2 / 5"）
      zoomBig: false, // 双击放大态（再双击回到原大小）
      faved: false, // 是否已收藏（进页面时从本地读）
      draft: '',
      // 正在放大的那张图的下标。-1 = 没在看图。
      // 用下标而不是图片对象：图是从 item 上取的，存一份副本就有了两个真相。
      // 下标是在**整篇图集**里的位置，见 render 里的 gallery。
      zoom: -1,
      // 章节目录面板开着没（右下角那颗悬浮按钮控制）
      tocOpen: false,
      // 当前读到第几节，用来在目录里高亮。默认 0：还没滚动，就在第一节
      tocActive: 0
    }

    // ── 小标题目录要用的布局测量，刻意**不进 data** ──
    // 它们只被 jumpTo / activeAt 读，不参与渲染。放进 data 的话，onLayout
    // 每回调一次就多一次整页重渲染（这页正文有几十个块，不划算）。
    this.toc = [] // [{ block: 块下标, text: 标题文字 }]
    this.headY = {} // 块下标 → 该标题相对**正文卡**的 y
    // 标题在正文卡里、正文卡又在滚动内容里，所以真实坐标是这两层相加。
    // ⚠️ 比 Article.js 少一层：那边的正文外面还包了一个 artBody 容器，
    // 而这里 renderBody 的返回值是直接摊在卡片里的。照着那边抄会多算一层。
    this.cardY = 0
    // 最近一次滚动位置。目录关着时 onScroll 不算高亮，但打开目录要靠它
    // 定位"现在在哪一节"，所以这个值得一直记
    this.scrollY = 0
    // 上一次跳转到的章节序号。打开目录时它优先于"按滚动位置反推"，
    // 理由见 openToc（跳转后正文里的图才撑开，位置会往下漂）
    this.tocPinned = null
    // 上面那个目标的有效期（见 PIN_MS）。过期的跳转目标是垃圾信息：
    // 用户后来自己滚到哪儿，哪儿才是"当前章节"
    this.pinUntil = 0

    // 双击放大的缩放值（1＝原大小）。用 Animated.Value 是为了平滑过渡，
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

  onUnload() {
    // 延迟关闭的定时器要清掉，否则它会在页面卸载后跑一次 setData
    if (this.tapTimer) clearTimeout(this.tapTimer)
  }

  onLoad(options) {
    this.id = (options && options.id) || 'c1'

    // 收藏状态要**先于**内容渲染出来：等接口回来再补的话，星标会先空一下
    // 再变成实心，看着像卡了一下。本地读是同步的，没有这个代价。
    //
    // ⚠️ 投票**不在这里**读，因为它得先知道这一页有几道题
    //（正文里可能内嵌好几个问卷块），而那要等内容回来 —— 见 load 里的 readPicks。
    // 它同样是"先于渲染"的：和 item 在同一次 setData 里落地。
    this.setData({ faved: readFavs().indexOf(this.id) > -1 })

    this.load()
  }

  /**
   * 取这一条内容。
   *
   * 两件事都要做对：
   *
   *   1. **接住失败**。getCommunityPost 拿不到时会抛错（见 api.js 的 fail），
   *      这里不接的话就是一个未处理的 rejection；
   *   2. **把 loading 落下来、进失败态**。只弹一句 toast 是不够的 ——
   *      骨架会一直转下去，用户看到的是"永远在加载"，而不是"加载失败"。
   *      这两个状态对用户是两件事（前者会让人一直等，后者会让他去检查网络）。
   */
  load() {
    this.setData({ loading: true, failed: false })

    return api
      .getCommunityPost(this.id)
      .then((res) => {
        // 兜一手"解析出来是空的"：正常路径拿不到都走抛错（fail），
        // 但真出现空结果时不该被当成一条内容渲染出去（那是一屏空白）
        if (!res || !res.data) {
          this.setData({ loading: false, failed: true })
          return
        }

        const item = res.data
        // 目录的数据源：正文里的小标题。解析一次存到实例上 —— render 每次
        // 都要用它，搁在 render 里算等于每渲染一次白算一遍几十个块。
        // headY 一并清空：内容换了，上次量的 y 全都作废
        this.toc = this.tocOf(item.body)
        this.headY = {}
        this.tocPinned = null
        // picks 与 item **同一次**落地，理由见 readPicks 的注释。
        this.setData({
          loading: false,
          item: item,
          comments: item.commentList || [],
          picks: readPicks(this.id, item)
        })
      })
      .catch((err) => {
        this.setData({ loading: false, failed: true })
        util.onError(err)
      })
  }

  /** 失败态上那个「重试」。 */
  onRetry() {
    this.load()
  }

  close() {
    wx.navigateBack()
  }

  /**
   * 收藏 / 取消收藏。
   *
   * 先写存储、再改界面。反过来的话，writeFavs 万一抛错，界面已经变成
   * "已收藏"而实际没存上 —— 下次进来又变回空心，这种前后不一致最难查。
   */
  onFavorite() {
    const id = this.id
    const list = readFavs()
    const on = list.indexOf(id) > -1
    const next = on ? list.filter((x) => x !== id) : list.concat([id])

    try {
      writeFavs(next)
    } catch (e) {
      wx.showToast({ title: '收藏失败，请重试', icon: 'none' })
      return
    }

    this.setData({ faved: !on })
    wx.showToast({ title: on ? '已取消收藏' : '已收藏', icon: 'none' })
  }

  /**
   * 分享：调起系统分享面板。
   *
   * 刻意**不拼 URL**。社区内容目前没有可访问的网页地址，硬编一个
   * https://… 的话对方点开是 404 —— 那比只分享一段文字更糟，
   * 毕竟用户是信任你才转出去的。等有了 H5 落地页再加进来。
   */
  onShare() {
    const it = this.data.item || {}
    const lines = [it.title || '#' + (it.topic || '收息佬社区')]
    if (it.excerpt) lines.push(it.excerpt)
    lines.push('—— 来自「收息佬」社区')

    Share.share({ message: lines.join('\n') })
      .then((r) => {
        // 用户在面板里点了取消，不该给"已分享"的反馈。
        // iOS 会回 dismissedAction；Android 恒为 sharedAction，
        // 这个判断在那边不生效，但留着无害。
        if (r && r.action === 'dismissedAction') return
        wx.showToast({ title: '已分享', icon: 'none' })
      })
      .catch(() => {
        // 没有可接收的应用等情况：给一句看得懂的提示，
        // 而不是把 rejection 丢进控制台没人管
        wx.showToast({ title: '分享失败，请重试', icon: 'none' })
      })
  }

  onReact(e) {
    const key = e.currentTarget.dataset.key
    const next = Object.assign({}, this.data.reacted)
    next[key] = !next[key]
    this.setData({ reacted: next })
  }

  /**
   * 投票 / 改票。
   *
   * 原先是"只允许选一次"，理由是"允许改来改去的话，结果统计就没意义了" ——
   * 这个理由站不住：一个人只占一票，与"能不能改"并不冲突，**覆盖**旧选择即可，
   * 总数始终是一票；真正被它挡住的是"点错了想改"这个正常需求。
   *
   * 所以现在每次点都覆盖，同步写本机存储 —— 首页那张同题卡片也要看到这一票。
   *
   * 参数是「哪一道题 + 选哪一项」：这一页会有两处出题（整条内容一道、
   * 正文里可能还有几道），见 poll.pollId()。
   */
  onPick(id, i) {
    // 先记本机：点下去的那一刻"我选的"就出现，不等网络（与首页那张卡一致）
    const picks = Object.assign({}, this.data.picks)
    picks[id] = i
    this.setData({ picks: picks })
    poll.setPick(id, i)

    // 再上报服务端，用**所有人的真实票数**覆盖本机算出来的那一份。
    // 独立投票的 id 是 p_xxx，另外两种（内置示例、老文章的正文块）没有
    // 服务端存储，api.votePoll 会自己跳过（见那边的说明）。
    api
      .votePoll(id, i)
      .then((res) => {
        if (!res || res.skipped) return
        const item = this.data.item
        if (!item || item.id !== id) return
        // 详情页上的百分比和「X 人已选择」都是从 item 上取的
        this.setData({
          item: Object.assign({}, item, { counts: res.counts, voted: res.total })
        })
      })
      .catch((e) => {
        // 不回滚本机那一票，理由见 Community.onVote
        wx.showToast({ title: (e && e.msg) || '这一票暂时没计入统计', icon: 'none' })
      })
  }

  onDraft(v) {
    this.setData({ draft: v })
  }

  onSend() {
    const t = String(this.data.draft || '').trim()
    if (!t) return
    this.setData({ draft: '' })
    wx.showToast({ title: '回应已提交', icon: 'none' })
  }

  /* ---------------- 渲染片段 ---------------- */

  /**
   * 顶上那组图（长文 ＝ 封面那张"脸"，帖子 ＝ 它自己的几张）。每张都能点开放大。
   *
   * ⚠️ 这里是**一列竖排、每张按自己的比例铺满整宽**，不是一排方格。
   *
   * 详情页是"看图"的地方：一排方格的代价是每张都被裁成同样的形状
   *（见 Community.js 的 renderThumbs —— 那里一排方格是对的，因为它是**缩略图**，
   * 点开才看全）。到了详情页还要裁，用户就没地方看完整的了。
   *
   * 也**不设固定高度**：框的比例一旦和图不一致，contain 就必然留白 ——
   * 图上下一圈白边比裁掉更显眼。高度交给 FitImage 按真实尺寸定。
   *
   * ⚠️ 首页那版刻意**不能**点（见 Community.js 的同名函数）：那里点整张卡就进详情，
   * 图再可点会和"进详情"抢同一个动作 —— 用户在图上点一下，本意是看图还是进详情？
   * 详情页里没有这个歧义，所以放大放在这里。
   */
  renderHeads(images) {
    const list = images || []
    if (!list.length) return null

    return (
      <View style={styles.headCol}>
        {list.map((im, i) => (
          <Pressable key={i} style={styles.headItem} onPress={() => this.openZoom(i)}>
            {/* 两种图要能在同一个位置渲染：
                  · url  —— 后台「首页文章」里上传的真实配图（有地址）
                  · emoji + tint —— 内置示例内容里的占位块（见 mock.js 的说明）
                占位块至今没删，因为帖子/投票那批内容还在内置数据里。 */}
            {im.url ? (
              <FitImage url={im.big || im.url} style={styles.headImg} />
            ) : (
              <View style={[styles.headPh, { backgroundColor: im.tint }]}>
                <Text style={styles.headEmoji}>{im.emoji}</Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>
    )
  }

  /* ---------------- 图片放大 ---------------- */

  /**
   * 放大一张图。
   *
   * 用全屏浮层，而不是"在原来的位置变大"：社区里的图是**占位块**
   * （emoji + 底色，见 mock.js 的说明），就地放大只等于把那一个 emoji 的
   * 字号调大，看着像排版出错；铺满一屏之后它才像"一张图被摊开"，
   * 将来换成真实图片也不用改结构。
   */
  /**
   * 打开放大浮层。下标 i 是**整篇图集**里的位置（见 render 里的 gallery）。
   *
   * 这一页只有一组图：封面在前、正文插图按出现顺序跟在后（gap 见 render）。
   * 早先分成"卡片级"和"正文"两组，理由是"封面和正文图没关系"——
   * 现在不成立了：它们是同一篇内容里的图，用户从封面往左滑就该滑到正文
   * 第一张。分成两组时点封面只能看封面，而没有任何提示说"还有别的图"。
   */
  openZoom(i) {
    // zoom ＝ 从第几张点进去（图集渲染要用它做初始位置），
    // zoomAt ＝ 滑动后停在第几张（只用来显示 "2 / 5"）。两个分开存：
    // 前者在放大期间不能变（变了 FlatList 会重设位置），后者每滑一次都变。
    // 每次进浮层都把缩放还原，否则上一次放大的倍数会带到下一张上。
    this.zoomScale.setValue(1)
    this.resetPan()
    // 记下打开的时刻，供 closeZoom 挡掉"同一次点击的余波"，见 ZOOM_OPEN_GUARD_MS
    this.zoomOpenedAt = Date.now()
    this.setData({ zoom: i, zoomAt: i, zoomBig: false })
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
   * ⚠️ 放大态下**没有**"点图片外的空白关闭"这一说了（与 Community.js 一致）：
   * 图片现在铺满整页（见 zoomBox），手指落下的地方永远是图片那一层。
   * 所以关掉是「点一下还原、再点一下关闭」—— 两步，但每一步都看得见结果。
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
    // 刚打开就不理关闭请求：那一下多半是"打开这次点击"的余波，
    // 不是用户在关浮层。见 ZOOM_OPEN_GUARD_MS 的注释。
    if (this.zoomOpenedAt && Date.now() - this.zoomOpenedAt < ZOOM_OPEN_GUARD_MS) return

    // 复位放在关闭时也做一次：万一哪条路径没走 openZoom（比如连点），
    // 下一次进来就不会带着上一张的缩放和位移
    this.zoomScale.setValue(1)
    this.resetPan()
    this.setData({ zoom: -1, zoomBig: false })
  }

  /**
   * 一道题：问题 + 选项 + 结果。**两处都用它**：
   *
   *   · 整条内容本身就是一道题（kind=poll，入口见下面的 renderPoll）
   *   · 正文里内嵌的问卷块（renderBody 里的 poll 分支）
   *
   * 共用一个函数而不是各画一份：它们在 App 上就是同一个东西，两份实现
   * 迟早会在"条形怎么画""百分比显不显示"这些细节上分叉 —— 而运营在后台
   * 看到的是同一种块，不该在 App 里长出两种长相。
   *
   * q 的形状：{ id, question, options, counts, voted }
   *
   * 分两态，**投过之后才显示结果**。投之前先把百分比亮出来有两个问题：
   * 会带偏选择，而且「最多人选」那一项会变成一种从众暗示 —— 这正是社区里
   * 最不想看到的效果（这道题本来就是道保险知识题，答对答错才有意义）。
   *
   * 结果态给两样东西：每项的**百分比**、一条长度等于百分比的**条形** ——
   * 条形最长的那个就是选择人数最多的。最高那项的百分比另外染成强调色，
   * 但**不加文字、也不加行**（理由见样式里 optionPctTop 那段）。
   */
  renderPollCard(q) {
    const picked = typeof this.data.picks[q.id] === 'number' ? this.data.picks[q.id] : -1
    const st = poll.stats(q, picked)

    return (
      // ⚠️ key 不能省：这个函数会在 renderBody 的 .map() 里被调用，
      // 而 .map() 返回的元素必须带 key（以前它只在一个固定位置渲染过）。
      <View key={q.id} style={styles.pollWrap}>
        <Text style={styles.pollQ}>{q.question}</Text>

        {/* 补充说明。详情页**完整显示**（卡片上只有 3 行）——
            换行会保留：它在后台是多行输入框，运营敲的回车就是分段。 */}
        {q.description ? <Text style={styles.pollDesc}>{q.description}</Text> : null}

        {st.rows.map((r) => (
          <Pressable
            key={r.i}
            style={[styles.option, r.mine ? styles.optionOn : null]}
            onPress={() => this.onPick(q.id, r.i)}
          >
            {/* 条形铺在文字底下（绝对定位），它只表达比例，不抢文字的读数 */}
            {picked >= 0 ? (
              <View style={[styles.pollBar, { width: r.pct + '%' }, r.mine ? styles.pollBarOn : null]} />
            ) : null}

            <View style={styles.optionRow}>
              <Text style={[styles.optionText, r.mine ? styles.optionTextOn : null]}>
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
              : '投一票看看别人怎么选'}
        </Text>
      </View>
    )
  }

  /**
   * 整条内容就是一道题（kind=poll）时的入口。
   *
   * 题 id 用**内容 id 本身**（pollId 不传块下标）：首页那张同题卡片用的
   * 也是内容 id —— 两边必须是同一个键，在首页投的那一票这里才看得见
   *（反过来也一样）。
   */
  renderPoll(it) {
    return this.renderPollCard({
      id: poll.pollId(this.id),
      question: it.question,
      // 补充说明：详情页完整显示（卡片上只截 3 行）
      description: it.description || '',
      options: it.options,
      counts: it.counts,
      voted: it.voted
    })
  }

  /* ---------------- 小标题目录 ---------------- */

  /** 从正文块里挑出所有小标题 —— 目录的数据源。 */
  tocOf(body) {
    const out = []
    ;(body || []).forEach((b, i) => {
      if (b.t === 'h') out.push({ block: i, text: b.v || '' })
    })
    return out
  }

  /**
   * 打开目录：顺手把高亮定位到"当前读到哪一节"。
   *
   * ⚠️ 有跳转目标就用它，而不是"按滚动位置反推"。
   *
   * 实测：从目录点了第 5 节、再打开目录，反推出来是第 4 节 —— 因为跳转
   * 发生时正文里的图还没撑开，坐标是按当时量的；等图加载完布局整体下移，
   * 标题的实际位置就比反推的更靠下。用户明明是从目录里点的第 5 节，
   * 再打开却指着第 4 节，看起来就是高亮坏了。
   *
   * 而用户**手动**滚过之后目标就作废了（在 onScroll 里按 PIN_MS 的时间窗
   * 清掉）—— 那时滚动位置才是真相。曾经试过"两者相差一节以内就用目标"
   * 这种容差写法，结果手动滚了一节以内高亮纹丝不动，比不做还糟。
   */
  openToc() {
    const k = this.tocPinned === null ? this.activeAt(this.scrollY) : this.tocPinned
    this.setData({ tocOpen: true, tocActive: k })
  }

  /**
   * 当前滚动位置落在第几节。
   *
   * 判据是「最后一个已经进入视口上沿附近的标题」。
   *
   * ⚠️ 那个 48 是实测定出来的，别想当然改小。跳转时标题会落在视口顶下方
   * 约 12dp 处（jumpTo 的留白），按理说余量只要大于 12 就该选中它，可实测
   * 跳到第 5 节后高亮停在第 4 节 —— 因为**正文里的图是懒加载的**：跳转
   * 发生时图还没撑开，量到的 y 偏小，等图加载完布局整体下移，标题的实际
   * 位置就比记录的更靠下。48 是给这个偏差留的余量。
   */
  activeAt(y) {
    let k = 0
    for (let i = 0; i < this.toc.length; i++) {
      const h = this.headY[this.toc[i].block]
      // 还没量到的就跳过。理论上不会发生（onLayout 在首次渲染后就回调了），
      // 但真漏了的话按 0 处理会让高亮直接掉回第一节，反而更糟
      if (h === undefined) continue
      if (this.cardY + h <= y + 48) k = i
      else break
    }
    return k
  }

  /**
   * 跳到第 k 节。
   *
   * 两个偏移相加才是 ScrollView 认得的那个坐标（见构造器里的说明）。少加
   * 一层不会报错，只是"跳得不太准" —— 最难查的那类问题。
   */
  jumpTo(k) {
    const t = this.toc[k]
    if (!t) return
    const h = this.headY[t.block]
    if (h === undefined) return

    // 记下目标：再打开目录时以它为准，而不是按滚动位置反推
    //（原因见 openToc，跳转后正文里的图才撑开、位置会漂）。
    // pinUntil 是给 onScroll 的时间窗 —— 下面这次滚动本身也会走 onScroll，
    // 不能让它把自己的目标顺手作废
    this.tocPinned = k
    this.pinUntil = Date.now() + PIN_MS

    // 先关面板再滚：两者同一帧发生，用户能直接看到"跳过去了"
    //（这也是不用 Modal 的原因，见 renderToc 的注释）
    this.setData({ tocOpen: false, tocActive: k })

    const y = this.cardY + h
    // -12 是留白：标题正好顶到屏幕上沿会显得很挤。
    // max 兜住 0，否则第一节会算出负数（ScrollView 自己也会夹回 0，
    // 但那一下的动画看着像抖了一下）
    if (this.scrollRef && this.scrollRef.scrollTo) {
      this.scrollRef.scrollTo({ y: Math.max(0, y - 12), animated: true })
    }
  }

  onScroll(e) {
    const y = (e && e.nativeEvent && e.nativeEvent.contentOffset.y) || 0
    this.scrollY = y
    // 用户自己滚了 → 跳转目标作废，滚动位置才是真相。
    // 时间窗内的滚动是 jumpTo 自己那次动画，不算（见 PIN_MS）
    if (this.tocPinned !== null && Date.now() > this.pinUntil) this.tocPinned = null
    // 目录没开就不算高亮：一次滑动能触发几十次回调，每次都遍历标题再 setData
    // 的话，长文会肉眼可见地掉帧（同 Archive.js 顶部收起那处的处理）
    if (!this.data.tocOpen) return
    const k = this.activeAt(y)
    if (k !== this.data.tocActive) this.setData({ tocActive: k })
  }

  /**
   * 目录：右下角一颗悬浮按钮 + 点开的章节面板。
   *
   * 为什么用页内浮层而不是 Modal：跳转要和**关掉面板**同时发生，用户才看得见
   * "跳过去了"。Modal 是独立窗口，它的关闭动画期间滚动结果被遮着，等面板
   * 消失时画面已经静止 —— 看起来就像"点了没反应，只是面板关了"。
   * 浮层和 ScrollView 在同一个视图树里，两件事同一帧。
   */
  renderToc() {
    const active = this.data.tocActive

    return (
      <React.Fragment>
        <Pressable style={[styles.tocBtn, s.float]} onPress={() => this.openToc()}>
          <Text style={styles.tocBtnIco}>≡</Text>
          <Text style={styles.tocBtnText}>目录</Text>
        </Pressable>

        {this.data.tocOpen ? (
          <View style={styles.tocMask}>
            {/* 点空白关闭。它排在面板**之前** —— 同一层里靠后的盖在上面，
                所以点面板本身不会穿透到这里。 */}
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => this.setData({ tocOpen: false })}
            />

            <View style={styles.tocPanel}>
              <View style={[s.between, styles.tocHead]}>
                <Text style={s.h3}>本文目录</Text>
                <Text style={s.tiny}>共 {this.toc.length} 节</Text>
              </View>

              {/* 章节多到一屏放不下时内部滚动（这一篇有八节，已经接近满屏） */}
              <ScrollView style={styles.tocList} nestedScrollEnabled>
                {this.toc.map((t, k) => (
                  <Pressable
                    key={t.block}
                    style={[styles.tocItem, k === active ? styles.tocItemOn : null]}
                    onPress={() => this.jumpTo(k)}
                  >
                    <Text style={[styles.tocNum, k === active ? styles.tocOn : null]}>{k + 1}</Text>
                    <Text
                      style={[styles.tocText, k === active ? styles.tocOn : null]}
                      numberOfLines={2}
                    >
                      {t.text}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </View>
        ) : null}
      </React.Fragment>
    )
  }

  /**
   * 正文块。
   *
   * 六种块与后台的编辑器一一对应（见 server-go/internal/store/article.go）：
   *   h    小标题（草稿里常自己带 ✅ / 📌 之类的符号）
   *   p    段落
   *   q    引用（金句）
   *   img  图片 —— 后台传上来的真图
   *   tool 工具卡 —— 落点由 tool.id 从 utils/toolRoutes.js 里查
   *   poll 问卷 —— 与"整条内容就是一道题"共用 renderPollCard
   *
   * ⚠️ 后两种是**正文里的功能块**，不是"另一种内容类型"：一篇文章可以
   * 插好几个，位置由运营自己定。
   *
   * ⚠️ 不认识的 t 一律按**段落**兜底。
   *
   * 因为块的类型是服务端下发的：后台加了一种新块，而老版本 App 还没升级时，
   * 它必然遇到自己不认识的 t。兜底成段落，用户读到的是"少了一点样式的一段话"；
   * 不兜底的话那段内容会整个消失，而用户完全不知道为什么 ——
   * 内容型产品的"内容凭空少了"是最不可接受的一类问题。
   */
  renderBody(body, imgIndex) {
    return (body || []).map((b, i) => {
      if (b.t === 'h') {
        // 记下这个标题的 y（相对正文卡）。目录跳转全靠它 ——
        // 量不到就只能猜，而文章长度不固定，猜不出来
        return (
          <Text
            key={i}
            style={styles.h}
            onLayout={(e) => {
              this.headY[i] = e.nativeEvent.layout.y
            }}
          >
            {b.v}
          </Text>
        )
      }
      if (b.t === 'q') {
        return (
          <Text key={i} style={styles.q}>
            {b.v}
          </Text>
        )
      }
      // ⚠️ 是 imgIndex[i]，不是 imgIndex —— 传整个映射表进来的话，
      // 放大浮层拿到的下标是个对象，zoom >= 0 恒为 false，表现是
      // "点了完全没反应、控制台也不报错"（这个坑真踩过一次）。
      if (b.t === 'img') return this.renderBodyImage(b, i, imgIndex ? imgIndex[i] : undefined)
      if (b.t === 'tool') return this.renderToolCard(b, i)
      if (b.t === 'poll') {
        // 正文里内嵌的问卷。题 id **带块下标**（见 pollId）——
        // 一篇里可以有好几道，而且要能和整条内容那道题（用内容 id）区分开。
        //
        // voted 给 0：正文里的问卷没有"多少人投过"这个数据源（票是本机的，
        // 见 utils/poll.js），所以文案走"投一票看看别人怎么选"那条分支。
        return this.renderPollCard({
          id: poll.pollId(this.id, i),
          question: b.question,
          options: b.options,
          counts: b.counts,
          voted: 0
        })
      }
      return (
        <Text key={i} style={styles.p}>
          {b.v}
        </Text>
      )
    })
  }

  /**
   * 正文里的插图。
   *
   * 高度**跟着图片自己的比例走**（用 FitImage），不是固定高度。
   *
   * 这一处返工过，记下为什么：原先写的是固定高度 + resizeMode="contain"，
   * 理由是"服务端不知道图的真实尺寸，用 aspectRatio 会让卡片先撑开再塌回去"。
   * 那个理由只解释了**为什么不能凭空猜比例**，并没有解决
   * "框的比例 ≠ 图的比例就必然留白"—— 表现就是高宽比大的图上下顶一圈白边，
   * 比裁掉更显眼。现在尺寸从 onLoad 里量出来，两个问题一起没了。
   *
   * **可以点开放大**（picIdx 是这张图在**整篇图集**里的位置，封面是第 0 张）。
   * 插图虽然与卡片同宽，但在手机上那也只有三百多像素 —— 行情图上的坐标轴、
   * 产品图上的小字根本看不清，而运营把图放进正文，本意就是要让人看清。
   * 点开后在整篇的图之间左右滑，往回能滑到封面（见 render 里的 gallery）。
   *
   * 图注**居中**：它是这张图的附属说明。左对齐会让人把它读成与图无关的正文一行。
   */
  renderBodyImage(b, i, picIdx) {
    if (!b.url) return null
    return (
      <View key={i} style={styles.bodyImgWrap}>
        {/* picIdx 由 render 里那张「正文块下标 → 图集下标」的映射给出；
            万一没映射上（理论上不会），zoomList[undefined] 取不到图，
            浮层不会打开 —— 静默不响应，不会崩。 */}
        <Pressable onPress={() => this.openZoom(picIdx)}>
          <FitImage url={b.url} style={styles.bodyImg} />
        </Pressable>
        {b.caption ? <Text style={styles.bodyImgCap}>{b.caption}</Text> : null}
      </View>
    )
  }

  /** 正文里的工具卡。*/
  renderToolCard(b, i) {
    return (
      <Pressable key={i} style={styles.toolCard} onPress={() => goTool(b.id)}>
        <View style={[styles.toolIco, { backgroundColor: colors.line2 }]}>
          <Text style={styles.toolEmoji}>{b.emoji}</Text>
        </View>
        <View style={[s.flex1, { marginLeft: 10 }]}>
          <Text style={[s.small, s.bold]}>{b.title}</Text>
          <Text style={[s.tiny, s.dim, { marginTop: 3 }]}>
            {b.desc || '点此打开'}
          </Text>
        </View>
        <Text style={s.dim}>›</Text>
      </Pressable>
    )
  }

  /**
   * 首屏骨架。
   *
   * 正文照抄真实版式：# 话题行 → 标题两行 → 作者行 → 头图 → 几段正文。
   * 形状对上了，内容到了才不跳版（这是骨架屏唯一的价值，见 components/Skeleton.js）。
   */
  renderSkeleton() {
    return (
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <skel.Pulse>
          <skel.Card style={styles.doc}>
            <View style={s.between}>
              <skel.Block w={74} h={13} />
              <skel.Block w={46} h={13} />
            </View>
            <skel.Block w="90%" h={22} style={{ marginTop: 16 }} />
            <skel.Block w="55%" h={22} style={{ marginTop: 8 }} />
            <skel.Block w="72%" h={12} style={{ marginTop: 16 }} />
            {/* 头图。灰块给 150 高：真实高度是按图自己的比例算出来的
                （见 renderBodyImage 的说明），骨架量不到，给个接近常见横图的值
                就行 —— 骨架只负责"把版式先占住" */}
            <skel.Block w="100%" h={150} r={12} style={{ marginTop: 14 }} />
            {[0, 1, 2, 3, 4].map((i) => (
              <skel.Block key={i} w={i % 2 ? '84%' : '100%'} h={12} style={{ marginTop: 14 }} />
            ))}
          </skel.Card>
        </skel.Pulse>
      </ScrollView>
    )
  }

  render() {
    // 加载中与**加载失败**都只画顶部那个 ✕（这一页没有标题栏，它是唯一出口），
    // 区别是下面画什么：灰块骨架，还是一句实话 + 一个重试。
    if (this.data.loading || this.data.failed) {
      return (
        <SafeAreaView style={s.page} edges={['top', 'bottom']}>
          {/*
            骨架期间**只留一个 ✕**。

            这一页没有标题栏（见 App.js 的 BARLESS），✕ 是唯一的出口 ——
            少了它，用户点进一篇还没加载出来的内容就退不出去了。

            收藏 / 分享这时候不给：内容还没到，点了要么没反应、
            要么收藏一个空壳，不如先不出现。
          */}
          <View style={styles.bar}>
            <Pressable onPress={() => this.close()} hitSlop={12} style={styles.barBtn}>
              <Icon name="close" size={BAR_ICON} color={colors.t1} />
            </Pressable>
          </View>

          {this.data.failed ? (
            <View style={styles.empty}>
              <Text style={s.mid}>{'内容没能加载出来'}</Text>
              <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>
                {'检查一下网络，或者稍后再试'}
              </Text>
              <Pressable onPress={() => this.onRetry()} style={styles.retryBtn}>
                <Text style={styles.retryText}>{'重试'}</Text>
              </Pressable>
            </View>
          ) : (
            this.renderSkeleton()
          )}
        </SafeAreaView>
      )
    }

    const it = this.data.item || {}
    const author = it.author || {}
    const reacted = this.data.reacted

    // 顶上铺的那几张（这一排就是"这篇的脸"）：
    //   · 动态（post）用它自己的 images
    //   · 长文（article）用它的封面
    // 归成一个列表，下面那排图就只剩一条路径，不用到处写 `it.images || [it.cover]`。
    const headPics = it.images && it.images.length ? it.images : it.cover ? [it.cover] : []

    // 放大浮层里左右滑的那一组 = **整篇的图**：头图在前，正文插图按出现顺序
    // 跟在后面。
    //
    // 为什么不直接拿 headPics 放大：长文的正文插图只在正文里画，头图只有封面 ——
    // 于是点封面只能看封面，往左一滑什么都没有。可它们是同一篇里的图，
    // 用户想看的是"这篇的图"整个一遍。
    //
    // 也不能只把正文图并进来：那样滑到某张时并不知道它在正文里的位置，
    // 而 picOfBlock 正是干这个的 —— 正文里点某张图，浮层就停在第几张。
    //
    // ⚠️ 下标映射用「正文块下标 → 图集下标」，而不是在渲染时数计数器：
    // 正文里混进一个没选图的 img 块（正常流程存不下来，但不值得赌）也不会错位。
    const gallery = headPics.slice()
    const picOfBlock = {}
    const seenAt = {}
    headPics.forEach((im, i) => {
      if (im && im.url) seenAt[im.url] = i
    })
    ;(it.body || []).forEach((b, i) => {
      if (b.t !== 'img' || !b.url) return
      // 与头图重复的（把正文第一张同时设为封面是常见做法）不再放一份：
      // 不去重的话图集里会有两张一样的，滑过去看着像卡住了。
      if (seenAt[b.url] === undefined) {
        seenAt[b.url] = gallery.length
        gallery.push({ url: b.url })
      }
      picOfBlock[i] = seenAt[b.url]
    })

    const zoomList = gallery
    const zoomPic = this.data.zoom >= 0 ? zoomList[this.data.zoom] : null

    return (
      <SafeAreaView style={s.page} edges={['top', 'bottom']}>
        {/* 顶部工具条 */}
        <View style={styles.bar}>
          <Pressable onPress={() => this.close()} hitSlop={12} style={styles.barBtn}>
            <Icon name="close" size={BAR_ICON} color={colors.t1} />
          </Pressable>
          <View style={s.row}>
            <Pressable onPress={() => this.onFavorite()} hitSlop={12} style={styles.barBtn}>
              {/* 实心/空心是同一条路径只切 fill，所以选中前后轮廓完全重合，
                  不会出现"点亮后忽然胖一圈" */}
              <Icon
                name="star"
                size={BAR_ICON}
                filled={this.data.faved}
                color={this.data.faved ? colors.accent : colors.t1}
              />
            </Pressable>
            <Pressable onPress={() => this.onShare()} hitSlop={12} style={styles.barBtn}>
              <Icon name="share" size={BAR_ICON} color={colors.t1} />
            </Pressable>
          </View>
        </View>

        <ScrollView
          ref={(r) => (this.scrollRef = r)}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          // ⚠️ 必须用箭头包一层，**不能**写 onScroll={this.onScroll}。
          // ScrollView 内部是按 `this.props.onScroll(e)` 调的，于是函数体里的
          // this 指向 **props** 而非页面实例，`this.data` 就成了 undefined ——
          // 一滚动整个 App 直接崩掉退回桌面（实报 "Cannot read property
          // 'tocOpen' of undefined"，而且不弹任何提示）。
          onScroll={(e) => this.onScroll(e)}
          // 64ms 一次（约 15 帧）。目录高亮不需要逐帧精度，
          // 而回调越密、一次滑动触发的重渲染次数越多
          scrollEventThrottle={64}
        >
          {/* 正文卡 */}
          <View
            style={[s.card, styles.doc]}
            onLayout={(e) => {
              this.cardY = e.nativeEvent.layout.y
            }}
          >
            <View style={s.between}>
              {/* ⚠️ 没有话题就**整行不渲染**，别留空位。
                  原来写的是 {'# ' + (it.topic || '')} —— 话题为空时屏幕上就是
                  一个孤零零的「#」，而且它自占一行的高度，看着像排版坏了。
                  后台不填话题的内容（内置的独立投票就是这类）都会这样。

                  ⚠️ 也别改成"保留一个空 Text"占位：那照样占行高，问题没解决。 */}
              {it.topic ? (
                <Text style={styles.docTopic} numberOfLines={1}>
                  {'# ' + it.topic}
                </Text>
              ) : null}
              {/* 时间同样**没有**时不渲染这个 Text —— 空 Text 照样占一行高度。
                  和 Community.renderItemHead 是同一个坑，那里一并修了。 */}
              {it.timeText || it.dateText ? (
                <Text style={[s.tiny, s.dim, { marginLeft: 'auto' }]}>
                  {it.timeText || it.dateText}
                </Text>
              ) : null}
            </View>

            {it.title ? <Text style={styles.docTitle}>{it.title}</Text> : null}

            {author.name ? (
              <Text style={styles.docAuthor}>
                <Text style={styles.docAuthorName}>{'@' + author.name}</Text>
                {it.excerpt ? '：' + it.excerpt : ' 参与了讨论'}
              </Text>
            ) : null}

            {this.renderHeads(headPics)}
            {it.kind === 'poll' ? this.renderPoll(it) : null}
            {this.renderBody(it.body, picOfBlock)}

            {/* 内嵌工具卡：长文里挂一个"读完就能动手"的入口，是内容社区
                把阅读转成留存的标准做法 —— 光读完，用户下一步是关掉 App。
                落点由 tool.id 从 utils/toolRoutes.js 里查（数据带 id，路由集中一处）。 */}
            {it.tool ? (
              <Pressable style={styles.toolCard} onPress={() => goTool(it.tool.id)}>
                <View style={[styles.toolIco, { backgroundColor: colors.line2 }]}>
                  <Text style={styles.toolEmoji}>{it.tool.emoji}</Text>
                </View>
                <View style={[s.flex1, { marginLeft: 10 }]}>
                  <Text style={[s.small, s.bold]}>{it.tool.name}</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 3 }]}>{it.tool.desc}</Text>
                </View>
                <Text style={s.dim}>›</Text>
              </Pressable>
            ) : null}
          </View>

          {/* 表态条 */}
          <View style={styles.reactRow}>
            {REACTIONS.map((r) => {
              const on = !!reacted[r.key]
              return (
                <Pressable
                  key={r.key}
                  style={[styles.reactBtn, on ? styles.reactBtnOn : null]}
                  onPress={() => this.onReact(tap({ key: r.key }))}
                >
                  <Text style={styles.reactEmoji}>{r.emoji}</Text>
                  <Text style={[styles.reactLabel, on ? styles.reactLabelOn : null]}>
                    {r.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          {/* 回应 */}
          <Text style={styles.sectionTitle}>
            {this.data.comments.length
              ? this.data.comments.length + ' 条回应'
              : '还没有回应'}
          </Text>

          {(this.data.comments || []).map((c) => (
            <View key={c.key} style={[s.card, styles.cmt]}>
              <View style={s.row}>
                <View style={[styles.cmtAvatar, { backgroundColor: c.tint }]}>
                  <Text style={styles.cmtAvatarText}>{String(c.name).slice(0, 1)}</Text>
                </View>
                <View style={[s.flex1, { marginLeft: 8 }]}>
                  <View style={s.between}>
                    <Text style={[s.small, s.bold]}>{c.name}</Text>
                    <Text style={[s.tiny, s.dim]}>{c.timeText}</Text>
                  </View>
                </View>
              </View>
              <Text style={styles.cmtText}>{c.text}</Text>
              <Text style={[s.tiny, s.dim]}>{'👍 ' + c.likes}</Text>
            </View>
          ))}
        </ScrollView>

        {/* 底部写想法。常驻不给收起 —— 收起再展开要多一步，
            而"看完想回一句"的窗口很短。 */}
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={this.data.draft}
            onChangeText={(v) => this.onDraft(v)}
            placeholder="写下自己的想法…"
            placeholderTextColor={colors.t3}
            returnKeyType="send"
            onSubmitEditing={() => this.onSend()}
          />
          <Pressable
            style={[styles.send, this.data.draft.trim() ? null : styles.sendOff]}
            onPress={() => this.onSend()}
          >
            <Text style={styles.sendText}>发送</Text>
          </Pressable>
        </View>
        <Text style={styles.disclaim}>心得分享，不构成投资建议</Text>

        {/* 目录（悬浮按钮 + 章节面板）。只在真有章节时出现 ——
            没有小标题的内容，这颗按钮点开只会是个空面板 */}
        {this.toc.length >= 2 ? this.renderToc() : null}

        {/*
          图片放大：铺满一屏，**可左右滑动**看图集里的每一张，点任意处关闭。

          zoomList 已经在这页开头归好（整篇的图：头图 + 正文插图，一条路径），
          所以这里直接拿它当数据源 —— 图文两类内容在这个浮层里行为完全一致，
          而且从封面能一直滑到正文最后一张。

          用 FlatList + initialScrollIndex，而不是 ScrollView + onLayout 补 scrollTo：
          从第 3 张点进去就要**直接落在第 3 张**上，补滚那一下会被看见（闪一下第一张）。
        */}
        <Modal
          visible={!!zoomPic}
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

            {zoomPic ? (
              <React.Fragment>
                <FlatList
                  style={styles.zoomList}
                  data={zoomList}
                  horizontal
                  pagingEnabled
                  // 放大时**关掉翻页**：横向拖动要用来挪图片，不能又翻页又挪图。
                  // 与图片上那个 PanResponder 的分工就是靠这一条切的。
                  scrollEnabled={!this.data.zoomBig}
                  showsHorizontalScrollIndicator={false}
                  initialScrollIndex={this.data.zoom}
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
                            // 底色只在占位块那一层给（见 zoomPh）：这一层已经是整页，
                            // 给它上色会把整屏都染成那个浅色。
                            //
                            // 顺序要紧：translate 写在 scale **前面**（外层），
                            // 拖动距离才是屏幕上的实际距离。写在后面会被缩放
                            // 一起放大，手感变成"越拖越快"。
                            transform: [
                              { translateX: this.panX },
                              { translateY: this.panY },
                              { scale: this.zoomScale }
                            ]
                          }
                        ]}
                      >
                        {item.url ? (
                          // 撑满整页（zoomBox 已改成铺满，不再是那个正方框）。
                          // 双击放大/拖动整套手势是挂在外面这层 Animated.View 上的，
                          // 所以图片本身不必也不能再挂手势 —— 两层都要处理同一组
                          // 触摸事件时，安卓上会出现"拖到一半图片弹回去"。
                          //
                          // `big` 是原图，用来替掉首页卡片上那张压过的 @min
                          //（见 utils/api.js 的 articleToFeedItem）。
                          // 这一页的正文插图与头图本来就是原图，所以它们没有
                          // big —— 直接用 url，不会再多下一次图。
                          //
                          // ⚠️ contain：放大就是要看**整张图**，按自己的比例铺到
                          // 屏幕能容下的最大；cover 会把横图裁掉两边（看不全），
                          // 而固定成正方形（原来的写法）会把横图压小、四周还露框。
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
                {zoomList.length > 1 ? (
                  <Text style={styles.zoomCount} pointerEvents="none">
                    {this.data.zoomAt + 1 + ' / ' + zoomList.length}
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
  /* ---------- 顶部工具条 ---------- */
  bar: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10
  },
  barBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },

  content: { paddingHorizontal: 16, paddingBottom: 24, paddingTop: 4 },

  // 失败态（见 load 的说明）：一句实话 + 一个重试，而不是让骨架一直转下去
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  retryBtn: {
    marginTop: 20,
    paddingHorizontal: 22,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: colors.accentSoft
  },
  retryText: { fontSize: 14, fontWeight: '600', color: colors.accent },

  /* ---------- 正文 ---------- */
  doc: { paddingVertical: 18 },
  docTopic: { flexShrink: 1, fontSize: 12.5, color: colors.accent },
  docTitle: { marginTop: 12, fontSize: 21, fontWeight: '700', color: colors.t1, lineHeight: 31 },
  docAuthor: { marginTop: 12, fontSize: 14, color: colors.t2, lineHeight: 23 },
  docAuthorName: { color: colors.accent, fontWeight: '600' },

  // 顶上那组图：一列**竖排**，每张按自己的比例铺满整宽（见 renderHeads）。
  // 不是一排方格 —— 详情页要完整，方格就得裁，而这里没有第二个看全的入口。
  headCol: { marginTop: 6 },
  headItem: { marginTop: 10 },
  // 宽度与比例由 FitImage 负责，这里只给圆角和**加载中的底色**
  //（比例量准之后不会有留白，底色只在图还没上屏时看得见）
  headImg: { width: '100%', borderRadius: 12, backgroundColor: colors.line2 },
  // 内置示例内容的占位块（emoji + 底色）：那种"图"本来就是个色块，
  // 没有真实比例可量，所以仍然给它一个固定比例
  headPh: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headEmoji: { fontSize: 40 },

  // 小标题：带左侧主色竖条的**分节标题**，与 Article.js 的 artH 同一套观感。
  //
  // 竖条不是装饰。正文里标题和段落是同样的文字，只靠"加粗"区分，往下滑快一点
  // 就分不出"这里是新的一节"—— 一条竖线让扫读时眼睛能直接定位分节。
  // 后台那个编辑器的提示文案（admin/src/articleBlocks.js 的 BLOCKS.h.hint）
  // 就是这么描述它的，两边必须长得一样，否则运营按提示写出来的效果对不上。
  h: {
    marginTop: 22,
    paddingLeft: 10,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.t1,
    lineHeight: 25
  },
  p: { marginTop: 12, fontSize: 15, color: colors.t1, lineHeight: 26 },
  // 金句：暖色底 + 描边，与 Article.js 的 artQ 同一套观感
  q: {
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 13,
    borderRadius: 8,
    backgroundColor: colors.warm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warmLine,
    fontSize: 14,
    lineHeight: 24,
    color: '#8A5B1C'
  },

  /* ---------- 正文里的插图 ---------- */
  bodyImgWrap: { marginTop: 14 },
  // **不要写 height**：高度由 FitImage 按图的真实比例定（见 renderBodyImage
  // 的注释）。给个固定高度的话，比例一对不上就会留出一圈白边。
  // backgroundColor 只是图还没上屏时的底色。
  bodyImg: { width: '100%', borderRadius: 12, backgroundColor: colors.line2 },
  // 图注居中：它是这张图的附属说明，跟着图的中心走。
  // 左对齐会被读成"与图无关的正文一行"，尤其在图比文字窄的时候。
  bodyImgCap: {
    marginTop: 6,
    fontSize: 12,
    color: colors.t3,
    lineHeight: 18,
    textAlign: 'center'
  },

  /* ---------- 投票 ---------- */
  pollWrap: { marginTop: 16 },
  pollQ: { fontSize: 15.5, fontWeight: '600', color: colors.t1, lineHeight: 25 },
  // 补充说明。详情页里完整显示，比题目小一号、灰一档 ——
  // 它是注解，读起来不该和题目一样重（一样重就成了一团加粗的字）。
  pollDesc: { marginTop: 8, fontSize: 14, color: colors.t2, lineHeight: 22 },
  // 结果态下这里要放一条绝对定位的条形，所以：
  //   · 不写 alignItems:'center' —— 它会把子元素收成内容宽，条形就铺不开；
  //   · 加 overflow:'hidden' —— 圆角才切得住那条铺满整宽的条形。
  option: {
    marginTop: 9,
    paddingVertical: 12,
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
   * ⚠️ 名字必须带 `poll` 前缀，**不能叫 `bar`**。
   * 这个文件顶部已经有一个 `bar`（顶部工具条），而 StyleSheet 就是个对象 ——
   * 同名 key 后写的会**静默覆盖**先写的，谁都不报错。曾经就叫 `bar`，
   * 结果工具条被换成了这条"绝对定位、没有高度、bottom:0"的条形：
   *   · position:'absolute' → 工具条脱离文档流，正文卡直接顶上来盖住它；
   *   · 没有 height/flexDirection → 三个图标挤到最左边（只看得见一个）；
   *   · bottom:0 且没有宽度 → 左边缘拖出一条竖到底的浅色条。
   * 一个命名偷懒，症状出现在完全不相干的另一块区域，很难往回找。
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

  /* ---------- 内嵌工具卡 ---------- */
  toolCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.line2
  },
  toolIco: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  toolEmoji: { fontSize: 18 },

  /* ---------- 表态 ---------- */
  reactRow: { flexDirection: 'row', marginTop: 16 },
  reactBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    marginRight: 10,
    borderRadius: 14,
    backgroundColor: colors.card
  },
  reactBtnOn: { backgroundColor: colors.accentSoft },
  reactEmoji: { fontSize: 18 },
  reactLabel: { marginTop: 5, fontSize: 11.5, color: colors.t3 },
  reactLabelOn: { color: colors.accent, fontWeight: '600' },

  /* ---------- 回应 ---------- */
  sectionTitle: { marginTop: 24, marginBottom: 12, fontSize: 16, fontWeight: '700', color: colors.t1 },
  cmt: { marginBottom: 10, paddingVertical: 14 },
  cmtAvatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  cmtAvatarText: { fontSize: 13, fontWeight: '600', color: '#5A6472' },
  cmtText: { marginTop: 10, marginBottom: 8, fontSize: 14, color: colors.t1, lineHeight: 22 },

  /* ---------- 底部写想法 ---------- */
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8
  },
  input: {
    flex: 1,
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
    fontSize: 13,
    color: colors.t1,
    backgroundColor: colors.card
  },
  send: {
    marginLeft: 10,
    paddingHorizontal: 16,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.dark
  },
  sendOff: { backgroundColor: colors.line2 },
  sendText: { fontSize: 13, fontWeight: '600', color: '#FFFFFF' },
  disclaim: { textAlign: 'center', paddingTop: 8, paddingBottom: 4, fontSize: 10.5, color: colors.t3 },

  /* ---------- 小标题目录 ---------- */

  // 悬浮按钮（右下角）。
  //
  // ⚠️ bottom 88 是量着底下那两条来的：composer（paddingTop 8 + 输入框 40）
  // 加 disclaim（上下 padding 12 + 一行小字）大约 74，再留十几像素的间隙。
  // 随手给个 20 的话，按钮正好压在「发送」上 —— 而那是这一页最要紧的按钮。
  //
  // 做成胶囊而不是圆球：单独一个 ≡ 很多人第一眼认不出是目录，
  // 配上两个字才不用猜。阴影用 s.float（悬浮级），在 JSX 里叠上去。
  tocBtn: {
    position: 'absolute',
    right: 14,
    bottom: 88,
    flexDirection: 'row',
    alignItems: 'center',
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    backgroundColor: colors.card
  },
  tocBtnIco: { marginRight: 6, fontSize: 15, color: colors.accent },
  tocBtnText: { fontSize: 13, fontWeight: '600', color: colors.t1 },

  // 遮罩铺满整屏（含顶部工具条和底部输入条）。它们确实比目录按钮更"外围"，
  // 但面板打开时本来就该盖住它们 —— 那一刻唯一该做的操作是选章节或关掉
  tocMask: {
    ...StyleSheet.absoluteFillObject,
    // 同层绝对定位元素的上下关系不能只靠"后渲染的在上"（见 Coverage.js
    // setArc 那处的说明），所以显式抬一层。图片放大的浮层是 Modal，
    // 天然在这一层之上，不受影响
    zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.35)'
  },
  tocPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // 限高，别顶到头：章节再多也在面板内部滚
    maxHeight: '72%',
    paddingTop: 16,
    paddingBottom: 24,
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20
  },
  tocHead: { paddingHorizontal: 18, marginBottom: 8 },
  tocList: { paddingHorizontal: 8 },
  tocItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10
  },
  // 当前这一节：整条浅主色底 + 主色字。只把字变色不够 ——
  // 一屏十几条的时候，扫视时找不到
  tocItemOn: { backgroundColor: colors.accentA08 },
  tocNum: { width: 22, fontSize: 12, lineHeight: 20, color: colors.t3 },
  tocText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.t2 },
  tocOn: { color: colors.accent, fontWeight: '600' },

  /* ---------- 图片放大 ---------- */
  // 压得很暗（0.72）：放大态的注意力只该在图上，背后的正文越看不出越好
  zoomMask: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)'
  },
  // 承载整条图集。必须写满宽：上面是 alignItems:'center'，
  // 不写的话 FlatList 会缩成内容宽，就翻不动了。
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
  // "2 / 5"：铺满一行再居中，位置不随文字宽度变。
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
   * 放大浮层里的那一层：**铺满整页**，不再是一个正方框（与 Community.js 一致）。
   *
   * 原来这里是 86% 宽的**正方形**：横图缩在框里、上下各留一大条，四周还看得见
   * 框的圆角 —— 而放大要的就是"把这张图铺开看"，框本身是多余的，还会把图压小。
   *
   * 铺满整页，配 Image 的 resizeMode="contain"：图按**自己的比例完整显示**，
   * 屏幕多大就显示多大，剩下的地方就是遮罩底色。
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

module.exports = CommunityDetail
