const React = require('react')
const { View, Text, StyleSheet, AppState, Image } = require('react-native')
const { StatusBar } = require('expo-status-bar')
const { NavigationContainer, createNavigationContainerRef } = require('@react-navigation/native')
const { createNativeStackNavigator } = require('@react-navigation/native-stack')
const { createBottomTabNavigator } = require('@react-navigation/bottom-tabs')
const { SafeAreaProvider, SafeAreaView } = require('react-native-safe-area-context')

const nav = require('./src/compat/nav.js')
const wxShim = require('./src/compat/wx.js')
const cloud = require('./src/utils/cloud.js')
const store = require('./src/utils/store.js')
const api = require('./src/utils/api.js')
const appInst = require('./src/app.js')
const { colors } = require('./src/theme.js')
const UiHost = require('./src/components/UiHost.js')
const TabIcon = require('./src/components/TabIcon.js')
const FloatingTabBar = require('./src/components/FloatingTabBar.js')
const { NavBar } = require('./src/components/NavBar.js')
const LoginScreen = require('./src/screens/Login.js')
const HoldingsScreen = require('./src/screens/Holdings.js')
const AddHoldingScreen = require('./src/screens/AddHolding.js')
const HoldingDetailScreen = require('./src/screens/HoldingDetail.js')
const CalendarScreen = require('./src/screens/Calendar.js')
const DiscoverScreen = require('./src/screens/Discover.js')
const CommunityScreen = require('./src/screens/Community.js')
const CommunityDetailScreen = require('./src/screens/CommunityDetail.js')
const ProfileScreen = require('./src/screens/Profile.js')
const HoldingRecordScreen = require('./src/screens/HoldingRecord.js')
const AddTradeScreen = require('./src/screens/AddTrade.js')
const AddDividendScreen = require('./src/screens/AddDividend.js')
const LifeExpenseScreen = require('./src/screens/LifeExpense.js')
const MetricSettingsScreen = require('./src/screens/MetricSettings.js')
const RankScreen = require('./src/screens/Rank.js')
const ArticleScreen = require('./src/screens/Article.js')
const DocScreen = require('./src/screens/Doc.js')
const CoverageScreen = require('./src/screens/Coverage.js')
const ToolScreen = require('./src/screens/Tool.js')
const MembershipScreen = require('./src/screens/Membership.js')
const OnboardingScreen = require('./src/screens/Onboarding.js')
const WebViewPageScreen = require('./src/screens/WebViewPage.js')
const StockNewsScreen = require('./src/screens/StockNews.js')
const ArchiveScreen = require('./src/screens/Archive.js')

const alipay = require('./src/utils/alipay.js')

/**
 * 支付 SDK 的注册。
 *
 * 为什么放在 App 启动处、而不是写在各 utils 文件里：
 * **注册必须发生在"这个模块一定存在"的构建里**。详见 utils/wxpay.js 开头那段 ——
 * Metro 遇到字面量的 require，会把缺失的模块编译成一个"一执行就把 native 层搞崩"
 * 的桩，try/catch 接不住，用户侧的表现是点一下按钮直接闪退。
 *
 * 所以规则很简单：**装了哪个包，就在这里注册哪个**；
 * 没装就千万别写那一行（那句 require 会让构建一启动就崩）。
 *
 * 现在支付宝装了（依赖里的 @uiw/react-native-alipay）；
 * 微信还没装 —— 等接了 react-native-wechat-lib 再把下面那行打开。
 */
alipay.register(require('@uiw/react-native-alipay'))
// wxpay.register(require('react-native-wechat-lib'))

const navigationRef = createNavigationContainerRef()
const Stack = createNativeStackNavigator()
const Tab = createBottomTabNavigator()

// 已经迁移完成的页面（其余仍是占位）
const SCREENS = {
  Holdings: HoldingsScreen,
  AddHolding: AddHoldingScreen,
  HoldingDetail: HoldingDetailScreen,
  Calendar: CalendarScreen,
  Discover: DiscoverScreen,
  Community: CommunityScreen,
  CommunityDetail: CommunityDetailScreen,
  Profile: ProfileScreen,
  HoldingRecord: HoldingRecordScreen,
  AddTrade: AddTradeScreen,
  AddDividend: AddDividendScreen,
  LifeExpense: LifeExpenseScreen,
  MetricSettings: MetricSettingsScreen,
  Rank: RankScreen,
  Article: ArticleScreen,
  Doc: DocScreen,
  Coverage: CoverageScreen,
  Tool: ToolScreen,
  Membership: MembershipScreen,
  Onboarding: OnboardingScreen,
  Archive: ArchiveScreen,
  // 个股新闻列表（从持仓详情页的入口点进来）。
  // 单独一页而不是塞进详情页：详情页要一屏看完"这只股票什么状态"，
  // 而新闻会一直往下长。
  StockNews: StockNewsScreen,
  // 内置浏览器（看新闻原文）。导航结构不用动 —— Placeholder 按 route name 查这张表
  WebViewPage: WebViewPageScreen
}

