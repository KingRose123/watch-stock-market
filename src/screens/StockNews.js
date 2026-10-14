const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const membership = require('../utils/membership.js')

/**
 * 个股新闻列表。
 *
 * ⚠️ 为什么单独一页、而不是塞在持仓详情里：
 * 详情页要回答的是"这只股票现在什么状态"（成本、息率、回本进度），
 * 那是一屏能看完的信息；而新闻是**会一直往下长**的一列 —— 混在一起的话，
 * 用户想看点别的都得先划过十条新闻。分开之后两边都干净：
 * 详情页放一个入口，这里专心看消息。
 *
 * ⚠️ 三种状态分开表达，不能都显示成"暂无"（与详情页原来那段同一个理由）：
 *   锁定  —— 非会员，给开通入口
 *   加载中 —— 给个占位，避免白屏
 *   空     —— 真的没有，写一句人话
 * 混成一个"暂无"的话，会员会以为功能坏了，而其实只是这只股票最近没事。
 *
 * 参数（由 nav.js 从 /pages/stock-news/stock-news?code=… 解析过来）：
 *   code / market  标的（公告按"代码 + 市场"查）
 *   name           只用来当标题，可空
 */
class StockNews extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      locked: false,
      list: [],
      code: '',
      market: ''
    }
  }

  onLoad(options) {
    const o = options || {}
    const code = String(o.code || '').trim().toUpperCase()
    const market = String(o.market || '').trim()
    const name = String(o.name || '').trim()

    // 顶栏带上股票名，让用户明确自己看的是哪一只 ——
    // 从详情页点进来时他没有"这是谁的新闻"这个上下文
    wx.setNavigationBarTitle({ title: (name || code || '') + ' 新闻' })

    this.setData({ code: code, market: market })
    this.load(code, market)
  }

  load(code, market) {
    if (!code) {
      this.setData({ loading: false, list: [] })
      return
    }

    // 非会员：不发请求，就地显示开通引导。
    // 服务端也会拦（402），但那一层是防绕过，不是给正常人看的。
    if (!membership.current().isPaid) {
      this.setData({ loading: false, locked: true, list: [] })
      return
    }

    this.setData({ loading: true, locked: false })
    api
      .getStockNews(code, market)
      .then((res) => this.setData({ loading: false, list: res.data || [] }))
      .catch((e) => {
        // 取不到就显示空态，不显示错误：一条"加载失败"的红字比没有新闻更让人在意。
        // 唯一例外是 402（会员可能刚到期），那种要走统一的开通引导。
        this.setData({ loading: false, list: [] })
        if (e && e.code === 402) util.onError(e)
      })
  }

  /**
   * 点一条新闻：在内置浏览器里看原文（见 screens/WebViewPage.js）。
   *
   * ⚠️ 标题一起传：内置浏览器的顶栏只显示截断版，但至少让用户知道
   * 自己在看哪一条 —— 顶栏只写"新闻详情"就成了一个不知道从哪来的页面。
   */
  openNews(ev) {
    const ds = (ev && ev.currentTarget && ev.currentTarget.dataset) || {}
    const url = ds.url || ''
    if (!url) {
      wx.showToast({ title: '这条没有原文链接', icon: 'none' })
      return
    }
    wx.navigateTo({
      url:
        '/pages/webview/webview?url=' +
        encodeURIComponent(url) +
        '&title=' +
        encodeURIComponent(ds.title || '')
    })
  }

  renderItem(n, i) {
    return (
      <Pressable
        key={n.id || i}
        style={[styles.card, styles.item]}
        onPress={() => this.openNews(tapFor(n))}
      >
        <View style={s.row}>
          {/* 标签按 kind 取。
              'industry' 是**行业新闻**，不是"政策" —— 内容是行业动态
              （新规、龙头动向、行业数据），比如「白酒股走弱」。后端把值从
              'policy' 改成了 'industry'（关键词现在来自持仓股票的行业，
              不再由运营手填），老数据由 migrations.sql 的 v7 一并迁走。 */}
          <Text style={[styles.tag, n.kind === 'ann' ? styles.tagAnn : styles.tagNews]}>
            {n.kind === 'ann' ? '公告' : n.kind === 'industry' ? '行业' : '资讯'}
          </Text>
          <Text style={[s.tiny, s.dim, { marginLeft: 6 }]}>{n.date || ''}</Text>
          {n.pinned ? <Text style={styles.pin}>置顶</Text> : null}
        </View>

        <Text style={styles.title}>{n.title}</Text>

        {/* 摘要只有资讯有（公告上游不给），所以按"有没有"决定渲不渲染 ——
            截出来的话公告会多出一块空白 */}
        {n.summary ? (
          <Text style={[s.small, s.dim, styles.summary]} numberOfLines={3}>
            {n.summary}
          </Text>
        ) : null}

        {/* 上游给的分类（业绩预告、股东变动…）—— 它是筛"值得看一眼"的依据，
            所以单独一行，而不是塞进标题里 */}
        {n.tag ? <Text style={styles.meta}>{n.tag}</Text> : null}
      </Pressable>
    )
  }

  render() {
    const list = this.data.list
    const locked = this.data.locked

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={styles.content}>
          {locked ? (
            <View style={[styles.card, styles.box]}>
              <Text style={styles.boxEmoji}>📰</Text>
              <Text style={[s.mid, styles.boxTitle]}>个股新闻是会员功能</Text>
              <Text style={[s.small, s.dim, styles.boxSub]}>
                持仓股票的公告、资讯和行业政策会集中在这里，随时看到可能影响判断的消息。
              </Text>
              <Pressable
                style={styles.btn}
                onPress={() => wx.navigateTo({ url: '/pages/membership/membership' })}
              >
                <Text style={styles.btnText}>开通会员查看</Text>
              </Pressable>
            </View>
          ) : null}

          {!locked && !this.data.loading && !list.length ? (
            <View style={[styles.card, styles.box]}>
              <Text style={styles.boxEmoji}>📭</Text>
              <Text style={[s.mid, styles.boxTitle]}>最近没有新消息</Text>
              <Text style={[s.small, s.dim, styles.boxSub]}>
                抓取任务每天会更新几次，有新的公告或报道时这里会出现。
              </Text>
            </View>
          ) : null}

          {list.map((n, i) => this.renderItem(n, i))}
        </ScrollView>
      </View>
    )
  }
}

