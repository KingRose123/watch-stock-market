const { StyleSheet, Platform } = require('react-native')

/**
 * 通用颜色与样式。
 *
 * 小程序那份的公共类（row / between / dim / ml12…）散在 app.wxss 里由页面直接用，
 * RN 没有全局 class，所以把等价的样式对象收在这里，页面按需取用。
 *
 * ── 视觉规范（iOS 简约风）──────────────────────────────────
 * 这一层是全 App 观感的源头，改这里等于改所有页面。规范是照着 iOS HIG 归纳的：
 *
 *  1. **底色用极浅冷灰，不用纯白**。纯白底 + 白卡片会让卡片"浮不起来" ——
 *     两者亮度一样，中间那条边界只能靠描边撑，于是整个界面布满细线。
 *  2. **卡片靠阴影分层，不靠描边**。阴影要"大而淡"（大 radius、低 opacity），
 *     小而浓的阴影看着像描边，反而更重。这也是 iOS 与 Material 观感的主要分野。
 *  3. **圆角要大**（卡片 18、输入 12、胶囊 999）。小圆角在浅色背景上显局促。
 *  4. **字阶三级对比**：标题粗黑、正文常规、辅助浅灰。中间层不要有第四种灰 ——
 *     层次一多，界面就显得杂。
 *  5. **强调色只有一个**，且只出现在主操作上。到处用强调色就等于没有强调色。
 */
/**
 * ══════════════════════════════════════════════════════════
 *  皮肤表
 * ══════════════════════════════════════════════════════════
 *
 * 换肤只改下面这一行 `SKIN`，其余一切自动跟随 —— 包括 s 里的所有样式，
 * 因为 s 是在本模块加载时按当前 colors 建出来的。
 *
 * ⚠️ 但硬编码的颜色不会跟随。新增样式时**不要写字面量**，
 *    一律引用 colors.*（需要透明度就用 primaryA10 这类现成的变体）。
 *    否则换肤后会出现"主色变了、一片浅绿底还在"的花斑。
 *
 * ── 一套皮肤里必须分开的三件事 ──────────────────────────────
 *
 *   primary  品牌色 —— 出现在主按钮、选中态、链接
 *   up       上涨色
 *   down     下跌色
 *
 * 这三者**必须彼此无关**，这不是审美偏好：
 *
 * 国内市场是红涨绿跌（与欧美相反），所以红和绿已经被行情语义占用了。
 * 一旦品牌色也用绿，界面上出现的绿就有了两种含义 —— 用户看到一枚绿按钮，
 * 分不清那是"品牌"还是"这只跌了"；看到一片绿字，也说不准是行情还是装饰。
 * 原来的经典绿皮肤就踩在这个坑上。
 *
 * 所以品牌色只能从**红绿之外**取（蓝 / 靛 / 青 / 紫）。
 * 当前选的靛蓝除了避开冲突，还因为蓝在金融场景里天然带信任感 ——
 * 这是在这个约束下最稳的一档。
 */