/**
 * 统一入口：已迁移的页面渲染真实组件，其余的显示占位。
 * 这样每轮迁移一个新页面，只需要往 SCREENS 里加一行，导航结构完全不用动。
 *
 * ⚠️ 但**新增**一个页面的名字（不是"迁移"、而是原先根本没有这个 route）时，
 * 只加这里**不够**：Stack.Screen 是按 AUTH_PAGES 生成的（见下面的 Stack.Navigator），
 * 名字不在那个数组里，就等于没注册。
 *
 * 症状是 navigateTo **点了没反应**，而且**不打任何警告** ——
 * 因为 nav.js 那边查表是命中的（ROUTES 里有），它只负责把名字交出去。
 * 这就是「点了没反应」里最难查的一类：每一步看起来都对。
 *
 * 新增一个页面一共要改**四处**：
 *   app.js  的 SCREENS        route name → 组件
 *   app.js  的 AUTH_PAGES     注册成栈内页（**最容易漏的一处**）
 *   app.js  的 TITLES         顶栏默认标题
 *   compat/nav.js 的 ROUTES   '/pages/x/x' → route name
 */
function Placeholder(props) {
  const Real = SCREENS[props.route.name]

  if (Real) return <Real {...props} />

  return (
    <View style={styles.ph}>
      <Text style={styles.phName}>{props.route.name}</Text>
      <Text style={styles.phSub}>页面迁移中</Text>
    </View>
  )
}

/**
 * 给页面套一层顶部外壳。两种形态：
 *
 *   · 栈内页（默认）—— 一条自绘标题栏（原生 header 已在下面全局关掉），带返回键；
 *   · 一级页面（root=true）——**不画标题栏**，只留状态栏的安全区占位。
 *
 * 一级页面为什么连标题栏都不要：它们是底部导航的根，用户从 tab 直接进来，
 * 上面再压一条白栏，等于凭空多出一层"容器"；而这些页面自己的第一屏内容
 * （发现页的搜索框、我的页的用户卡、持仓页的总览）本来就是头部，
 * 再顶一条同名的白栏只是重复。首页一直是这么做的（它连状态栏占位都自己管，
 * 见 TAB_LIST 里的 bare）。
 *
 * @param initialTitle 初始标题（对应小程序各页 json 的 navigationBarTitleText）
 * @param root         一级页面（底部 tab 的根页）
 *
 * 按 initialTitle + root 缓存组件实例：如果每次 render 都现造一个函数组件，
 * App 重渲染（登录态切换）时整棵树会被当成换类型而重建。
 */
const shellCache = new Map()

function withBar(initialTitle, root) {
  const key = (initialTitle || '') + (root ? '|root' : '')
  let Made = shellCache.get(key)
  if (!Made) {
    Made = function ScreenWithBar(props) {
      // 一级页面：只有状态栏占位，没有标题栏。
      //
      // edges 只取 top —— 底部那圈安全区留给悬浮导航栏（FloatingTabBar 自己
      // 撑），页面要是也占一份，内容会被顶高一截。
      if (root) {
        return (
          <SafeAreaView style={shellStyles.wrap} edges={['top']}>
            <Placeholder {...props} />
          </SafeAreaView>
        )
      }

      return (
        <View style={shellStyles.wrap}>
          <NavBar route={props.route} navigation={props.navigation} initialTitle={initialTitle} />
          <View style={shellStyles.body}>
            <Placeholder {...props} />
          </View>
        </View>
      )
    }
    shellCache.set(key, Made)
  }
  return Made
}

/**
 * 与小程序 app.json 的 tabBar + components/tab-bar/tab-bar.js 逐项对齐：
 * 文案、顺序、图标画法都取自小程序那份，改小程序时要同步改这里。
 */
