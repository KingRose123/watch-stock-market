const React = require('react')
const { View, Text, Image, ScrollView, Pressable, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const { goTool } = require('../utils/toolRoutes.js')
// 按图片真实比例定高度的图（与社区详情页同一套）
const FitImage = require('../components/FitImage.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

// 底部「动手算一算」的两行入口（与 article.wxml 一一对应）
const TOOLS = [
  { id: 't1', ico: '🧮', name: '复利计算器', desc: '按你自己的本金与月投，算出 20 年后的样子' },
  { id: 't4', ico: '📈', name: '定投回测', desc: '把分红再投入，看看历史能滚出多少' }
]

/**
 * 跳转后"以跳转目标为准"的有效时长（毫秒）。
 *
 * jumpTo 会触发一次平滑滚动，那次滚动同样会走 onScroll。如果一滚就把
 * 跳转目标作废，"跳转完再打开目录"就又会去按滚动位置反推，于是又回到
 * 差一节的老问题（见 openToc）。这个时间窗把跳转自己那次滚动和用户之后
 * 的手动滚动区分开：滚动动画大约 300ms，给到 600ms 留足余量。
 */
const PIN_MS = 600

/* ---------------- 正文渲染 ----------------
 * 当前接口的 body 是块数组（{ t: 'h' | 'p' | 'q', v }），按类型直接渲染。
 * 另附一个「HTML 字符串 → 块数组」的极简兜底解析（万一以后改成富文本）：
 * 支持 <p> <h1>-<h4> <ul>/<li> <blockquote>，其它标签降级为纯文本，不引入任何依赖。
 */
function stripTags(html) {
  return String(html === null || html === undefined ? '' : html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function htmlToBlocks(html) {
  const src = String(html === null || html === undefined ? '' : html)
  const blocks = []
  const re = /<(h1|h2|h3|h4|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m

  while ((m = re.exec(src)) !== null) {
    const tag = m[1].toLowerCase()
    const text = stripTags(m[2])
    if (!text) continue
    blocks.push({ t: tag.charAt(0) === 'h' ? 'h' : tag === 'blockquote' ? 'q' : 'p', v: text })
  }

  // 一个结构都没解析出来（纯文本或其它标签）就整段降级成一段正文
  if (!blocks.length) {
    const text = stripTags(src)
    if (text) blocks.push({ t: 'p', v: text })
  }
  return blocks
}

// 统一成块数组：已经是数组（当前接口）就用它，是字符串（HTML）就先解析
function bodyBlocks(body) {
  if (body && typeof body.map === 'function') return body
  return htmlToBlocks(body)
}

/** 文章页：正文按块数组渲染，底部两个入口跳到对应工具。 */
class Article extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      article: null,
      // 章节目录面板开着没（右下角那颗悬浮按钮控制）
      tocOpen: false,
      // 当前读到第几节，用来在目录里高亮。默认 0：还没滚动，就在第一节
      tocActive: 0
    }

    // ── 下面这些都是"量出来的布局"，刻意**不进 data** ──
    // 它们只被 jumpTo / activeAt 读，不参与渲染。放进 data 的话，onLayout
    // 每回调一次就多一次整页重渲染（正文有几十个块，不划算）。
    this.blocks = [] // 正文块数组（解析一次，见 onLoad）
    this.toc = [] // [{ block: 块下标, text: 标题文字 }]
    this.headY = {} // 块下标 → 该标题相对**正文容器**的 y
    // 标题在正文容器里，正文容器在卡片里，卡片又在滚动内容里 ——
    // 所以真实坐标要这三层相加，缺一层就会跳偏（且不报错，见 jumpTo）
    this.cardY = 0
    this.bodyY = 0
    // 最近一次滚动位置。目录关着时 onScroll 不算高亮，但打开目录要靠它
    // 定位"现在在哪一节"，所以这个值得一直记
    this.scrollY = 0
    // 上一次跳转到的章节序号。打开目录时它优先于"按滚动位置反推"，
    // 理由见 openToc（跳转后正文里的图才撑开，位置会往下漂）
    this.tocPinned = null
    // 上面那个目标的有效期（见 PIN_MS）。过期的跳转目标是垃圾信息：
    // 用户后来自己滚到哪儿，哪儿才是"当前章节"
    this.pinUntil = 0
  }

  onLoad(options) {
    this.id = (options && options.id) || 'a1'

    api
      .getArticle(this.id)
      .then((res) => {
        const art = res.data || {}
        // 解析一次、存到实例上：render 每次都要用它（原来每渲染一次
        // 就 bodyBlocks() 一遍，正文几十个块白算几十次）
        this.blocks = bodyBlocks(art.body)
        this.toc = this.tocOf(this.blocks)
        this.headY = {}
        this.tocPinned = null
        this.pinUntil = 0
        this.setData({ loading: false, article: art })
      })
      .catch(util.onError)
  }

  /* ---------------- 小标题目录 ---------------- */

  /** 从块数组里挑出所有小标题 —— 目录的数据源。 */
  tocOf(blocks) {
    const out = []
    blocks.forEach((b, i) => {
      if (b.t === 'h') out.push({ block: i, text: stripTags(b.v) })
    })
    return out
  }

  /**
   * 打开目录：顺手把高亮定位到"当前读到哪一节"。
   *
   * ⚠️ 优先用上一次跳转的目标，而不是"按滚动位置反推"。
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
    const base = this.cardY + this.bodyY
    let k = 0
    for (let i = 0; i < this.toc.length; i++) {
      const h = this.headY[this.toc[i].block]
      // 还没量到的就跳过。理论上不会发生（onLayout 在首次渲染后就回调了），
      // 但真漏了的话按 0 处理会让高亮直接掉回第一节，反而更糟
      if (h === undefined) continue
      if (base + h <= y + 48) k = i
      else break
    }
    return k
  }

  /**
   * 跳到第 k 节。
   *
   * 三个偏移相加才是 ScrollView 认得的那个坐标（见构造器里的说明）。
   * 少加一层不会报错，只是"跳得不太准" —— 最难查的那类问题。
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

    const y = this.cardY + this.bodyY + h
    // -12 是留白：标题贴着自己那条竖条正好顶到屏幕上沿会显得很挤。
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
    // 的话，长文章会肉眼可见地掉帧（同 Archive.js 顶部收起那处的处理）
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

              {/* 章节多到一屏放不下时内部滚动（这页有八节的已经接近满屏） */}
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

  // 文章底部「去看看」：跳到对应工具
  //
  // 落点从 utils/toolRoutes.js 出，不再自己拼 URL —— 原来这里硬编了
  // '/pages/tool/tool?id='，于是 t2（分红日历）这类落点不在这条路上，
  // 一旦有人往 TOOLS 里加它，点了就会打开一个不存在的 tool?id=t2。
  onTool(e) {
    goTool(e.currentTarget.dataset.id)
  }

  // 小程序里是分享菜单用的；App 端还没挂入口，方法体保持原样
  onShare() {
    wx.showToast({ title: '已复制文章链接', icon: 'none' })
  }

  renderBody(blocks) {
    return blocks.map((b, i) => {
      const text = stripTags(b.v)

      if (b.t === 'h') {
        // 记下这个标题的 y（相对正文容器）。目录跳转全靠它 ——
        // 量不到就只能猜，而文章长度不固定，猜不出来
        return (
          <Text
            key={i}
            style={styles.artH}
            onLayout={(e) => {
              this.headY[i] = e.nativeEvent.layout.y
            }}
          >
            {text}
          </Text>
        )
      }
      if (b.t === 'q') return <Text key={i} style={styles.artQ}>{text}</Text>
      if (b.t === 'img') return this.renderImage(b, i)
      if (b.t === 'tool') return this.renderTool(b, i)

      return <Text key={i} style={styles.artP}>{text}</Text>
    })
  }

  /**
   * 正文插图与工具卡。
   *
   * 这一页（发现 · 收息小课）目前的内容还是内置的，用不到这两种块；
   * 但**渲染必须跟上** —— 后台编辑器写出的正文是一套统一的块格式，
   * 哪天这批文章也搬到后台维护，少处理一种块的表现就是
   * "图片和工具卡凭空不见了"，而且不会报任何错。
   */
  renderImage(b, i) {
    if (!b.url) return null
    return (
      <View key={i} style={styles.imgWrap}>
        {/* 高度按图自己的比例走（FitImage）：这里要的是"看全"，而固定高度的框
            配上 contain 必然给比例不同的图留一圈白边（见那个组件的说明）。 */}
        <FitImage url={b.url} style={styles.img} />
        {b.caption ? <Text style={styles.imgCap}>{b.caption}</Text> : null}
      </View>
    )
  }

  renderTool(b, i) {
    return (
      <Pressable key={i} style={styles.bodyTool} onPress={() => goTool(b.id)}>
        <Text style={styles.toolIco}>{b.emoji || '🧮'}</Text>
        <View style={s.flex1}>
          <Text style={[s.mid, s.bold]}>{b.title || '试试这个工具'}</Text>
          <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>{b.desc || '点此打开'}</Text>
        </View>
        <Text style={styles.arrow}>›</Text>
      </Pressable>
    )
  }

  render() {
    if (this.data.loading) {
      return (
        <View style={s.page}>
          <ScrollView contentContainerStyle={s.content}>
            <View style={[s.card, styles.empty]}>
              <Text style={styles.emptyEmoji}>📖</Text>
              <Text style={styles.emptyTitle}>正在加载文章…</Text>
            </View>
          </ScrollView>
        </View>
      )
    }

    const a = this.data.article || {}

    return (
      <View style={s.page}>
        <ScrollView
          ref={(r) => (this.scrollRef = r)}
          contentContainerStyle={s.content}
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
          <View
            style={s.card}
            onLayout={(e) => {
              this.cardY = e.nativeEvent.layout.y
            }}
          >
            <View style={s.row}>
              <Text style={[s.tag, styles.tagGreen]}>{a.tag}</Text>
              <Text style={[s.tiny, s.dim, { marginLeft: 12 }]}>{a.read}</Text>
            </View>

            <Text style={styles.artTitle}>{a.title}</Text>
            <Text style={[s.tiny, s.dim, { marginTop: 12 }]}>更新于 {a.updated}</Text>

            <View
              style={styles.artBody}
              onLayout={(e) => {
                this.bodyY = e.nativeEvent.layout.y
              }}
            >
              {this.renderBody(this.blocks)}
            </View>
          </View>

          <View style={styles.secHead}>
            <Text style={s.h3}>动手算一算</Text>
          </View>

          <View style={[s.card, styles.cardFlat]}>
            {TOOLS.map((t, i) => (
              <Pressable
                key={t.id}
                style={[styles.toolRow, i === TOOLS.length - 1 ? styles.rowLast : null]}
                onPress={() => this.onTool(tap({ id: t.id }))}
              >
                <Text style={styles.toolIco}>{t.ico}</Text>
                <View style={s.flex1}>
                  <Text style={[s.mid, s.bold]}>{t.name}</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>{t.desc}</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.artFoot}>本文为理念分享，不构成任何投资建议。</Text>
        </ScrollView>

        {/* 目录（悬浮按钮 + 章节面板）。只在真有章节时出现 ——
            没有小标题的文章，这颗按钮点开只会是个空面板 */}
        {this.toc.length >= 2 ? this.renderToc() : null}
      </View>
    )
  }
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 45, alignItems: 'center' },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: { marginTop: 11, fontSize: 14, color: colors.t2 },

  tagGreen: { backgroundColor: colors.accentA10, color: colors.accent },

  artTitle: { marginTop: 11, fontSize: 20, fontWeight: '700', lineHeight: 28, color: colors.t1 },
  artBody: { marginTop: 6 },
  artP: { marginTop: 14, fontSize: 14, lineHeight: 27, color: colors.t2, textAlign: 'justify' },
  // 小标题：左侧主色竖条
  artH: {
    marginTop: 22,
    paddingLeft: 10,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 24,
    color: colors.t1
  },
  // 金句：暖色底 + 描边
  artQ: {
    marginTop: 15,
    paddingVertical: 12,
    paddingHorizontal: 13,
    borderRadius: 8,
    backgroundColor: colors.warm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warmLine,
    fontSize: 13,
    lineHeight: 23,
    color: '#8A5B1C'
  },

  /* 正文插图：同 CommunityDetail.js —— 高度由 FitImage 按图的比例定 */
  imgWrap: { marginTop: 14 },
  // **不要写 height**，理由见 renderImage 的注释
  img: { width: '100%', borderRadius: 12, backgroundColor: colors.line2 },
  // 图注居中，与 CommunityDetail 的 bodyImgCap 保持一致
  imgCap: {
    marginTop: 6,
    fontSize: 12,
    color: colors.t3,
    lineHeight: 18,
    textAlign: 'center'
  },

  // 正文里的工具卡。不复用底部的 toolRow —— 那个带一条下边框
  // （它是长列表的分隔线），摆进正文里会在半句话中间多出一条横线。
  bodyTool: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 18,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.line2
  },

  secHead: { marginTop: 18, marginBottom: 10, paddingHorizontal: 4 },
  cardFlat: { paddingHorizontal: 14, paddingVertical: 0 },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  rowLast: { borderBottomWidth: 0 },
  toolIco: { marginRight: 10, fontSize: 20 },
  arrow: { fontSize: 17, color: colors.t3 },

  artFoot: { marginTop: 15, paddingHorizontal: 4, fontSize: 11, lineHeight: 19, color: colors.t3 },

  /* ---------- 小标题目录 ---------- */

  // 悬浮按钮（右下角）。做成胶囊而不是圆球：单独一个 ≡ 很多人第一眼
  // 认不出是目录，配上两个字才不用猜。阴影取 s.float（悬浮级），
  // 在 JSX 里叠上去 —— 它比卡片阴影重一档，因为这是浮在内容之上的东西。
  tocBtn: {
    position: 'absolute',
    right: 14,
    bottom: 26,
    flexDirection: 'row',
    alignItems: 'center',
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    backgroundColor: colors.card
  },
  tocBtnIco: { marginRight: 6, fontSize: 15, color: colors.accent },
  tocBtnText: { fontSize: 13, fontWeight: '600', color: colors.t1 },

  // 遮罩铺满 s.page。注意它**只压暗滚动内容那一块** —— 顶部标题栏画在
  // s.page 外面（App.js 的 withBar），所以不受影响，这正是想要的
  tocMask: {
    ...StyleSheet.absoluteFillObject,
    // 同层绝对定位元素的上下关系不能只靠"后渲染的在上"（见 Coverage.js
    // setArc 那处的说明），所以显式抬一层
    zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.35)'
  },
  tocPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // 限高，不要顶到标题栏：章节再多也在面板里滚
    maxHeight: '72%',
    paddingTop: 16,
    paddingBottom: 20,
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
  tocOn: { color: colors.accent, fontWeight: '600' }
})

module.exports = Article
