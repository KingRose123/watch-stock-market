const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet, TextInput } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const LoginGuard = require('../components/LoginGuard.js')
const app = require('../app.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

/**
 * 投资档案：已清仓标的的复盘台。
 *
 * 它要回答的问题不是「我赚了多少」，而是**「我当初卖对了吗」** ——
 * 所以每张卡片的主角是「卖出至今」的涨跌：
 *   跌了 → 躲过下跌，卖对了
 *   涨了 → 卖早了，少赚了
 * 两个方向都有价值，不存在「只该看对的」。
 *
 * 清仓有两种来源（见 store.isArchived）：
 *   · 卖出全部股数 → 自动进来，不需额外操作；
 *   · 详情页手动点「清仓归档」→ 还没卖完但决定不再跟踪。
 * 归档是标记不是删除：持仓、每一笔流水、每笔写下的想法，全都留着 ——
 * 点进任意一只仍能翻到完整的操作记录。
 */
/**
 * 筛选项。顺序是刻意的：把「卖飞了」紧挨着「全部」放 ——
 * 「卖对了」是看一眼就够的安慰，「卖飞了」才是会让人反复回看的那一组，
 * 而按页面上那排的阅读顺序，靠左边的更容易被用到。
 */
const CHIPS = [
  { key: 'all', label: '全部' },
  { key: 'fly', label: '卖飞了' },
  { key: 'win', label: '卖对了' },
  { key: 'noReason', label: '未写想法' }
]

// 心得默认折叠到几行。正文与隐藏测量层必须用同一个值，
// 否则"量出来几行"和"实际显示几行"对不上，判断就会错。
const REASON_LINES = 3

const SORTS = [
  { key: 'recent', label: '最近清仓' },
  { key: 'drop', label: '跌得最多' },
  { key: 'rise', label: '涨得最多' },
  { key: 'dividend', label: '收息最多' }
]

class Archive extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      guest: false,
      // list 是接口给的全量，**从不被筛选改写** —— 它同时喂给计数和过滤。
      // 如果过滤时直接改 list，切回「全部」就再也回不来了。
      list: [],
      // shown 是 list 经「筛选 + 搜索 + 排序」之后的结果，render 只遍历它
      shown: [],
      count: 0,
      winText: '—',
      flyCount: 0,
      winCount: 0,
      noReasonCount: 0,
      // 查询条件三件套
      kw: '',
      filter: 'all', // all | fly | win | noReason
      sort: 'recent', // recent | drop | rise | dividend
      // 哪几条卡片的心得被展开了（id → true）。放在 data 里而不是写回 reason，
      // 是为了「展开」纯粹只是个显示状态，不碰任何业务数据
      expanded: {},
      // 每条心得实测占几行（id → 行数）。undefined = 还没量过。
      // 用来判断"要不要给展开入口" —— 没溢出的文字给它一个展开按钮，
      // 点了什么都不会变，反而让人以为坏了
      reasonLines: {},
      // 总览卡片滚过之后收起成一行
      topCollapsed: false,
      emptyText: '',
      // 有筛选条件但一条都没命中 —— 与「还没有清仓的标的」是两回事，
      // 文案必须分开，否则用户会以为自己的记录丢了
      filtered: false
    }
  }

  /**
   * 筛选 + 搜索 + 排序。
   *
   * 统一在 setData 之前算好，render 里就只剩遍历 shown —— 让「什么时候重算」
   * 只有这一个入口，避免出现「改了 kw 但列表没更新」这类状态不同步的问题。
   * 归档列表通常只有几十条，每次重算的代价可以忽略。
   */
  applyFilter() {
    const list = this.data.list
    const q = String(this.data.kw || '').trim().toLowerCase()
    const filter = this.data.filter
    const active = !!q || filter !== 'all'

    let rows = list.filter((r) => {
      if (filter === 'fly' && !r.sinceExitUp) return false
      if (filter === 'win' && !r.sinceExitDown) return false
      if (filter === 'noReason' && r.reason) return false
      if (!q) return true
      // 心得正文也参与匹配。搜「股息率跌破」能直接捞出当时写过这句的那几只 ——
      // 「当初为什么卖」多数人只记得大意，记不住是哪只票，光搜代码等于逼人先想起来
      const hay = String(r.name || '') + ' ' + String(r.code || '') + ' ' + String(r.reason || '')
      return hay.toLowerCase().indexOf(q) > -1
    })

    rows = rows.slice().sort((a, b) => {
      if (this.data.sort === 'drop') return a.sinceExit - b.sinceExit // 负得最狠的在前
      if (this.data.sort === 'rise') return b.sinceExit - a.sinceExit
      if (this.data.sort === 'dividend') return b.received - a.received
      // 最近清仓优先。archivedAt 是 YYYY-MM-DD，定长且高位在前，直接比字符串即可
      return String(b.archivedAt || '').localeCompare(String(a.archivedAt || ''))
    })

    this.setData({ shown: rows, filtered: active })
  }

  /** 搜一个关键字。this.data 是同步的，所以 setData 之后立刻重算读得到新值 */
  onKw(v) {
    this.setData({ kw: String(v || '') })
    this.applyFilter()
  }

  setFilter(key) {
    if (this.data.filter === key) return
    this.setData({ filter: key })
    this.applyFilter()
  }

  setSort(key) {
    if (this.data.sort === key) return
    this.setData({ sort: key })
    this.applyFilter()
  }

  /**
   * 记下一条心得实际占了几行。
   *
   * 为什么不直接给正文加 numberOfLines 再用 onTextLayout 判断它有没有溢出：
   * numberOfLines 是 native 层做的截断，此时 onTextLayout 回报的行数
   * 在 Android 上是被截断后的值（恒等于限制行数，永远看不出溢出），
   * iOS 上却可能给完整行数 —— 两个平台不一致，拿它做判断必然出岔子。
   *
   * 所以另外放一个**不限行数的隐藏副本**去量，量到的才是真实行数。
   * 只量一次：量过就不再 setData，否则每次布局都会触发一轮重渲染。
   */
  measureReason(id, e) {
    const lines = (e && e.nativeEvent && e.nativeEvent.lines) || []
    if (!lines.length) return
    if (this.data.reasonLines[id] != null) return
    const next = Object.assign({}, this.data.reasonLines)
    next[id] = lines.length
    this.setData({ reasonLines: next })
  }

  /**
   * 这条心得是否被折叠藏住了内容。
   *
   * 还没量出来时返回 false —— 宁可暂时不显示展开入口，也不要先亮出来再收回去。
   * 测量在首次布局时完成，用户看不到这个中间态。
   */
  reasonOverflow(id) {
    const n = this.data.reasonLines[id]
    return typeof n === 'number' && n > REASON_LINES
  }

  /** 展开 / 收起一条心得。只翻一个布尔标记，不动 reason 本身 */
  toggleReason(id) {
    const next = Object.assign({}, this.data.expanded)
    if (next[id]) delete next[id]
    else next[id] = true
    this.setData({ expanded: next })
  }

  /**
   * 清空所有查询条件。
   * 单独给个出口，是因为「筛完发现是空的」之后，用户得逐个把条件撤回去才能看全 ——
   * 条件只有三个还好，但搜索结果与筛选叠加时，人往往记不清自己点过哪些。
   */
  clearFilter() {
    this.setData({ kw: '', filter: 'all' })
    this.applyFilter()
  }

  /**
   * 选排序。
   *
   * 走 ActionSheet 而不是顶部再排一行按钮：排序是低频设定，
   * 而顶部已经有了搜索框 + 筛选条两行，再加一行常驻按钮会把可视区压得只剩两三张卡片 ——
   * 对一个「要看很多条」的页面来说，这个代价比多一次点击大得多。
   */
  pickSort() {
    wx.showActionSheet({
      itemList: SORTS.map((x) => x.label),
      success: (res) => {
        const hit = SORTS[res.tapIndex]
        if (hit) this.setSort(hit.key)
      }
    })
  }

  /**
   * 滚过总览卡片就把它收成一行。
   *
   * 判断依据用**滚动位置**而不是「滚到某张卡片」：后者要测量卡片在屏幕上的位置，
   * 而这个高度会随筛选结果变化（一条长心得展开就是另一个高度），测量结果很快过期。
   * 阈值法简单，且不会失效。
   *
   * 每次滚动都会触发，所以先比一次值再 setData —— 不加这个判断，
   * 一次滑动能触发几十次重渲染，列表长了会明显掉帧。
   */
  onScroll(e) {
    const y = (e && e.nativeEvent && e.nativeEvent.contentOffset.y) || 0
    const c = y > 60
    if (c !== this.data.topCollapsed) this.setData({ topCollapsed: c })
  }

  onShow() {
    if (!app.isLogin()) {
      this.setData({ guest: true, loading: false })
      return
    }
    if (this.data.guest) this.setData({ guest: false })
    this.load()
  }

  load() {
    // 先按实时行情刷新：卖出至今涨跌要靠最新价，
    // 拿缓存里的旧价算出来的结论是错的（还会正好反过来）
    return api
      .refreshHoldingQuotes()
      .catch(() => 0)
      .then(() => api.getArchive())
      .then((res) => {
        const d = res.data
        this.setData({
          loading: false,
          list: d.list,
          count: d.count,
          winText: d.winText,
          flyCount: d.flyCount,
          winCount: d.winCount,
          noReasonCount: d.noReasonCount,
          emptyText: d.emptyText
        })
        // 行情刷新后涨跌会变，所以筛选结果必须跟着重算 ——
        // 否则会出现「总览的数字更新了，列表却还是按上一轮涨跌筛出来的那几条」，
        // 这种前后不一致最难被发现，因为两边单看都合理
        this.applyFilter()
      })
      .catch(util.onError)
  }

  // 走 wx.navigateTo 而不是直接 navigation.navigate：
  // 与项目里其余 25 处跳转保持同一路径，nav.js 的页面栈才不会漏记这一层
  // （util.back() 靠它判断是不是栈底）。
  goRecords(id) {
    wx.navigateTo({ url: '/pages/holding-record/holding-record?id=' + id })
  }

  /**
   * 把归档标的退回持仓列表（撤销手动归档）。
   *
   * 只对「手动归档、还没卖完」的有意义：股数归零那种归档状态是从 shares
   * 推导出来的，不写回股数就退不出去 —— 那种卡片不显示这个按钮，
   * 接口那边也会拦一道并说明原因。
   */
  restore(h) {
    wx.showModal({
      title: '返回持仓',
      content:
        '「' + h.name + '」会回到持仓列表，重新计入市值与分红。\n\n' +
        '归档是标记不是删除 —— 流水和这段想法都留着，以后再归档还在。',
      confirmText: '返回持仓',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.unarchiveHolding(h.id), {
            loadingText: '处理中',
            success: '已回到持仓列表'
          })
          .then((r) => {
            if (r) this.load()
          })
      }
    })
  }

  /**
   * 补写 / 修改清仓心得。
   *
   * 独立于归档动作，也不挑时机：归档那一刻未必想得清楚，也可能随手跳过，
   * 过了几个月回看才有话想说 —— 那时必须还能补。否则「记一句」就成了
   * 一次性的事，错过便永远空着。
   */
  editReason(h) {
    wx.showModal({
      title: '当时的想法',
      content: '当初为什么买、后来为什么卖？这段是写给以后的自己看的。',
      editable: true,
      multiline: true,
      maxLength: api.MEMO_MAX,
      // 预填原文：否则一打开是空白，改一个字就等于把原来那段全抹了
      initialContent: h.reason,
      placeholderText: '例如：股息率跌破 3%，换到更便宜的标的',
      confirmText: '保存',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.setArchiveReason(h.id, res.content), {
            loadingText: '保存中',
            success: '已记下'
          })
          .then((r) => {
            if (r) this.load()
          })
      }
    })
  }

  render() {
    if (this.data.guest) {
      return (
        <View style={s.page}>
          <LoginGuard
            icon="📦"
            title="登录后查看投资档案"
            desc="清仓记录会跟着账号同步，换设备也丢不了"
            onPress={() => app.toLogin()}
          />
        </View>
      )
    }

    if (this.data.loading) {
      return (
        <View style={[s.page, s.center]}>
          <Text style={[s.mid, s.dim]}>加载中…</Text>
        </View>
      )
    }

    return (
      <View style={s.page}>
        {/* 工具条钉在顶部：归档多了之后，「边滚边筛」才是主要用法，
            不能让人每换一次条件都得先把列表滚回顶部 */}
        <View style={styles.bar}>
          <View style={styles.searchWrap}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              style={styles.searchInput}
              value={this.data.kw}
              onChangeText={(v) => this.onKw(v)}
              placeholder="搜名称、代码或当时的想法"
              placeholderTextColor={colors.t3}
              returnKeyType="search"
            />
            {this.data.kw ? (
              <Pressable hitSlop={12} onPress={() => this.onKw('')}>
                <Text style={styles.searchClear}>✕</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.chipRow}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
              keyboardShouldPersistTaps="handled"
            >
              {CHIPS.map((c) => {
                const on = this.data.filter === c.key
                const n = chipCount(this.data, c.key)
                return (
                  <Pressable
                    key={c.key}
                    style={[styles.chip, on ? styles.chipOn : null]}
                    onPress={() => this.setFilter(c.key)}
                  >
                    <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>
                      {c.label}
                      {n === null ? '' : '  ' + n}
                    </Text>
                  </Pressable>
                )
              })}
            </ScrollView>

            {/* 排序固定在 chips 右侧、**不跟着横向滚动** ——
                它是全局设定，滚出屏幕之外会让人以为没有这个功能 */}
            <Pressable style={styles.sortBtn} hitSlop={8} onPress={() => this.pickSort()}>
              <Text style={styles.sortText}>{sortLabel(this.data.sort)} ▾</Text>
            </Pressable>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={s.content}
          // ⚠️ 必须用箭头包一层，**不能**写 onScroll={this.onScroll}。
          // ScrollView 内部是按 `this.props.onScroll(e)` 调的，函数体里的 this
          // 因此指向 **props** 而非页面实例，`this.data` 就成了 undefined ——
          // 一滚就崩、直接退回桌面且不弹任何提示（在 CommunityDetail 上实测到的，
          // 这里的写法完全一样，属于同一个隐患）。
          onScroll={(e) => this.onScroll(e)}
          scrollEventThrottle={64}
          keyboardShouldPersistTaps="handled"
        >
          {/* 总览：清了多少只、其中几只是「卖对了」。
              滚过之后收成一行 —— 那段口径说明是给第一次看的人解释的，
              看过就不必一直占三行位置。
              收起状态完全由滚动位置驱动（见 onScroll），这里不做点击切换：
              手动切和自动收会互相打架 —— 点了展开，手一滑又收回去 */}
          <View style={s.card}>
            {this.data.topCollapsed ? (
              <View style={s.between}>
                <Text style={[s.small, s.bold]}>已清仓 {this.data.count} 只</Text>
                <Text style={[s.small, styles.win]}>卖对了 {this.data.winText}</Text>
              </View>
            ) : (
              <View>
                <Text style={[s.tiny, s.dim]}>已清仓标的</Text>
                <View style={[s.row, { marginTop: 6, alignItems: 'flex-end' }]}>
                  <Text style={styles.big}>{this.data.count}</Text>
                  <Text style={[s.tiny, s.dim, { marginLeft: 5, marginBottom: 5 }]}>只</Text>
                </View>

                <View style={[s.between, { marginTop: 14 }]}>
                  <Text style={[s.tiny, s.dim]}>卖出后下跌（卖对了）</Text>
                  <Text style={[s.small, styles.win]}>{this.data.winText}</Text>
                </View>

                <Text style={[s.tiny, s.dim, { marginTop: 10, lineHeight: 18 }]}>
                  「卖出至今」= 清仓价到现价的涨跌。跌了说明躲过下跌，涨了说明卖早了 ——
                  两个方向都值得回看，所以两个方向的筛选项都留着。
                </Text>
              </View>
            )}
          </View>

          {this.data.shown.length ? (
            this.data.shown.map((h) => (
              <Pressable
                key={h.id}
                style={[s.card, styles.card]}
                onPress={() => this.goRecords(h.id)}
              >
                <View style={s.between}>
                  <View style={s.row}>
                    <View style={styles.ico}>
                      <Text style={styles.icoText}>{h.icon}</Text>
                    </View>
                    <View style={{ marginLeft: 6 }}>
                      <View style={s.row}>
                        <Text style={s.bold}>{h.name}</Text>
                        <Text style={[s.tag, styles.tagGray, { marginLeft: 4 }]}>{h.marketTag}</Text>
                      </View>
                      <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>
                        {h.code} · {h.sharesText}
                      </Text>
                    </View>
                  </View>

                  {/* 主角：卖出至今的涨跌 */}
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text
                      style={[
                        styles.diff,
                        s.num,
                        h.sinceExitUp ? styles.up : h.sinceExitDown ? styles.down : styles.flat
                      ]}
                    >
                      {h.sinceExitText}
                    </Text>
                    <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>卖出至今</Text>
                  </View>
                </View>

                <View style={styles.meta}>
                  <Cell label="清仓价" value={h.exitPriceText} first />
                  <Cell label="现价" value={h.nowPriceText} />
                  <Cell label="已收分红" value={h.receivedText} />
                </View>

                {h.reason ? (
                  <View style={styles.reason}>
                    <View style={s.between}>
                      <Text style={[s.tiny, s.dim]}>当时的想法</Text>
                      <Pressable hitSlop={10} onPress={() => this.editReason(h)}>
                        <Text style={styles.reasonEdit}>改</Text>
                      </Pressable>
                    </View>
                    {/* 隐藏的测量副本：不限行数，只用来量这段文字实际占几行。
                        字号与行高必须与下面的正文完全一致，否则量出来的行数不作数 ——
                        所以它复用同一个 styles.reasonText，只额外叠一个 measure。

                        单独要一个测量层的原因见 measureReason：正文带 numberOfLines，
                        而截断之后 onTextLayout 报的行数在两端不一致，靠不住。 */}
                    <Text
                      style={[s.small, styles.reasonText, styles.measure]}
                      onTextLayout={(e) => this.measureReason(h.id, e)}
                    >
                      {h.reason}
                    </Text>

                    {/* 正文：默认只露 3 行。心得上限是 MEMO_MAX = 5000 字，
                        一条写满的就能占掉整屏 —— 归档多了以后，正是少数几条长心得
                        把列表撑得极长，这才是「不好找」的主因，加搜索框治不了它。 */}
                    <Text
                      style={[s.small, styles.reasonText]}
                      numberOfLines={this.data.expanded[h.id] ? 0 : REASON_LINES}
                    >
                      {h.reason}
                    </Text>

                    {/* 只有**真的被折叠藏住内容**时才给展开入口。
                        短心得本来整段都看得见，配个「展开」按钮点了什么都不会变 ——
                        那比没有按钮更让人困惑（这条是实测反馈）。 */}
                    {this.reasonOverflow(h.id) ? (
                      <Pressable
                        hitSlop={10}
                        style={styles.reasonMoreWrap}
                        onPress={() => this.toggleReason(h.id)}
                      >
                        <Text style={styles.reasonMore}>
                          {this.data.expanded[h.id] ? '收起 ⌃' : '展开 ⌄'}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : (
                  // 空着时给一个能点的补写入口。以前这里只写「下次卖出时写一句」，
                  // 可「下次」是另一只标的，这一条就永远补不上了。
                  <Pressable style={styles.noReasonWrap} hitSlop={10} onPress={() => this.editReason(h)}>
                    <Text style={[s.tiny, styles.noReason]}>
                      还没写下当时的想法 —— 点这里补一句，回头最有用
                    </Text>
                  </Pressable>
                )}

                {/* 退回持仓列表。只有手动归档、且还持有的标的能退（见 canRestore）；
                    卖光的那种归档状态是股数推导出来的，写不回股数就退不出去。 */}
                {h.canRestore ? (
                  <View style={styles.actions}>
                    <Pressable style={styles.restoreBtn} hitSlop={8} onPress={() => this.restore(h)}>
                      <Text style={styles.restoreText}>返回持仓</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={[s.tiny, styles.soldOut]}>已卖光 —— 重新买入后会回到持仓列表</Text>
                )}
              </Pressable>
            ))
          ) : (
            // 两种「空」必须分开说：一条都没有，和「被筛掉了」是两回事。
            // 混用同一句话会让人以为记录丢了 —— 而它们其实还好好地在数据里
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>{this.data.filtered ? '🔍' : '📦'}</Text>
              <Text style={[s.mid, s.dim, { marginTop: 10, textAlign: 'center' }]}>
                {this.data.filtered ? '没有符合条件的标的' : this.data.emptyText}
              </Text>
              {this.data.filtered ? (
                <Pressable style={styles.clearBtn} hitSlop={8} onPress={() => this.clearFilter()}>
                  <Text style={styles.clearText}>清空筛选条件</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </ScrollView>
      </View>
    )
  }
}

/**
 * 筛选条上每个 chip 后面跟的数字。
 *
 * 「全部」显示总数，其余显示对应分组的条数。数字直接给出来，是为了让人
 * 在点之前就知道「卖飞了」里有几条 —— 归档多的时候，这比点进去再退出来快得多。
 */
function chipCount(data, key) {
  if (key === 'all') return data.count
  if (key === 'fly') return data.flyCount
  if (key === 'win') return data.winCount
  if (key === 'noReason') return data.noReasonCount
  return null
}

function sortLabel(key) {
  const hit = SORTS.filter((x) => x.key === key)[0]
  return hit ? hit.label : SORTS[0].label
}

function Cell(props) {
  return (
    <View style={[styles.cell, props.first ? null : styles.cellLine]}>
      <Text style={styles.cellLabel}>{props.label}</Text>
      <Text style={[styles.cellValue, s.num]}>{props.value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  // ---------- 顶部工具条 ----------
  // 内边距取 16，与 s.content 的 paddingHorizontal 一致 ——
  // 否则工具条里的搜索框会和下面的卡片左右错开半个身位，一眼就能看出来
  bar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 9,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E7EBE9'
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.line2,
    borderRadius: 10,
    paddingHorizontal: 11,
    height: 38
  },
  searchIcon: { fontSize: 13, marginRight: 6 },
  // padding 归零：RN 的 TextInput 在 Android 上自带内边距，
  // 不清掉会让文字在 38 高的框里偏下，看着像没对齐
  searchInput: { flex: 1, fontSize: 14, color: colors.t1, padding: 0 },
  searchClear: { fontSize: 14, color: colors.t3, paddingHorizontal: 4 },

  chipRow: { flexDirection: 'row', alignItems: 'center', marginTop: 9 },
  chips: { paddingRight: 8 },
  chip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.line2,
    marginRight: 7
  },
  chipOn: { backgroundColor: colors.accent },
  chipText: { fontSize: 12, color: colors.t2 },
  chipTextOn: { color: '#FFFFFF', fontWeight: '600' },

  sortBtn: { paddingLeft: 10, paddingVertical: 6 },
  sortText: { fontSize: 12, color: colors.accent, fontWeight: '600' },

  big: { fontSize: 30, fontWeight: '700', color: colors.t1, letterSpacing: -0.5 },
  win: { color: colors.accent, fontWeight: '600' },

  card: { marginTop: 10 },
  ico: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: '#EDF0EF',
    alignItems: 'center',
    justifyContent: 'center'
  },
  icoText: { fontSize: 15, color: colors.t2 },
  tagGray: { backgroundColor: colors.line2, color: colors.t2 },

  // 卖出至今：整张卡片里最大的一行
  diff: { fontSize: 19, fontWeight: '700', letterSpacing: -0.25 },
  // 红涨绿跌，与国内行情软件一致
  up: { color: '#E5484D' },
  down: { color: colors.down },
  flat: { color: colors.t3 },

  meta: {
    flexDirection: 'row',
    marginTop: 13,
    backgroundColor: '#F7F9F8',
    borderRadius: 9,
    paddingVertical: 10
  },
  cell: { flex: 1, alignItems: 'center' },
  cellLine: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#E7EBE9' },
  cellLabel: { fontSize: 11, color: colors.t3 },
  cellValue: { marginTop: 5, fontSize: 13, fontWeight: '500', color: colors.t1 },

  reason: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E7EBE9'
  },
  reasonText: { marginTop: 4, lineHeight: 20, color: colors.t1 },
  // 隐藏的测量层。
  //
  // 必须用 absolute + opacity 0 —— 换 display:none 或 height:0 都不行：
  // 那样它不参与布局，onTextLayout 根本不会触发，什么都量不到。
  // opacity 0 则照常走一遍布局，只是画出来透明。
  //
  // zIndex -1 是为了万一在某些机型上 opacity 没盖住，也压在内容下面。
  measure: { position: 'absolute', opacity: 0, zIndex: -1 },
  reasonEdit: { fontSize: 11, fontWeight: '600', color: colors.accent },
  // 展开/收起靠左对齐、紧贴正文：它是对这段文字的补充说明，
  // 居中或右对齐会让人以为是另一个功能入口
  reasonMoreWrap: { marginTop: 6, alignSelf: 'flex-start' },
  reasonMore: { fontSize: 12, fontWeight: '600', color: colors.accent },
  // 外距挂在这一层：里面的文字要能被 Pressable 的 hitSlop 一起放大
  noReasonWrap: { marginTop: 12 },
  noReason: { color: colors.t3 },

  // 「返回持仓」：右对齐的小胶囊，贴着卡片底边，不抢「卖出至今」那行的主角位
  actions: { marginTop: 12, flexDirection: 'row', justifyContent: 'flex-end' },
  restoreBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.line2
  },
  restoreText: { fontSize: 12, fontWeight: '600', color: colors.accent },
  soldOut: { marginTop: 12, textAlign: 'right', color: colors.t3 },

  empty: { paddingVertical: 60, alignItems: 'center', paddingHorizontal: 20 },
  emptyIcon: { fontSize: 40 },
  clearBtn: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: colors.line2
  },
  clearText: { fontSize: 13, fontWeight: '600', color: colors.accent }
})

module.exports = Archive
