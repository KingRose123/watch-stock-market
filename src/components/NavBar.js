const React = require('react')
const { View, Text, Pressable, StyleSheet } = require('react-native')
const { useSafeAreaInsets } = require('react-native-safe-area-context')
const nav = require('../compat/nav.js')
const { colors } = require('../theme.js')

/**
 * 自绘顶部标题条。
 *
 * 为什么不用 navigation 自己的 header：native-stack 的 header 高度是原生定的
 * （iOS 44pt、Android 56dp），headerStyle 里写 height 无效，压不矮。
 * 所以这里全局关掉原生 header，改由 JS 画一条：状态栏占位 + 固定 BAR_H 的标题区。
 *
 * 标题来源两条路：
 *   1. 初始标题：由 App.js 按路由名传进来（对应小程序各页 json 的 navigationBarTitleText）
 *   2. 运行时改：页面调 wx.setNavigationBarTitle → compat/nav.js 的 setTitle，
 *      这里按 route.name 订阅，Doc / Tool / Rank 之类动态改标题的页面照样生效
 *
 * ⚠️ 只用在**栈内页**上。一级页面（底部 tab 的根页）不用它 ——
 * 原因见下面 canBack 那段。
 */
const BAR_H = 42

function NavBar({ route, navigation, initialTitle }) {
  const insets = useSafeAreaInsets()
  const name = (route && route.name) || ''
  const [title, setTitle] = React.useState(initialTitle || '')

  // 同一个组件实例可能被复用到不同标题的路由上（行程 momo 缓存的那层），以传入值为准
  React.useEffect(() => {
    setTitle(initialTitle || '')
  }, [initialTitle])

  React.useEffect(() => {
    if (!name) return undefined
    return nav.onTitle(name, (t) => setTitle(t))
  }, [name])

  /**
   * 只在页面栈里真有上一层时才画返回键。
   *
   * ⚠️ navigation.canGoBack() 在 **tab 页**上答的不是这件事：那时的 navigation
   * 是 Tab navigator 的，它问的是「当前 tab 是不是第一个」—— 切到持仓（index 1）
   * 就返回 true。所以一级页面**根本不挂这条栏**（见 App.js 的 withBar），
   * 否则四个 tab 里除了首页每一个都会多出一个返回键，而点下去是 Tab 的
   * goBack()，行为是跳回首页 —— 跟"上一页"毫无关系。这个坑已经踩过一次。
   *
   * 换句话说：能走到这里的一定是栈内页，canGoBack() 的语义才是对的。
   */
  const canBack = !!(navigation && navigation.canGoBack && navigation.canGoBack())

  return (
    <View style={[styles.wrap, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <View style={styles.side}>
          {canBack ? (
            <Pressable onPress={() => navigation.goBack()} hitSlop={12} style={styles.back}>
              <View style={styles.chev} />
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>

        {/* 右侧占位：宽度与左侧一致，标题才是真居中 */}
        <View style={styles.side} />
      </View>
      <View style={styles.line} />
    </View>
  )
}

const styles = StyleSheet.create({
  // 白条 + 浅灰底本来就有色差，但在浅色页面里几乎看不出来，
  // 所以补一条稍深的 1px 线和一点下拉阴影，让「栏 / 内容」的边界站得住
  wrap: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#16241D',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 3
  },
  bar: {
    height: BAR_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12
  },
  side: { width: 60, flexDirection: 'row' },
  back: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  // 两条边旋转 45°：比字体里的 ‹ 更可控，粗细颜色都跟 title 一致
  chev: {
    width: 11,
    height: 11,
    marginLeft: 4,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.t1,
    transform: [{ rotate: '45deg' }]
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '500',
    color: colors.t1
  },
  line: { height: StyleSheet.hairlineWidth, backgroundColor: '#E2E7E5' }
})

module.exports = { NavBar, BAR_H }