const SKINS = {
  /**
   * 科技蓝（默认）
   *
   * 冷调、克制：底色与卡片的对比靠明度而非色相拉开，
   * 全屏只有一个饱和色（主色），符合"简约干练"。
   */
  tech: {
    label: '科技蓝',
    colors: {
      bg: '#F2F3F5',
      card: '#FFFFFF',
      t1: '#12151A', // 比纯黑柔一点，深色文字更耐看
      t2: '#5A6472',
      t3: '#98A1AE',
      line: '#E8EBEF',
      line2: '#F4F6F9',

      // ── 品牌色（蓝，与涨跌无关）
      primary: '#2563EB',
      primarySoft: '#EEF3FE',

      // ── 强调色 ────────────────────────────────────────────
      // 与品牌色**刻意分开**：品牌色负责"这是什么产品"（按钮、标题），
      // 强调色负责"这里你要注意"（选中态、当前项、需要突出的数值）。
      //
      // 之前这两件事都由 primary 兼任，于是"选中态该用什么色"这个问题
      // 无解 —— 它要么跟品牌色（那强调不出来），要么另找一个色（那就是现在这样）。
      // 拆开之后规则就清楚了：**品牌是底，强调是点**。
      //
      // 本皮肤里强调色与品牌色同值（蓝）：这版设计本来就只有一支蓝，
      // 拆出 accent 是为了让 mono 皮肤能用不同的色值，不是为改而改。
      accent: '#2563EB',
      accentSoft: '#EEF3FE',

      // ── 涨跌色（国内约定：红涨绿跌）
      // 跌色比原来的 #1F9D6B 更纯、更亮：原来那个绿和经典皮肤的品牌绿
      // 太接近，两者并排时几乎分不出来。现在品牌是蓝，可以放心把跌绿调准。
      up: '#E5484D',
      down: '#12A150',
      // 深色卡（顶部总览那种黑底）上的涨跌色。
      // 浅灰底上那组红绿压到黑底上会发闷、认不出方向，所以单独给一档更亮的 ——
      // 之前是在两个页面里各写了一个近似值，现在收进来统一。
      upLight: '#FF7A7D',
      downLight: '#3DD68C',

      // ── 辅助色：暖色只留这一支 ──────────────────────────────
      //
      // 原先"暖色提示"这件事用了 6 个色值（#E0892C / #9C7A1E / #8A6A2F /
      // #D9A93C / #F5A94B / #E8892B）和 4 个浅底（#F2E1BF / #FDF4E4 /
      // #FDF4D8 / #FFF7EC）。它们语义完全相同（"需要留意，但不是错误"），
      // 只是当初一处处攒下来的 —— 这正是界面显得杂的根源。
      //
      // 现在收敛成：一个前景色 orange、一个底 warm、一条描边 warmLine。
      // 需要更浅就调 alpha，不要再引入新色值。
      orange: '#E08A2C',
      // 浅暖底上的橙字要更深一档，否则对比度不够、看不清。
      // 这不是"想多用一个色值"，是可读性所需 —— 所以它算同一支暖色，
      // 不算新增色相。
      orangeDeep: '#8A5B1C',
      warm: '#FDF6EA',
      warmLine: '#F3E3C4',
      // 金只用于"会员"这类身份标识，与提示橙分开（它是标识不是提醒）
      gold: '#B8891F',

      dark: '#1C1F26',

      // 阴影基色：不用纯黑（纯黑阴影在浅灰底上会发脏发土）。
      // 取一点主色倾向的深蓝，阴影也跟着整体调性走
      shadow: '#0A1633'
    }
  },

  /**
   * 经典绿（原皮肤，保留用于回退）
   *
   * 就是换肤之前那一套。留着它有两个用处：
   *   1. 新皮肤看不顺眼时，把 SKIN 改回 'classic' 即可完全复原；
   *   2. 作为对照，随时能比一比哪套更合适。
   *
   * 注意它的品牌色（绿）与跌色是同一色系 —— 这正是要换掉它的原因，
   * 保留归保留，不代表这个选择没问题。
   */
  classic: {
    label: '经典绿',
    colors: {
      bg: '#F2F3F5',
      card: '#FFFFFF',
      t1: '#1F1F1F',
      t2: '#6B7370',
      t3: '#9AA3A0',
      line: '#EDF0EF',
      line2: '#F4F6F5',
      primary: '#1F9D6B',
      primarySoft: '#EAF6F0',
      // 同 tech：这一版只有一支绿，accent 与 primary 同值
      accent: '#1F9D6B',
      accentSoft: '#EAF6F0',
      up: '#E5484D',
      down: '#1F9D6B',
      upLight: '#FF7A7D',
      downLight: '#3DD68C',
      // 这几支辅助色与原皮肤保持同一组值 ——
      // 它们的职责是"暖色提示"，与品牌绿无关，换肤时不该跟着变
      orange: '#E08A2C',
      orangeDeep: '#8A5B1C',
      warm: '#FDF6EA',
      warmLine: '#F3E3C4',
      dark: '#232323',
      gold: '#B8891F',
      shadow: '#0B1F17'
    }
  },

  /**
   * 黑白灰 · 橙（当前默认）
   *
   * 这套是照着一份 Glassmorphism 设计稿归纳出来的，核心规则只有三条：
   *
   *   1. **界面本身不带颜色**。黑白灰承担全部结构（底、卡、线、字），
   *      彩色只来自内容（封面图、涨跌数字）。
   *   2. **品牌色退成近黑**。按钮、标题这些"产品身份"用黑就够 ——
   *      用彩色反而会让界面到处是重点，反而没有重点。
   *   3. **橙色只在"这里你要注意"时出现**。参考稿里整屏只有 1~3 处橙色：
   *      主操作按钮、当前选中的项、图表里要突出的那一段。
   *
   * 所以这套里 primary（黑）与 accent（橙）职责完全不同，
   * 不能像前两套那样取同值 —— 这也是把它们拆成两个角色的直接原因。
   */
  mono: {
    label: '黑白灰·橙',
    colors: {
      // 底与层次：全部是无彩色，靠明度拉开距离
      bg: '#F1F2F4',
      card: '#FFFFFF',
      t1: '#111214', // 标题、大数字
      t2: '#6B7280', // 正文
      t3: '#9CA3AF', // 辅助说明
      line: '#E8EAED',
      line2: '#F4F5F7',

      // ── 品牌色 = 近黑。不是纯黑：纯黑在小字号上会显得过于锐利
      primary: '#111214',
      primarySoft: '#F1F2F4',

      // ── 强调色 = 橙。整屏只该出现在少数几处（见上面的规则 3）
      accent: '#F97316',
      accentSoft: '#FFF3E9',

      // ── 涨跌：国内约定，不可改。但把饱和度压低一档，
      //    免得它们和橙色一起把页面吵起来
      up: '#E5484D',
      down: '#12A150',
      upLight: '#FF7A7D',
      downLight: '#3DD68C',

      // 提示类（"留意但不是错误"）在本皮肤里就用强调色本身，
      // 不再单独养一支暖色 —— 参考稿里也没有第二种暖色
      orange: '#F97316',
      orangeDeep: '#9A4A0E',
      warm: '#FFF3E9',
      warmLine: '#FAD9BC',
      dark: '#111214',
      gold: '#B8891F',
      shadow: '#0F1115'
    }
  }
}

