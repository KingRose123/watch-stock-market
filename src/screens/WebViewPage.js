const React = require('react')
const { View, Text, Pressable, StyleSheet, Linking } = require('react-native')
const { WebView } = require('react-native-webview')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')

/**
 * 内置浏览器：看新闻原文。
 *
 * ⚠️ 这是**唯一**一个会加载外部网页的页面（其余页面全是自家接口），
 * 所以它有三条约束，别顺手放宽：
 *
 *  1. **只用来读**：没有地址栏、没有前进后退、不进历史。用户是从新闻列表
 *     点进来的，想做的只有"看看这条说了什么"。做成一个能自由浏览的浏览器，
 *     就等于在 App 里塞了一个来源不明的浏览器 —— 而它加载的页面我们控制不了。
 *  2. **只放行 http / https**（见 originWhitelist）。file:// 之类的没有理由
 *     出现在这里；写上白名单是"明确允许什么"，比黑名单可靠。
 *  3. **失败要有出口**：外部网页打不开是常事（对方挂了、证书过期、被墙）。
 *     那时给一个"在浏览器打开"，而不是让人对着白屏 —— 白屏看起来像 App 坏了。
 *
 * 参数（由 nav.js 从 /pages/webview/webview?url=…&title=… 解析过来）：
 *   url    要打开的地址，必填
 *   title  顶部标题，可空（新闻标题太长，只用来提示"在哪一条上"）
 */
class WebViewPage extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      url: '',
      title: '',
      loading: true,
      failed: false
    }
  }

  onLoad(options) {
    const o = options || {}
    const url = String(o.url || '').trim()

    // 标题截断：新闻标题多则二三十字，全塞进顶栏会挤成一团，
    // 而它的作用只是"让你知道自己在看哪一条"
    let title = String(o.title || '').trim()
    if (title.length > 16) title = title.slice(0, 16) + '…'

    this.setData({ url: url, title: title || '新闻详情' })
    wx.setNavigationBarTitle({ title: title || '新闻详情' })
  }

  /**
   * 用系统浏览器打开。
   *
   * WebView 里的失败**不重试**（用户点一下就重试一次，对着打不开的站没有意义），
   * 但给一条别的路：系统浏览器有缓存、有 cookie、有时反而能开 ——
   * 就算也开不了，至少用户知道不是 App 的问题。
   */
  openInBrowser() {
    const url = this.data.url
    if (!url) return
    // openURL 返回 Promise，失败（设备上没有浏览器之类）就静默 ——
    // 这里再弹一个错误提示只会让"打不开"这件事更啰嗦
    if (Linking && Linking.openURL) Linking.openURL(url).catch(() => {})
  }

  retry() {
    this.setData({ failed: false, loading: true })
  }

  render() {
    const url = this.data.url

    // ⚠️ 这里**不能**写 this.renderEmpty(...) —— 那个方法是 HoldingDetail 和
    // HoldingRecord 各自定义在自己类里的，MiniPage 基类上**没有**它。
    // 写成 this.renderEmpty 的话，url 为空时就是一个 TypeError，
    // 而它发生在 render 里 —— 表现是**整个页面崩掉**，不是"少一块内容"。
    //
    // 内联出来虽然多几行，但它不依赖"某个基类恰好提供了某个方法"这种
    // 看不见的约定。样式也是复用本文件已有的那套（box / emoji / msg / sub）。
    if (!url) {
      return (
        <View style={s.page}>
          <View style={styles.box}>
            <Text style={styles.emoji}>📄</Text>
            <Text style={[s.mid, styles.msg]}>没有可打开的链接</Text>
            <Text style={[s.small, s.dim, styles.sub]}>
              这条消息没有给原文地址，可能是一条公告摘要。
            </Text>
          </View>
        </View>
      )
    }

    if (this.data.failed) {
      return (
        <View style={s.page}>
          <View style={styles.box}>
            <Text style={styles.emoji}>📄</Text>
            <Text style={[s.mid, styles.msg]}>网页打不开</Text>
            <Text style={[s.small, s.dim, styles.sub]}>
              可能是对方的服务暂时不可用，或这条内容已经被撤下。
            </Text>
            <View style={s.row}>
              <Pressable style={styles.btn} onPress={() => this.retry()}>
                <Text style={styles.btnText}>重试</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => this.openInBrowser()}>
                <Text style={[styles.btnText, styles.btnGhostText]}>在浏览器打开</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )
    }

    return (
      <View style={s.page}>
        {/* 加载提示压在顶部而不是盖住整页：网页本身可能已经画出上半屏了，
            盖一层遮罩会让它闪一下 */}
        {this.data.loading ? <Text style={styles.tip}>正在打开…</Text> : null}

        <WebView
          source={{ uri: url }}
          style={styles.web}
          originWhitelist={['http://*', 'https://*']}
          // 不开新窗口：target=_blank 的链接一律在当前页打开 ——
          // 否则会弹出一个我们没有顶栏、退不回去的窗口
          setSupportMultipleWindows={false}
          onLoadStart={() => this.setData({ loading: true, failed: false })}
          onLoadEnd={() => this.setData({ loading: false })}
          onError={() => this.setData({ loading: false, failed: true })}
          onHttpError={() => this.setData({ loading: false, failed: true })}
        />
      </View>
    )
  }
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: colors.card },

  // 顶部一条细提示，不吃掉页面高度（绝对定位，不挤压 WebView）
  tip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    paddingVertical: 6,
    textAlign: 'center',
    fontSize: 12,
    color: colors.t3,
    backgroundColor: colors.line2
  },

  box: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 28 },
  emoji: { fontSize: 40 },
  msg: { marginTop: 14 },
  sub: { marginTop: 8, textAlign: 'center', lineHeight: 20 },

  btn: {
    marginTop: 20,
    marginHorizontal: 6,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: colors.accentSoft
  },
  btnText: { fontSize: 13.5, fontWeight: '600', color: colors.accent },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line2 },
  btnGhostText: { color: colors.t2 }
})

module.exports = WebViewPage