const TAB_LIST = [
  // 社区排第一、并且对外叫「首页」。
  //
  // 两个名字不冲突，各管一件事：**tab 叫「首页」**，是它在导航里的身份
  // （用户找的是"回到最外面那屏"）；**页面里的大字仍然是「收息佬社区」**，
  // 那是品牌。参照的内容社区也都是这么分的（tab 写"首页"、页头写品牌名）——
  // 把 tab 直接叫"社区"，反而会让人以为它是个次级入口。
  //
  // 排第一还有个副作用：Tab.Navigator 默认落在第一个 screen 上，
  // 于是**冷启动就停在首页**，不再停在持仓。
  //
  // bare：不套那条自绘标题栏。首页自己画顶部（品牌大字 + 搜索）——
  // 其余 tab 是工具，一条「持仓 / 发现 / 我的」正合适；
  // 首页要的是"这里有人有内容"的场子感，小标题栏撑不起来。
  { name: 'Community', title: '首页', icon: 'feed', bare: true },
  { name: 'Holdings', title: '持仓', icon: 'bars' },
  // 「分红日历」原本占着下面这一格，已撤成一个普通页面
  // （和「持仓」页开头那张"预测年度分红"说的是同一件事，两个 tab 重复了）。
  // 它没丢：从「发现」页的工具卡进，见 AUTH_PAGES 里的 Calendar。
  { name: 'Discover', title: '发现', icon: 'compass' },
  { name: 'Profile', title: '我的', icon: 'user' }
]

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        // 同上：tab 页的标题也走 ScreenWithBar 里那条自绘的
        headerShown: false,
        // 关掉导航容器自带的不透明背景，底图才能透上来。
        // 不设这一项的话，页面再透明也会被这一层灰底挡住 ——
        // 表现就是"底图完全看不到"，且不会有任何报错。
        sceneStyle: { backgroundColor: 'transparent' }
      }}
      // 换成悬浮式毛玻璃导航栏：不再用原生 tabBar。
      // 配色、圆角、悬浮缝隙、划过动效都在组件里（components/FloatingTabBar.js），
      // 图标与标题仍来自上面的 TAB_LIST，避免两处各写一份。
      tabBar={(props) => <FloatingTabBar {...props} icons={TAB_LIST.map((t) => t.icon)} />}
    >
      {TAB_LIST.map((t) => (
        <Tab.Screen
          key={t.name}
          name={t.name}
          // bare 的页面自己画顶部（社区页），直接给原组件不给 withBar。
          // 其余三个（持仓 / 发现 / 我的）都是一级页面：root=true 不画标题栏。
          component={t.bare ? SCREENS[t.name] : withBar(t.title, true)}
          options={{ title: t.title }}
        />
      ))}
    </Tab.Navigator>
  )
}

/**
 * 顶部标题：与小程序各页 *.json 的 navigationBarTitleText 一一对应。
 * 没登记在这里的就是小程序里继承 app.json 的「收息佬」。
 * Doc / HoldingRecord / Tool / Rank 会在 onLoad 里再调 setNavigationBarTitle 覆盖。
 */
const TITLES = {
  HoldingDetail: '收息佬',
  HoldingRecord: '持仓记录',
  AddHolding: '收息佬',
  AddTrade: '收息佬',
  AddDividend: '收息佬',
  Article: '文章',
  Coverage: '收息佬',
  LifeExpense: '收息佬',
  Membership: '收息佬会员',
  MetricSettings: '汇总指标设置',
  Archive: '投资档案',
  Rank: '榜单',
  Tool: '工具',
  Doc: '说明',
  CommunityDetail: '社区',
  // 分红日历从 tab 降为普通页面后，标题改由这里给（tab 页的标题来自 TAB_LIST）
  Calendar: '分红日历',
  // 引导页正文里自己画了「收息佬」大字（Onboarding.js 的 heroName），
  // 这里再给同名标题，顶部会连着出现两次。留空：不显示标题，返回键照旧。
  Onboarding: '',

  // 个股新闻列表。真标题由页面在 onLoad 里带股票名覆盖
  //（"贵州茅台 新闻"），这里给的是还没取到股票名时的兜底。
  StockNews: '个股新闻',
  // 内置浏览器看新闻原文。同样会被页面用新闻标题覆盖（截断版）。
  WebViewPage: '新闻详情'
}

