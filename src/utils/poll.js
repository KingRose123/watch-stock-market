/**
 * 社区投票：本机记的「我投了哪一项」+ 结果统计。
 *
 * 为什么单独一个模块：这份状态要**跨页面共享** —— 首页那张投票卡和详情页
 * 是同一道题，在首页投完进详情要看到同一票、而且还能改。只存在某一个页面
 * 的 data 里就做不到（首页投了，详情页不知道）。
 *
 * 与收藏（CommunityDetail 里的 communityFavs）是同一套路数：先存本机，
 * 等后端有了投票接口，把这里的 get/set 换成 api 调用即可，两个页面都不用动。
 *
 * ⚠️ 存本机意味着换设备不跟着走。
 *
 * ⚠️ 这里只存**选择**，不存"我投完之后的票数"。存了就有两份真相：改票时
 * 得把旧项减回去，一旦哪次漏了，票数只会越投越多。票数每次从原始数据现算。
 */

const KEY = 'communityPollVotes'

/**
 * 一道题的 id：`内容 id`，或者 `内容 id#块下标`（正文里内嵌的题）。
 *
 * ⚠️ 这个规则**必须只有这一处**。
 *
 * 同一道题会在好几个地方被渲染、被投票：首页那张卡片、详情页、
 * 以及文章卡片上内嵌的那一份。各处各算一遍 id 的话，只要有一处算得不一样，
 * 表现就是"在首页投了票，点进详情还是没投过的样子" —— 而票其实已经存进去了，
 * 只是存到了另一个键上。这种状态不报任何错，只能靠肉眼发现。
 *
 * blockIndex 省略 = 这道题就是**整条内容本身**（内置数据里 kind:'poll' 那种，
 * 它的 id 在首页那张卡和详情页必须是同一个，否则两边各投各的）。
 */
function pollId(contentId, blockIndex) {
  if (blockIndex === undefined || blockIndex === null) return String(contentId)
  return String(contentId) + '#' + blockIndex
}

// { [题 id]: 选项下标 }
function readAll() {
  const v = wx.getStorageSync(KEY)
  return v && typeof v === 'object' ? v : {}
}

/** 我在某道题上投了哪一项。-1 = 还没投。 */
function myPick(id) {
  const v = readAll()[id]
  return typeof v === 'number' && v >= 0 ? v : -1
}

/**
 * 记下我在某道题上的选择。
 *
 * **可以反复调用** —— 改票就是再调一次，后一次覆盖前一次。
 * 之所以允许改：点错选项、或者看了解析想换个说法，把票锁死只会让人卡在这儿；
 * 而"一个人一票"这件事由**覆盖**语义保证 —— 改多少次，总数都还是一票。
 */
function setPick(id, i) {
  const all = readAll()
  all[id] = i
  wx.setStorageSync(KEY, all)
}

/**
 * 一道题的统计结果。
 *
 *   total  总票数（**含我这一票**）
 *   rows   [{ i, text, n, pct, mine }]，**保持选项原顺序**
 *   top    票数最多那一项的下标（并列时取靠前的）
 *
 * 两个刻意的取舍：
 *
 *  1. **含我这一票**。mock 里的 counts 是"别人投的"，加上我这张，
 *     界面上的「X 人已选择」和各项数字才对得上。改票只是把这一票从旧项
 *     挪到新项、总数不变 —— 所以是"按 mine 现算"，不是"投完再累加"。
 *
 *  2. **不按票数排序**。重排确实更直接地回答"哪个最多"，但用户刚点完一项，
 *     整个列表就在手指底下跳位置，很容易以为自己点错了。名次改用 top 标出来
 *     （最高那项挂一句「最多人选」），信息一样到手，而列表是稳的。
 *
 * 另：各项百分比各自四舍五入，加起来可能不是 100，这是有意的 ——
 * 单独看每一项更准，硬凑成 100 反而会让某一项偏一点。
 */
function stats(item, mine) {
  const opts = (item && item.options) || []
  const base = (item && item.counts) || []
  const me = typeof mine === 'number' ? mine : -1

  const counts = opts.map((_, i) => (base[i] || 0) + (i === me ? 1 : 0))
  const total = counts.reduce((a, b) => a + b, 0)

  let top = -1
  counts.forEach((n, i) => {
    if (top < 0 || n > counts[top]) top = i
  })

  const rows = opts.map((text, i) => ({
    i: i,
    text: text,
    n: counts[i],
    pct: total ? Math.round((counts[i] / total) * 100) : 0,
    mine: i === me
  }))

  return { total: total, rows: rows, top: top }
}

module.exports = { myPick, setPick, stats, pollId }
