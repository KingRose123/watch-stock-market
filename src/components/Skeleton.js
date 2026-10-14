const React = require('react')
const { View, Animated, Easing, StyleSheet } = require('react-native')
const { colors, s } = require('../theme.js')

/**
 * 骨架屏。
 *
 * 加载中的占位不是"转圈"而是**内容的形状**：一屏灰块先把版式立住，
 * 内容到了直接填进去。两者给用户的信息完全不同 ——
 * 转圈只说"在干活"，灰块说的是"马上会出现这样一屏东西"，
 * 而且从灰块到内容**不会跳版**，这是它比"加载中…"那句字最大的价值。
 *
 * 三条使用约定：
 *
 *  1. **每个页面自己拼骨架**（各写一个 renderSkeleton），不要做一个
 *     "通用骨架"：骨架的意义就是和真实版式对齐。通用骨架一旦和页面
 *     长得不一样，内容填进来时会跳一下，比不做还难看。
 *  2. **只盖"正在加载"的那几块**。页面里本来就写死的东西（品牌行、
 *     分段、搜索框、返回键）照常渲染 —— 整页变灰和"页面还没打开"没区别，
 *     而且用户会以为连按钮都点不了了。
 *  3. 只在**首屏还没有内容**时用。已经有内容了就别盖：刷新时用户看的是
 *     旧内容 + 下拉那个圈，把内容换成灰块等于告诉他"内容没了"。
 *
 * 这个模块只提供三个零件（Pulse / Block / Card），拼法是各页面自己的事。
 */

/**
 * 会呼吸的容器：整棵骨架子树共用一个透明度动画。
 *
 * 共用一个 Animated.Value，而不是每个灰块各起一个 loop：一屏骨架有十几块，
 * 十几次 loop 会让低端机在**最不该卡的时候**卡 —— 而"加载中卡顿"是最容易
 * 被记成"这 App 很卡"的。
 */
class Pulse extends React.Component {
  constructor(props) {
    super(props)
    this.v = new Animated.Value(0)
  }

  componentDidMount() {
    // useNativeDriver：动画跑在原生线程上，所以后面 JS 线程在解析内容、
    // 渲染新数据时也不会把它卡住 —— 而那正是这个动画唯一存在的时间段。
    const step = (to) =>
      Animated.timing(this.v, {
        toValue: to,
        duration: 700,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true
      })

    this.loop = Animated.loop(Animated.sequence([step(1), step(0)]))
    this.loop.start()
  }

  componentWillUnmount() {
    // 必须停。不停的话页面卸载后这个 loop 还在跑，每进一次页面多一个 ——
    // 表现是"用一会儿就越来越烫、越来越卡"，而且看不出是谁干的。
    if (this.loop) this.loop.stop()
  }

  render() {
    const opacity = this.v.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] })
    return (
      <Animated.View style={[this.props.style, { opacity: opacity }]}>{this.props.children}</Animated.View>
    )
  }
}

/**
 * 一个灰块。
 *
 * w / h 给数字＝像素，给字符串＝百分比（'60%'）；r 是圆角，默认 6。
 * 圆角要按它在真实版式里的样子给：头像给一半（18）、按钮给 13、
 * 图片块给 10 —— 骨架的"像"主要由圆角决定，全是直角会觉得是另一个页面。
 */
function Block(props) {
  const w = props.w === undefined ? '100%' : props.w
  const h = props.h === undefined ? 12 : props.h
  const r = props.r === undefined ? 6 : props.r
  return <View style={[styles.block, { width: w, height: h, borderRadius: r }, props.style]} />
}

/**
 * 白卡外壳。直接用 s.card，不自己写一份 ——
 * 圆角、内边距、阴影都在那里定，抄一份过来迟早会和真实卡片差几像素，
 * 而那正是"内容填进来时跳一下"的来源。
 */
function Card(props) {
  return <View style={[s.card, props.style]}>{props.children}</View>
}

const styles = StyleSheet.create({
  // 比底色深一档：骨架块大多落在白卡上，太浅会看不见（看不见的骨架
  // 比没有骨架更糟 —— 用户会以为页面是空的）。
  block: { backgroundColor: colors.line }
})

module.exports = { Pulse, Block, Card }