/**
 * 自己画顶部、不要那条白标题栏的栈内页面。
 *
 * 它们和 tab 里的 bare 是同一个诉求的两个入口：社区详情顶部是一排
 * 「✕ / ☆ / ↗」工具条，再套一层带返回箭头的白条，就会出现两条顶栏，
 * 而且两条都能返回 —— 那是明显的重复。
 */
const BARLESS = new Set(['CommunityDetail'])

// 登录后才会出现的页面
const AUTH_PAGES = [
  'HoldingDetail',
  'HoldingRecord',
  'AddHolding',
  'AddTrade',
  'AddDividend',
  'Article',
  'Coverage',
  'LifeExpense',
  'Membership',
  'MetricSettings',
  'Archive',
  'Rank',
  'Tool',
  'CommunityDetail',
  // 从 tab 降下来的页面：不进这里就不会被注册成栈内页，
  // 从「发现」页推它的时候会落进 Placeholder 的"页面迁移中"
  'Calendar',

  // ⚠️ 新页面必须加进这个数组，**只加 SCREENS 不够**。
  //
  // 根因：Stack.Screen 是遍历 AUTH_PAGES 生成的（见下面 Stack.Navigator），
  // SCREENS 只是给 Placeholder 查"这个 route name 该渲染哪个组件"。
  // 漏了这一处，navigateTo 会**完全没有反应**，而且不打任何警告 ——
  // 因为 nav.js 那边查表是命中的（ROUTES 里有），它只负责把名字交出去。
  // 表现就是「点了没反应」，最难查的一类。
  'StockNews',
  'WebViewPage'
]

// 登录前也要能打开的页面（协议正文、引导流 —— 登录页上会跳过去）
const PUBLIC_PAGES = ['Doc', 'Onboarding']

// 主界面可能的当前路由（Tab 页会把自己的名字报上来，不只是 Main）
const MAIN_ROUTES = ['Main', 'Holdings', 'Calendar', 'Discover', 'Profile']

/**
 * 冷启动时的云端对齐（对应小程序 app.js 的 onLaunch）。
 *
 * 页面先按本地快照渲染（零等待），这里再去拉云端更新的数据；
 * 拉到了就把导航重置回主界面，让页面重新取一次数。
 * 未部署后端 / 断网 / 未登录时静默跳过，退化成纯本地模式。
 */
let lastSyncAt = 0
const SYNC_MIN_GAP = 5000

/**
 * 会员到期后的降级提示。
 *
 * 两个阶段分开说，因为用户该做的事不一样：
 *   - grace（宽限期内）：还有几天，**现在续费就不用折腾**；
 *   - frozen（期满已收起）：已经收起了，重新开通即可原样恢复。
 *
 * 都留一个「知道了」，不要只给「去续费」—— 用户在没法立刻付款时
 * 需要一个不显得被强迫的出口，否则他会直接杀进程，连提示都没看清。
 */
function notifyDowngrade(d) {
  if (!d || !d.show) return

  // 文案的三条规矩：
  //   1) **不用 markdown** —— 弹窗是纯文本，`**加粗**` 会把星号原样显示出来；
  //   2) **先给结论再给解释** —— "3 只超出额度" 比"你有持仓超出免费额度"先说出来，
  //      用户打开这一屏最想知道的就是"会不会动我的东西"；
  //   3) **一定说清数据还在** —— 这是整个降级流程里唯一会让人紧张的点，
  //      含糊一句就会有人以为持仓被删了，然后直接流失。
  if (d.phase === 'grace') {
    wx.showModal({
      title: '会员已到期',
      content:
        '你有 ' + d.over + ' 只持仓超出免费额度（免费版可持 ' + d.max + ' 只）。\n\n' +
        '它们会保留到 ' + d.deadline + '（还有 ' + d.daysLeft + ' 天），' +
        '之后才会暂时收起。\n' +
        '数据不会丢，现在续费一切照旧。',
      confirmText: '立即续费',
      cancelText: '稍后再说',
      align: 'left',
      success: (r) => {
        if (r.confirm) wx.navigateTo({ url: '/pages/membership/membership' })
      }
    })
    return
  }

  if (d.phase === 'frozen') {
    wx.showModal({
      title: d.frozen + ' 只持仓已暂时收起',
      content:
        '会员到期已超过 7 天宽限期，超出免费额度的 ' + d.frozen + ' 只已从列表收起。\n\n' +
        '数据完好无损，重新开通会员后立刻恢复。',
      confirmText: '恢复持仓',
      cancelText: '知道了',
      align: 'left',
      success: (r) => {
        if (r.confirm) wx.navigateTo({ url: '/pages/membership/membership' })
      }
    })
  }
}

