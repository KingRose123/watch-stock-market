const React = require('react')
const { View, Text, Pressable, StyleSheet, Animated, Easing, Platform } = require('react-native')
const { BlurView } = require('expo-blur')
const { useSafeAreaInsets } = require('react-native-safe-area-context')

const { colors } = require('../theme.js')
const TabIcon = require('./TabIcon.js')

/**
 * 悬浮式底部导航栏。
 *
 * 与原生 tabBar 的三点不同：
 *   1. 悬浮：整条从页面流里脱出来 —— 四周留边、底部还留一道缝隙，
 *      内容会从它下面滚过去。各页已经预留了 paddingBottom（见 theme.s.content），
 *      所以最后一屏不会被压住。
 *   2. 毛玻璃：用 BlurView 让下方内容透出模糊轮廓，而不是盖一块实心白。
 *      Android 上必须显式给 experimentalBlurMethod，否则 BlurView 会退化成
 *      半透明色块（Android 12 以下没有系统级模糊，那时它就是这个观感）。
 *   3. 划过动效：选中项背后是一枚高光胶囊，切换时从旧位置滑到新位置 ——
 *      像是有一块玻璃在栏上滑过去。
 *
 * 图标沿用 TabIcon（与小程序同一套画法），文案与顺序仍以 App.js 的 TAB_LIST 为准。
 */

// 胶囊滑动的时长与缓动：320ms + ease-out，快起步慢收尾，滑到位时不生硬
const SLIDE_MS = 320

// inner 的左右内边距。这里提成常量是因为胶囊要用到它两次：
//   1) 起点偏移（glass.left）—— 胶囊坐标是在 inner 的 padding box 里算的；
//   2) 每格宽度要扣掉两侧 padding。
// 之前 left 写死 6、格宽却拿 barWidth 整宽均分，两者口径不一致，
// 于是滑块从第 2 格起就开始向右偏，越靠右偏得越多。
const INNER_PAD = 6