/**
 * 把一条新闻包成小程序的事件形状。
 *
 * ⚠️ 单独一个函数而不是各写一遍：openNews 读的是 dataset，
 * 而 RN 的 Pressable 没有 dataset —— 少包这一层的话，
 * 点下去 url 恒为 undefined，表现是"点了没反应"。
 */
function tapFor(n) {
  return { currentTarget: { dataset: { url: n.url || '', title: n.title || '' } } }
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30 },

  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10
  },

  item: { paddingVertical: 14 },

  // 类型标签：公告用主色（最该看的那类），资讯和政策用暖色。
  // 合成一个颜色的话，一屏里就看不出哪条是公告了。
  tag: {
    fontSize: 11,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden'
  },
  tagAnn: { color: colors.accent, backgroundColor: colors.accentA10 },
  tagNews: { color: colors.gold, backgroundColor: colors.warm },

  pin: { marginLeft: 6, fontSize: 11, color: colors.orange },

  title: { marginTop: 8, fontSize: 15, lineHeight: 23, color: colors.t1, fontWeight: '500' },
  summary: { marginTop: 6, lineHeight: 19 },
  meta: { marginTop: 8, fontSize: 11.5, color: colors.t3 },

  box: { alignItems: 'center', paddingVertical: 34, paddingHorizontal: 20 },
  boxEmoji: { fontSize: 36 },
  boxTitle: { marginTop: 12 },
  boxSub: { marginTop: 8, textAlign: 'center', lineHeight: 20 },
  btn: {
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: colors.accentSoft
  },
  btnText: { fontSize: 13.5, fontWeight: '600', color: colors.accent }
})

module.exports = StockNews