// ★ 换肤开关：'tech'（第1套·科技蓝，默认）| 'classic'（第2套·经典绿，原皮肤）| 'mono'（第3套·黑白灰）
const SKIN = 'tech'

const colors = SKINS[SKIN].colors

/**
 * 主色的透明变体。
 *
 * 之所以单列出来，是因为页面里大量需要"浅主色底 / 半透明主色描边"，
 * 而没法在 style 里现算 rgba（写死的话换肤就漏掉了）。
 * 之前有 33 处硬编码 rgba(31,157,107,…)，换肤时会全部留在绿色上。
 */
function mixA(hex, a) {
  const h = hex.replace('#', '')
  const n = parseInt(h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
}

// 这几个透明度是照实际用法统计出来的（浅底 0.08~0.12、描边 0.18~0.35）
colors.primaryA08 = mixA(colors.primary, 0.08)
colors.primaryA10 = mixA(colors.primary, 0.1)
colors.primaryA12 = mixA(colors.primary, 0.12)
colors.primaryA18 = mixA(colors.primary, 0.18)
colors.primaryA30 = mixA(colors.primary, 0.3)
colors.primaryA35 = mixA(colors.primary, 0.35)
// 涨色的透明底（标签里表示"错误/危险"时用），同样跟随皮肤
colors.upA12 = mixA(colors.up, 0.12)

// ⚠️ 卡片**一律不透明**（colors.card 纯色）。这里刻意不提供半透明的卡底 ——
// 曾经有过 colors.cardA86 / cardA72，都删掉了，原因是它在 Android 上会露馅。
//
// 症状是「卡片边缘发灰、中间才是白的」，看着像卡片边缘透光：
//
//   s.card 带 elevation:2，系统会在卡片**底下**画一层模糊的阴影轮廓。
//   卡片不透明时这层被完全盖住；一旦填充透光（哪怕只透 14%），阴影就会
//   从卡片内部渗出来，沿内缘糊出一圈灰边，越靠边越深。
//
// 实测（分红日历的月份卡，同一坐标）：
//
//     x=58（内缘）   半透明 246  →  不透明 255
//     x=150（中间）  半透明 252  →  不透明 255
//
// 改完卡片里外都是干净的纯白，而卡片**外侧**的阴影没变（仍是 206）——
// 浮起感还在，只是不再从内部透出来。
//
// 所以通透感这件事到此为止：它只能体现在**页面留白处**底图的呈现上，
// 别再往卡片填充上打主意。真正的毛玻璃全 App 只有底部导航栏一处
// （FloatingTabBar 的 BlurView），那里模糊的也是同一张底图。

// 强调色的透明变体。选中态、当前项这类"半透明强调底"都从这里取，
// 不要再写 rgba 字面量 —— 那会让换肤漏掉。
colors.accentA08 = mixA(colors.accent, 0.08)
colors.accentA10 = mixA(colors.accent, 0.1)
colors.accentA12 = mixA(colors.accent, 0.12)
colors.accentA18 = mixA(colors.accent, 0.18)
colors.accentA30 = mixA(colors.accent, 0.3)

// 主色的文字级浅色：深色底上压白字时用
colors.primarySoftText = colors.primarySoft

/**
 * 标签色板 —— 全项目只此一套。
 *
 * 键名按**职责**取，不按颜色取。原来叫 blue / orange，可一旦皮肤换了色相，
 * `tag-blue` 里装着橙色就很别扭；而"它是什么颜色"本来也不是调用方该关心的事，
 * 调用方要表达的是"这是中性分类 / 这是要留意的 / 这是错误"。
 *
 *   gray   默认。绝大多数标签用它 —— 标签的职责是"分类"，不是"吸引注意"
 *   accent 中性强调（用强调色，所以不额外引入色相）
 *   warn   需要留意，但不是错误
 *   red    错误 / 危险 / 亏损
 */
const TONES = {
  gray: { backgroundColor: colors.line2, color: colors.t2 },
  accent: { backgroundColor: colors.accentA12, color: colors.accent },
  warn: { backgroundColor: colors.warm, color: colors.orangeDeep },
  red: { backgroundColor: colors.upA12, color: colors.up }
}

// 页面里写 `styles['tag-x']`，所以这里给出 s 风格的键名
const toneStyles = {}
Object.keys(TONES).forEach((k) => {
  toneStyles['tag-' + k] = TONES[k]
})
// 旧键名兼容：green / gold / orange / blue 都曾是独立色调，现在各自归并。
// 页面不必一次性全改，也不会留下没人认领的样式键。
toneStyles['tag-green'] = TONES.accent
toneStyles['tag-blue'] = TONES.accent
toneStyles['tag-orange'] = TONES.warn
toneStyles['tag-gold'] = TONES.warn

/**
 * 卡片阴影。iOS 与 Android 只能各写各的 ——
 * iOS 认 shadow*，Android 只认 elevation（它会自动推导阴影，但也可以配 shadowColor）。
 *
 * 分两级是因为"浮在内容上"和"浮在页面上"该有不同的高度感：
 * 列表里的卡片属于前者，只要一层很薄的分离；悬浮栏属于后者，要明显抬起来。
 * 用同一个值会让列表卡片重得压住内容、或让悬浮栏跟背景糊在一起。
 */
const shadowCard = Platform.select({
  ios: {
    shadowColor: colors.shadow,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 }
  },
  // elevation 在 Android 上同时决定阴影和层级，2 是"轻微浮起"的最小可见值
  android: { elevation: 2 }
})