function FloatingTabBar(props) {
  const { state, descriptors, navigation } = props
  const insets = useSafeAreaInsets()

  // 栏内可排布的宽度（onLayout 拿到后才好算每格多宽）
  const [barWidth, setBarWidth] = React.useState(0)

  // 用一个「第几格」的动画值驱动胶囊位移：直接对像素做动画的话，
  // 旋转屏或字号变化后要重算，而按格数插值天然自适应。
  const slide = React.useRef(new Animated.Value(state.index)).current

  React.useEffect(() => {
    Animated.timing(slide, {
      toValue: state.index,
      duration: SLIDE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    }).start()
  }, [state.index, slide])

  // 图标名由调用方给（App.js 的 TAB_LIST），顺序与 routes 一致
  const icons = props.icons || TAB_ICONS

  const count = state.routes.length
  // 每格宽度 = 内容区宽度 / 格数，必须扣掉 inner 的左右 padding。
  // 用 barWidth / count 的话每格多算 12/count，误差逐格累加：
  // 第 1 格只偏 1.5dp（看着正常），最后一格能偏出 10dp 以上。
  const itemWidth = barWidth ? (barWidth - INNER_PAD * 2) / count : 0

  const translateX = itemWidth
    ? slide.interpolate({
        inputRange: [0, Math.max(1, count - 1)],
        outputRange: [0, itemWidth * Math.max(1, count - 1)]
      })
    : 0

  return (
    <View
      style={[styles.host, { paddingBottom: Math.max(insets.bottom, 10) }]}
      pointerEvents="box-none"
    >
      <View style={styles.shadowWrap}>
        <BlurView
          // Android 的模糊要显式开：dimezisBlurView 是 expo-blur 自带的实现，
          // 在系统不支持 RenderEffect 的机型上会自动退回半透明，不会崩
          experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
          intensity={Platform.OS === 'android' ? 70 : 45}
          tint="light"
          style={styles.blur}
        >
          <View style={styles.inner} onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}>
            {/* 划过的高光胶囊：位置由 slide 驱动，宽度恒等于一格 */}
            {itemWidth ? (
              <Animated.View
                pointerEvents="none"
                style={[styles.glass, { width: itemWidth, transform: [{ translateX }] }]}
              >
                <View style={styles.glassBody} />
              </Animated.View>
            ) : null}

            {state.routes.map((route, index) => {
              const focused = state.index === index
              const opts = descriptors[route.key].options || {}
              const label = opts.title || route.name
              const color = focused ? colors.accent : colors.t3

              const onPress = () => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true
                })
                if (!focused && !event.defaultPrevented) {
                  navigation.navigate(route.name)
                }
              }

              return (
                <Pressable
                  key={route.key}
                  style={({ pressed }) => [styles.item, pressed ? styles.itemPressed : null]}
                  onPress={onPress}
                >
                  <TabIcon name={icons[index]} color={color} />
                  <Text style={[styles.label, { color }]} numberOfLines={1}>
                    {label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </BlurView>
      </View>
    </View>
  )
}

// 与 App.js 的 TAB_LIST 一一对应（顺序即图标顺序）。
// 实际总是由调用方通过 icons 覆盖，这里只是没有 props 时的兜底，但也要对齐 ——
// 兜底值一旦过期，某些边缘渲染路径下会画出错误的图标，且很难联想到是这里。
const TAB_ICONS = ['feed', 'bars', 'compass', 'user']

const styles = StyleSheet.create({
  // 悬浮层：不吃点击（内容能滚过去），只有里面的栏能点
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 14
  },

  // 阴影得由外层带：BlurView 要 overflow:hidden 才能裁圆角，
  // 而被裁掉之后 iOS 的阴影就没了，所以分成两层
  shadowWrap: {
    borderRadius: 22,
    backgroundColor: 'transparent',
    ...Platform.select({
      ios: {
        shadowColor: '#0B1F17',
        shadowOpacity: 0.14,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 }
      },
      android: { elevation: 12 }
    })
  },

  blur: {
    borderRadius: 22,
    overflow: 'hidden',
    // 半透明白是底色，模糊负责把下面的内容揉开
    backgroundColor: 'rgba(255,255,255,0.62)',
    borderWidth: StyleSheet.hairlineWidth,
    /**
     * ⚠️ 这条边**必须带一点暗色**，不能用白色。
     *
     * 原来是 rgba(255,255,255,0.75)——在白卡上是**完全看不见**的。而浅色恰恰是
     * 最常见的情况：首页/持仓页的白色卡片滚到这里时，栏底本身（62% 白 + 模糊
     * 白色）也变成白的，边框再是白的，整条栏就和卡片糊成一片、边界消失。
     * 指不上 Android 的 elevation 兜底：它的阴影比 iOS 淡得多，白底上几乎看不出。
     *
     * 换成一点暗色之后，白卡上、浅灰底图上都成立。透明度压得很低，
     * 描边只负责"分层"，不会让毛玻璃显脏。
     *
     * 用中性暗色而非主题色：三种皮肤都是浅底、深字，这条边对谁都成立，
     * 不必跟着换肤走（配色板里也没有"深色细边"这个档位）。
     */
    borderColor: 'rgba(17,25,38,0.10)'
  },

  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 58,
    paddingHorizontal: INNER_PAD
  },

  // 高光胶囊
  glass: {
    position: 'absolute',
    top: 5,
    bottom: 5,
    // 绝对定位以父级 padding box 为基准，所以要跳过左侧 padding 才对齐内容区起点
    left: INNER_PAD,
    alignItems: 'center',
    justifyContent: 'center'
  },
  glassBody: {
    flex: 1,
    alignSelf: 'stretch',
    marginHorizontal: 5,
    borderRadius: 17,
    /**
     * 选中格：一整块**不透明**的浅强调色，且**不带阴影**。
     *
     * 这里踩过两个坑，都是"颜色怎么调都不匀"的原因：
     *
     *   1. **半透明底 + elevation**（同时占了这两条）。Android 会把 elevation 的
     *      阴影从**半透明底下面**透出来 —— 块里糊出一片偏灰、深浅不匀、形状还带
     *      直角的区域，选中格尤其明显。theme.js 里 colors.card 那段写的就是这件事
     *      （"卡片一律不透明…一旦填充透光，阴影就会从内部渗出来"）。我犯的正是
     *      它警告过的那一条，只不过是在导航栏上。
     *   2. 只去掉阴影、仍保留半透明 —— 颜色还是会随底下那层模糊内容轻微变化，
     *      凑近看依然"不是同一个色"。
     *
     * 现在两头都断掉：不透明底色（accentSoft，配色板里现成的浅强调色）
     * ＋ 不带任何阴影。颜色与底下是什么完全无关，整块就是一个色值。
     *
     * 顺带说明：不要给它加阴影。选中态是靠胶囊**滑过去**表达的，
     * 它不需要"浮起来"，一浮就又回到了上面第 1 条。
     */
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentA30,
    borderWidth: StyleSheet.hairlineWidth,
    // 顶部一道白色细边 = 玻璃上沿的反光。项目里没有渐变库（不为这一处加依赖），
    // 用一条 hairline 白边代替渐变高光 —— 它只占 1 像素的边缘，不影响块内颜色一致。
    borderTopColor: 'rgba(255,255,255,0.85)',
    /**
     * 高光：一层柔和的强调色投影，让选中格"浮"在毛玻璃之上。
     *
     * ⚠️ 这一层**只有在底色不透明时**才成立 —— 上面那条注释记的坑就是
     * "半透明底 + elevation"：阴影会从底下透出来，把块糊成深浅不匀的灰色。
     * 底色换成 accentSoft（不透明）之后，阴影就只落在块的**外面**了。
     * 所以这两条是绑在一起的：**要么都不加，要么底色必须不透明**。
     */
    ...Platform.select({
      ios: {
        shadowColor: colors.accent,
        shadowOpacity: 0.18,
        shadowRadius: 9,
        shadowOffset: { width: 0, height: 3 }
      },
      android: { elevation: 3 }
    })
  },

  item: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center'
  },
  /**
   * 按下反馈：**用透明度，不用 android_ripple**。
   *
   * 选中的那一格底下是一条**实心圆角胶囊**，而 Android 的水波纹是**矩形**的 ——
   * 压上去就露出一块直角、颜色还和胶囊对不上的矩形，选中格最明显
   * （用户的原话是"滑块中间有一个矩形，颜色还不一致"）。
   * 底是白的时看不出来，实心之后就藏不住了。
   *
   * 透明度反馈没有形状，叠在任何底上都不会露边；而"选中态"本来就由胶囊
   * 自己滑过去表达了，这里只需要一点点按下回应。
   */
  itemPressed: { opacity: 0.55 },
  label: {
    marginTop: 3,
    fontSize: 11,
    fontWeight: '500'
  }
})

module.exports = FloatingTabBar