/**
 * 会员即将到期的提示（过期前一周内，每天最多一次）。
 *
 * 与 notifyDowngrade 的区别在语气，因为它们对应的时间点不同：
 *   · 那个 —— 已经过期、东西正在被收起，要的是"赶紧处理"；
 *   · 这个 —— 还有几天，要的是"你有时间，但别忘了"。
 * 所以这里给的是到期日与剩余天数，不提"超出只数"：此刻用户还没违规。
 *
 * 顺带把宽限期规则讲清楚（保留 7 天）—— 很多人以为到期当天持仓就没了，
 * 那会让他慌着做决定，甚至干脆不用了。说清楚反而更容易留住人。
 */
function notifyExpiring(d) {
  if (!d || !d.show) return

  wx.showModal({
    // 把剩余天数放进标题：用户瞄一眼就够，不必读正文
    title: '会员还有 ' + d.daysLeft + ' 天到期',
    content:
      '你的' + (d.tierName || '会员') + '将在 ' + d.expiresAt + ' 到期。\n\n' +
      '到期后，超出免费额度的持仓会先保留 7 天，不会立刻收起。\n' +
      '现在续费，一切照旧。',
    confirmText: '立即续费',
    cancelText: '稍后再说',
    align: 'left',
    success: (r) => {
      if (r.confirm) wx.navigateTo({ url: '/pages/membership/membership' })
    }
  })
}

function syncOnBoot() {
  if (!appInst.isLogin()) return

  // 冷启动之外，从后台回到前台也会走到这里：加个最小间隔，
  // 免得在几个 App 之间来回切时反复打请求
  const now = Date.now()
  if (now - lastSyncAt < SYNC_MIN_GAP) return
  lastSyncAt = now

  // 会员档位以服务端为准（兑换码 / 订单都在那边记账），本地那份只是缓存
  //
  // 紧随其后的 notifyMembershipGrace 必须**等同步完成**再跑：它读的是本地档位，
  // 而那份刚被服务端结果覆盖过 —— 顺序反了就会拿旧档位做判断，
  // 出现「刚续费却被提示已到期」这种离谱结果。
  api
    .syncMembership()
    .then(() => api.notifyMembershipGrace())
    .then((res) => {
      const d = (res && res.data) || {}
      notifyDowngrade(d)

      // 降级提示已经在说了，就不必再补一句「即将到期」——
      // 两条 modal 同时发出，后一条会盖住前一条，而前一条才是要立刻处理的
      if (d.show) return
      notifyExpiring(((api.notifyMembershipExpiring() || {}).data) || {})
    })
    .catch(() => null)

  store
    .pullFromCloud()
    .then((adopted) => {
      if (!adopted || !navigationRef.isReady()) return
      // 只在还停在主界面时重置：用户已经点进二级页了就不打扰他，
      // 那几页返回时会重新按快照 load 一次
      const r = navigationRef.getCurrentRoute()
      if (!r || MAIN_ROUTES.indexOf(r.name) === -1) return
      navigationRef.reset({ index: 0, routes: [{ name: 'Main' }] })
    })
    .catch(() => null)
}