const shadowFloat = Platform.select({
  ios: {
    shadowColor: colors.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 }
  },
  android: { elevation: 8 }
})

const s = StyleSheet.create({
  flex1: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  col: { flexDirection: 'column' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center' },

  // 页面根容器**故意不给背景色**：全 App 共享的那张底图（App.js 里的 appBg）
  // 铺在所有页面之下，页面透明才能透出它。
  // 如果哪天要临时关掉底图，把这里改回 `backgroundColor: colors.bg` 即可 ——
  // 那时插件的淡光晕不再可见，但界面本身仍然完整。
  page: { flex: 1, backgroundColor: 'transparent' },
  // 页面内容的统一内边距；底部留出固定元素（悬浮按钮 / 底部栏）的空间。
  // paddingTop 从 12 提到 18：卡片带上阴影后，贴得太近会让阴影撞上导航栏，
  // 显得拥挤（阴影本身也在占视觉空间）
  content: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 120 },

  // 卡片：全 App 最常复用的那个。
  //
  // 三个刻意的取舍：
  //  1. **不透明的纯白**。⚠️ 别改成半透明 —— 卡片底下的 elevation 阴影
  //     会从内缘透出来，糊成一圈灰边。原因和实测数据见上面 colors.card
  //     附近那段（那里记着为什么删掉了 cardA86）。
  //  2. **圆角 20**。参考稿的圆角相当大（换算过来约 20~24），
  //     小圆角在大屏上会显局促。
  //  3. **没有 borderWidth**。阴影和描边同时存在会让卡片有一圈脏边，
  //     二选一 —— 选阴影。
  card: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 16,
    ...shadowCard
  },
  darkCard: {
    backgroundColor: colors.dark,
    borderRadius: 20,
    padding: 18,
    ...shadowCard
  },

  h1: { fontSize: 24, fontWeight: '700', color: colors.t1 },
  h2: { fontSize: 18, fontWeight: '700', color: colors.t1 },
  h3: { fontSize: 16, fontWeight: '600', color: colors.t1 },
  /**
   * 大标题 + 副标题：iOS 里最常见的页面头部组合。
   *
   * letterSpacing 取负值是 iOS 的一个特征 —— 字号越大，系统收得越紧，
   * 否则大字的字间距会显得松散。这个细节是"看着像 iOS"和"看着像网页"的分界之一。
   */
  title: { fontSize: 26, fontWeight: '700', color: colors.t1, letterSpacing: -0.4 },
  subtitle: { fontSize: 13, color: colors.t3, marginTop: 5, lineHeight: 19 },

  mid: { fontSize: 15, color: colors.t1 },
  small: { fontSize: 13, color: colors.t2 },
  tiny: { fontSize: 12, color: colors.t3 },
  dim: { color: colors.t3 },
  dimOnDark: { color: 'rgba(255,255,255,0.62)' },
  onDark: { color: '#FFFFFF' },
  bold: { fontWeight: '600' },
  // 数字用等宽字形，滚动时不会左右跳
  num: { fontVariant: ['tabular-nums'] },

  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontSize: 11,
    overflow: 'hidden'
  },

  mini: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    fontSize: 13,
    color: colors.t2,
    overflow: 'hidden'
  },

  input: {
    height: 46,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: colors.line2,
    fontSize: 15,
    color: colors.t1
  },

  // 主按钮：改用主色而不是深色。
  //
  // 规范第 5 条说"强调色只有一个，且只出现在主操作上" —— 主按钮就是那个主操作。
  // 原来用深色（colors.dark），结果是整个 App 里主色只出现在图标和文字上，
  // 按钮反而自成一路，缺少一个明确的视觉落点。
  btn: {
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary
  },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },

  // 次级按钮：同形状、改用浅底，用于"取消 / 稍后"这类非主路径
  btnGhost: {
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.line2
  },
  btnGhostText: { color: colors.t2, fontSize: 16, fontWeight: '600' },

  // 悬浮元素（悬浮球 / 浮层）用更强的那一级阴影
  float: { ...shadowFloat }
})

module.exports = { colors, s, tones: toneStyles, SKIN, SKINS }
