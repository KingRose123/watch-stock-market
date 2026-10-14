const React = require('react')
const { Svg, Path, Circle, Line, Polygon } = require('react-native-svg')

/**
 * 矢量图标。
 *
 * ══ 为什么是 SVG，而不是图标字体 ══
 *
 * 首选本来是 @expo/vector-icons（图标字体），但**这个 dev client 用不了**：
 * 它打包时没有把 expo-asset / expo-font 编进原生侧，字体在运行时下载不下来。
 * 证据在 android/build/generated/autolinking/autolinking.json —— 那是已装 APK
 * 的原生包清单，里面查得到 react-native-svg，查不到 expo-asset 和 expo-font。
 *
 * 表现还很隐蔽：图标字的组件在字体没就绪时只渲染一个空 Text，所以界面上
 * 就是"那块地方是空的"—— 不报错、不红屏、日志里也没有异常。最后是靠
 * 显式调 Font.loadAsync 把 reject 打出来才定位到：
 *
 *     Module 'expo.modules.interfaces.filesystem.AppDirectories' not found
 *
 * 而 react-native-svg **已经在那个包里**，纯矢量绘制，不依赖任何运行时下载，
 * 所以这条路不受影响。（等 dev client 重新构建之后，想换回图标字体也可以，
 * 但没必要 —— 见下。）
 *
 * ══ 这里的路径是"现成的设计稿"，不是拿边框拼的 ══
 *
 * 全部取自 Feather Icons（MIT）：统一的 24×24 网格、2px 描边、圆角端点与
 * 圆角连接。这一点很关键 —— 之前用 View 的边框拼方块和三角，问题不在形状
 * 本身，而在于**笔画粗细和对齐对不上**，几个图标放一起就露怯。用同一套
 * 网格数据画出来，它们天然是齐的。
 */

// Feather 的统一描边参数。线条图标全靠它保持一致：换掉这一个值，
// 整套图标的轻重会一起变，不会出现这个粗那个细。
const STROKE = 2
const LINE_CAP = 'round'
const LINE_JOIN = 'round'

/**
 * @param name    close | star | share
 * @param size    边长（默认 22）
 * @param color   描边与填充色
 * @param filled  仅 star 用：true 画实心（已收藏），false 画空心
 */
function Icon(props) {
  const size = props.size || 22
  const color = props.color || '#111214'
  const stroke = { stroke: color, strokeWidth: STROKE, strokeLinecap: LINE_CAP, strokeLinejoin: LINE_JOIN }
  const box = { width: size, height: size, viewBox: '0 0 24 24' }

  if (props.name === 'close') {
    // Feather 的 x：两条对角线
    return (
      <Svg {...box}>
        <Line x1="18" y1="6" x2="6" y2="18" {...stroke} />
        <Line x1="6" y1="6" x2="18" y2="18" {...stroke} />
      </Svg>
    )
  }

  if (props.name === 'star') {
    // Feather 的 star。实心与空心是**同一条路径**，只切 fill ——
    // 所以选中前后轮廓完全重合，不会有"实心版比空心版胖一圈"的错觉
    return (
      <Svg {...box}>
        <Polygon
          points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
          fill={props.filled ? color : 'none'}
          {...stroke}
        />
      </Svg>
    )
  }

  // Feather 的 share-2：三个节点用两条连线串起来，是"分享出去"最通用的画法
  return (
    <Svg {...box}>
      <Circle cx="18" cy="5" r="3" fill="none" {...stroke} />
      <Circle cx="6" cy="12" r="3" fill="none" {...stroke} />
      <Circle cx="18" cy="19" r="3" fill="none" {...stroke} />
      <Line x1="8.59" y1="13.51" x2="15.42" y2="17.49" {...stroke} />
      <Line x1="15.41" y1="6.51" x2="8.59" y2="10.49" {...stroke} />
    </Svg>
  )
}

module.exports = Icon