function App() {
  const [logged, setLogged] = React.useState(false)

  React.useEffect(() => {
    wxShim.setApp(appInst)
    appInst.restore()
    setLogged(appInst.isLogin())

    // 老数据的币种口径修正要排在拉云端**之前**：它会把改动标脏，
    // 随后的 syncOnBoot 就按「本地优先」推上去。反过来先拉的话，
    // 版本标记已经写下、云端那份旧口径又把本地覆盖回来，等于没修。
    api.migrateNativeCurrency()

    // 实时汇率：先用上次缓存的（有就不必等网络），再后台刷一次。
    // 市值与预测年分红要按最新汇率看，所以这一步排在渲染之前。
    api.restoreFx()
    api.refreshFx()

    const offAuth = appInst.onAuthChange(setLogged)
    // 服务端回 401（token 过期/被踢）→ 清登录态，门禁自动把人送回登录页
    const off401 = cloud.onUnauthorized(() => {
      appInst.logout()
    })

    // 从后台回到前台也对齐一次：手机上 App 和小程序来回切，
    // 最容易出现「这边刚加的，那边还看不到」
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') syncOnBoot()
    })

    return () => {
      offAuth()
      off401()
      appStateSub.remove()
    }
  }, [])

  return (
    <SafeAreaProvider>
      {/*
        全 App 共用的一张底图：极浅的灰，带着几乎看不出的蓝/粉/橙光晕。
        绝对定位铺满，所有页面（s.page 已改成透明）都透出它。

        为什么值得为它专门加一张图：
        看到它的是**页面留白处**和底部导航栏那层毛玻璃（FloatingTabBar 的 BlurView）——
        模糊纯色等于没模糊，得有这些淡光晕才有东西可糊。
        （卡片本身不透光，见 theme.js 里 colors.card 附近的说明。）

        pointerEvents="none"：它纯粹是背景，绝不能吃掉触摸事件。
      */}
      <Image
        source={require('./assets/bg/app-bg.png')}
        style={styles.appBg}
        resizeMode="cover"
        pointerEvents="none"
      />

      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          nav.bind(navigationRef)
          syncOnBoot()
        }}
        /**
         * 导航状态一变就重绑一次。
         *
         * bind 只是一次赋值，重复调用没有副作用。之所以要多这一道：
         * compat/nav 里的 ref 是**模块级**的，模块一旦被重新求值
         *（热重载、或整棵树重挂），它就回到 null，而 NavigationContainer
         * 不会再来一次 onReady —— 那时每次跳转都被"导航还没就绪"丢掉，
         * 界面上就是"点什么都没反应"（我这次真遇到过一次，还以为是点击失效，
         * 冷启动之后才发现一切正常）。
         *
         * 有这一道之后，只要导航状态动过一次，绑定就自动恢复。
         */
        onStateChange={() => nav.bind(navigationRef)}
      >
        <StatusBar style="dark" />
        <Stack.Navigator
          screenOptions={{
            // 关掉原生 header：它的高度由原生定（iOS 44pt / Android 56dp），压不矮，
            // 统一换成 ScreenWithBar 里那条自绘的（见 components/NavBar.js）
            headerShown: false,
            // 同上：Stack 每张屏的默认底色也要关掉，否则它会盖住底图
            contentStyle: { backgroundColor: 'transparent' },
            // 【临时诊断】禁用页面切换动画，验证「白屏是不是过渡动画没正常结束」
            animation: 'none'
          }}
        >
          {!logged ? (
            <>
              <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
              {PUBLIC_PAGES.map((p) => (
                <Stack.Screen key={p} name={p} component={withBar(TITLES[p])} />
              ))}
            </>
          ) : (
            <>
              <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
              {AUTH_PAGES.map((p) => (
                <Stack.Screen
                  key={p}
                  name={p}
                  component={BARLESS.has(p) ? SCREENS[p] : withBar(TITLES[p])}
                />
              ))}
              {PUBLIC_PAGES.map((p) => (
                <Stack.Screen key={p} name={p} component={withBar(TITLES[p])} />
              ))}
            </>
          )}
        </Stack.Navigator>

        {/* Toast / Loading / Modal 的渲染层：兼容层只发事件，这里画出来 */}
        <UiHost />
      </NavigationContainer>
    </SafeAreaProvider>
  )
}

const shellStyles = StyleSheet.create({
  // 透明：让 App.js 顶部那张底图透上来。原来是 #FFFFFF，
  // 会把底图从这一层就挡住 —— 页面再透明也没用。
  wrap: { flex: 1, backgroundColor: 'transparent' },
  body: { flex: 1 }
})

const styles = StyleSheet.create({
  /**
   * 全 App 底图。
   *
   * opacity 压到 0.5：生成的图本身光晕偏重（很清晰地看到三团颜色），
   * 而参考稿要的是"几乎察觉不到"。压淡之后剩下的那点色偏，
   * 正好让半透明卡片"有东西可透"，又不至于自己变成主角。
   */
  appBg: {
    ...StyleSheet.absoluteFillObject,
    // 0.72 是试出来的：1.0 时顶部的暖色已经有点抢眼，
    // 0.5 又几乎看不见（原图的光晕本来就偏淡，再压一半就没了）。
    // 这个值让底图"能感觉到但不主导"，卡片透上去才有参考稿那种通透感。
    opacity: 0.72
  },
  ph: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  phName: { fontSize: 16, color: '#6B7370' },
  phSub: { marginTop: 8, fontSize: 13, color: '#B0B7B4' }
})

module.exports = App
