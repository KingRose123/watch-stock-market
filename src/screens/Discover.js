const React = require('react')
const {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  StyleSheet,
  RefreshControl
} = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')
const skel = require('../components/Skeleton.js')

// 工具落点表已提到 utils/toolRoutes.js —— 文章页和社区详情页都要用同一份，
// 留在这里就必然会多出两份复制（理由见那个文件的注释）。
const { goTool } = require('../utils/toolRoutes.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

class Discover extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      // 首屏还在取数（决定要不要画骨架，见 firstLoad）
      loading: true,
      // 下拉刷新中。只驱动那个转圈，页面上的内容照旧显示（见 fetch）
      refreshing: false,
      tools: [],
      ranks: [],
      articles: [],

      searchOpen: false,
      keyword: '',
      results: [],
      noResult: false
    }
  }

  onLoad() {
    this.load()
  }

  load() {
    return this.fetch(false)
  }

  /** 下拉刷新（挂在 ScrollView 的 refreshControl 上）。 */
  onRefresh() {
    return this.fetch(true)
  }

  /** 首屏还没有任何内容 —— 正在画骨架（同首页，见 Community.js 的那段说明）。 */
  firstLoad() {
    return !!this.data.loading && !(this.data.tools || []).length
  }

  /**
   * 取发现页内容。
   *
   * @param byPull 是不是用户下拉触发的
   *
   * 与首页同一条规矩：**下拉失败时保住原来那份内容**，只弹一句错误。
   * 把用户已经看到的内容清空，是一次失败能造成的最坏结果。
   */
  fetch(byPull) {
    if (byPull) this.setData({ refreshing: true })

    return api
      .getDiscover()
      .then((res) => {
        this.setData(Object.assign({ loading: false, refreshing: false }, res.data))
      })
      .catch((err) => {
        // 失败也要把 loading 落下来，否则骨架会一直呼吸下去
        this.setData({ loading: false, refreshing: false })
        util.onError(err)
      })
  }

  onTool(e) {
    goTool(e.currentTarget.dataset.id)
  }

  onRank(e) {
    wx.navigateTo({ url: '/pages/rank/rank?type=' + e.currentTarget.dataset.id })
  }

  onArticle(e) {
    wx.navigateTo({ url: '/pages/article/article?id=' + e.currentTarget.dataset.id })
  }

  /* ---------------- 跨市场搜索 ---------------- */

  onSearch() {
    this.setData({ searchOpen: true, keyword: '', results: [], noResult: false })
  }

  closeSearch() {
    if (this.data.searchOpen) this.setData({ searchOpen: false })
  }

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })

    // 搜索走真实接口，防抖一下，避免每敲一个字都打一次请求
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null
      this.doSearch()
    }, 300)
  }

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
  }

  doSearch() {
    const kw = String(this.data.keyword).trim()
    this.searchSeq = (this.searchSeq || 0) + 1
    const seq = this.searchSeq

    if (!kw) {
      this.setData({ results: [], noResult: false })
      return
    }

    api
      .searchAllStocks(kw)
      .then((res) => {
        if (seq !== this.searchSeq) return
        this.setData({ results: res.data, noResult: res.data.length === 0 })
      })
      .catch(util.onError)
  }

  onPickStock(e) {
    const ds = e.currentTarget.dataset
    this.setData({ searchOpen: false })
    wx.navigateTo({
      url: '/pages/add-holding/add-holding?code=' + ds.code + '&market=' + (ds.market || '')
    })
  }

  /* ---------------- 渲染 ---------------- */

  renderTools() {
    return (
      <View style={styles.cardRow}>
        {this.data.tools.map((t) => (
          <Pressable key={t.id} style={styles.toolCard} onPress={() => this.onTool(tap({ id: t.id }))}>
            <Text style={styles.toolIcon}>{t.icon}</Text>
            <Text style={[s.small, s.bold, { marginTop: 8 }]}>{t.name}</Text>
            <Text style={[s.tiny, s.dim, { marginTop: 4, textAlign: 'center' }]}>{t.desc}</Text>
          </Pressable>
        ))}
      </View>
    )
  }

  renderRanks() {
    return (
      <View style={{ marginTop: 20 }}>
        <Text style={[s.h2, { marginBottom: 12 }]}>榜单</Text>
        {this.data.ranks.map((r) => (
          <Pressable key={r.id} style={[s.card, { marginBottom: 12 }]} onPress={() => this.onRank(tap({ id: r.id }))}>
            <View style={s.between}>
              <View style={s.row}>
                <View style={[styles.iconBox, styles.iconSoftGold]}>
                  <Text style={styles.iconText}>{r.icon}</Text>
                </View>
                <View style={{ marginLeft: 10 }}>
                  <View style={s.row}>
                    <Text style={s.bold}>{r.name}</Text>
                    {r.badge ? <Text style={[s.tag, styles.badge, { marginLeft: 8 }]}>{r.badge}</Text> : null}
                  </View>
                  {/* 有副标题才渲染这一行。
                      写成 {r.subText || ''} 的话，空值也会**占掉一整行的高度** ——
                      卡片被凭空撑高，可见内容被顶到上半部、下面留一片空白。 */}
                  {r.subText ? <Text style={[s.tiny, s.dim, { marginTop: 5 }]}>{r.subText}</Text> : null}
                </View>
              </View>
              <Text style={s.dim}>›</Text>
            </View>
          </Pressable>
        ))}
      </View>
    )
  }

  renderArticles() {
    return (
      <View style={{ marginTop: 20 }}>
        <Text style={[s.h2, { marginBottom: 12 }]}>收息小课</Text>
        {this.data.articles.map((a) => (
          <Pressable key={a.id} style={[s.card, { marginBottom: 12 }]} onPress={() => this.onArticle(tap({ id: a.id }))}>
            <View style={s.row}>
              <View style={[styles.iconBox, styles.iconSoftGray, { marginRight: 12 }]}>
                <Text style={styles.iconText}>{a.icon || '📖'}</Text>
              </View>
              <View style={s.flex1}>
                <Text style={s.bold}>{a.title}</Text>
                {/* 同 renderRanks：空值不要占位 */}
                {a.desc ? <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>{a.desc}</Text> : null}
              </View>
            </View>
          </Pressable>
        ))}
      </View>
    )
  }

  /**
   * 首屏骨架。形状照抄这页的版式：工具格 → 榜单 → 收息小课。
   *
   * 搜索框**不盖骨架** —— 它是写死的，而且用户一进来就想点它（见 render）。
   */
  renderSkeleton() {
    return (
      <skel.Pulse>
        {/* 工具格：一行四个 */}
        <View style={s.row}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[s.flex1, i ? { marginLeft: 8 } : null]}>
              <skel.Block w="100%" h={94} r={16} />
            </View>
          ))}
        </View>

        {/* 榜单 */}
        <skel.Block w={56} h={16} style={{ marginTop: 24, marginBottom: 12 }} />
        {[0, 1, 2].map((i) => (
          <skel.Card key={i} style={{ marginBottom: 12 }}>
            <View style={s.row}>
              <skel.Block w={40} h={40} r={12} />
              <View style={[s.flex1, { marginLeft: 10 }]}>
                <skel.Block w="42%" h={14} />
                <skel.Block w="66%" h={11} style={{ marginTop: 8 }} />
              </View>
            </View>
          </skel.Card>
        ))}

        {/* 收息小课 */}
        <skel.Block w={72} h={16} style={{ marginTop: 12, marginBottom: 12 }} />
        {[0, 1].map((i) => (
          <skel.Card key={i} style={{ marginBottom: 12 }}>
            <View style={s.row}>
              <skel.Block w={40} h={40} r={12} />
              <View style={[s.flex1, { marginLeft: 12 }]}>
                <skel.Block w="70%" h={14} />
                <skel.Block w="88%" h={11} style={{ marginTop: 8 }} />
              </View>
            </View>
          </skel.Card>
        ))}
      </skel.Pulse>
    )
  }

  render() {
    // 首屏还没有内容 → 画骨架（说明同首页，见 Community.js 的 render）
    const firstLoad = this.firstLoad()

    return (
      <View style={s.page}>
        <ScrollView
          contentContainerStyle={s.content}
          refreshControl={
            <RefreshControl
              refreshing={this.data.refreshing}
              onRefresh={() => this.onRefresh()}
              tintColor={colors.accent}
              colors={[colors.accent]}
              progressBackgroundColor={colors.card}
            />
          }
        >
          <Pressable style={styles.searchBar} onPress={() => this.onSearch()}>
            <Text style={[s.small, s.dim]}>🔍 搜索代码 / 名称 / 拼音</Text>
          </Pressable>

          {firstLoad ? (
            this.renderSkeleton()
          ) : (
            <React.Fragment>
              {this.renderTools()}
              {this.renderRanks()}
              {this.renderArticles()}
            </React.Fragment>
          )}
        </ScrollView>

        {/* 跨市场搜索 */}
        <Modal visible={this.data.searchOpen} animationType="slide" onRequestClose={() => this.closeSearch()}>
          <View style={[s.page, { paddingTop: 40 }]}>
            <View style={styles.searchHead}>
              <TextInput
                style={[s.input, s.flex1]}
                value={this.data.keyword}
                onChangeText={(v) => this.onSearchInput(val(validate.plain(v, { max: 20 })))}
                placeholder="输入代码 / 名称 / 拼音首字母"
                placeholderTextColor={colors.t3}
                autoFocus
              />
              <Pressable onPress={() => this.closeSearch()} style={{ marginLeft: 12 }}>
                <Text style={{ color: colors.accent, fontSize: 15 }}>取消</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}>
              {this.data.results.map((item) => (
                <Pressable
                  key={item.market + '-' + item.code}
                  style={styles.resultRow}
                  onPress={() => this.onPickStock(tap({ code: item.code, market: item.market }))}
                >
                  <View style={s.flex1}>
                    <Text style={s.mid}>{item.name}</Text>
                    <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>{item.code}</Text>
                  </View>
                  <Text style={[s.tiny, s.dim]}>{item.marketTag}</Text>
                </Pressable>
              ))}

              {this.data.noResult ? (
                <Text style={[s.small, s.dim, { marginTop: 20 }]}>没搜到，换个关键词试试</Text>
              ) : null}
            </ScrollView>
          </View>
        </Modal>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  searchBar: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginBottom: 16
  },
  cardRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  toolCard: {
    width: '48%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 20,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginBottom: 12
  },
  // 工具卡：emoji 的默认行高比字号大，会让图标在行里偏下；锁行高 + 1px 下移压回视觉中线
  toolIcon: { fontSize: 26, lineHeight: 30, transform: [{ translateY: 1 }] },
  badge: { backgroundColor: colors.accentSoft, color: colors.accent },
  // 榜单 / 收息小课行的图标：与小程序 .icon-box（56rpx≈28px、圆角 16rpx≈8px、浅金/浅灰底）
  // 一致，用固定容器兜住 emoji 并居中，避免裸 emoji 因行高/基线不同而与右侧文字不齐。
  //
  // ⚠️ 不要给这个方块加 translateY 上移。这里曾经有个 -11，是为了在
  // 「标题 + 一行空副标题」的情况下把方块顶到标题那一行 —— 那个偏移把方块
  // 整个推出了行中线，在卡片里看起来就是内容整体偏上。
  // 空副标题已经不占位了（见 render 里的条件渲染），方块交给 alignItems: center
  // 正常居中即可。
  iconBox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconSoftGold: { backgroundColor: 'rgba(217, 169, 60, 0.14)' },
  iconSoftGray: { backgroundColor: '#F3F5F4' },
  // 方块内的 emoji 重心偏下（原生 Text 渲染，方向与小程序的 WebView 相反），
  // 补 2px 压回方块的视觉中线。
  iconText: { fontSize: 15, lineHeight: 15, transform: [{ translateY: -2 }] },
  searchHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 14 },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  }
})

module.exports = Discover
