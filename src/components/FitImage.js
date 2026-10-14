const React = require('react')
const { Image, StyleSheet } = require('react-native')

/**
 * 铺满宽度、高度**跟着图片自己的比例**走的图。
 *
 * 为什么需要它：给一个**固定高度**的框，配上 resizeMode="contain"，只要图的
 * 比例和框不一致就必然留白 —— 而 contain 又是"完整显示"的唯一选项。于是
 * "要看全"和"不要白边"只能靠**让框等于图的比例**同时满足，这需要一个知道
 * 图片真实尺寸的东西。
 *
 * 尺寸从 onLoad 事件的 `nativeEvent.source` 里拿（RN 两个平台都会给
 * BitmapFactory / CGImage 解出来的真实宽高）。首帧用一个兜底比例顶着：
 * 取 3:2，因为正文里的图以横图为主。真比例差得多的话，图片出现的那一帧会
 * 调整一次 —— 而那一帧本来就是图片刚解码完、正在上屏的时刻，实操上看不出来。
 *
 * ⚠️ 它只适合**详情页/阅读页**这类"图要完整、可以占满整宽"的位置。
 * 列表里的缩略图不要用它：那里要的是每张一样大的一排方格，
 * 这种随比例变高的图会把一行的对齐彻底打乱（见 Community.js 的 renderThumbs）。
 */
class FitImage extends React.Component {
  constructor(props) {
    super(props)
    // 0 ＝ 还没量到，用兜底比例顶着
    this.state = { ratio: 0 }
    this.alive = true
  }

  componentWillUnmount() {
    // onLoad / getSize 都是异步的，页面可能在它们回来之前就被卸载了
    this.alive = false
  }

  /** 量到比例后重算一次（已经是这个比例、或组件已卸载，就什么都不做）。 */
  apply(next) {
    if (!next || !isFinite(next) || next <= 0) return
    if (!this.alive) return
    const now = this.state.ratio || this.props.fallbackRatio || 1.5
    if (Math.abs(next - now) < 0.01) return
    this.setState({ ratio: next })
  }

  render() {
    const { url, style, fallbackRatio } = this.props
    const ratio = this.state.ratio || fallbackRatio || 1.5

    return (
      <Image
        source={{ uri: url }}
        style={[styles.img, { aspectRatio: ratio }, style]}
        // contain：比例已经等于图本身了，所以它既不会裁、也不会留白。
        // 留 contain 而不是 cover 是为了兜底 —— 万一尺寸没量出来，
        // 至少图是完整的，代价只是留一点边，而不是被裁掉一半内容。
        resizeMode="contain"
        onLoad={(e) => {
          const src = (e && e.nativeEvent && e.nativeEvent.source) || {}
          if (src.width && src.height) {
            this.apply(src.width / src.height)
            return
          }
          // 少数情况下 onLoad 只带 uri（各平台/版本给的信息不完全一样），
          // 那就再问一次尺寸。图此刻已经下载过了，这一次是读缓存，不会再下一遍。
          Image.getSize(
            url,
            (w, h) => this.apply(w / h),
            () => null // 还是拿不到就算了，继续用兜底比例（图完整、可能有边）
          )
        }}
      />
    )
  }
}

const styles = StyleSheet.create({
  // 宽度写死满宽，高度由 aspectRatio 推出来 —— 这是这套写法的前提
  img: { width: '100%' }
})

module.exports = FitImage
