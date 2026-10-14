/**
 * 工具的落点。
 *
 * 单独成一个模块，是因为**有三个地方要用它**，而它们原本各写了一份：
 *   · 发现页的四张工具卡
 *   · 文章页底部的「动手算一算」
 *   · 社区长文里内嵌的工具卡
 *
 * 复制三份的代价不是"多打几个字"—— 是加一个工具时必然漏掉其中一处，
 * 而漏掉的表现是「点了没反应」（只有一行 warn 落在控制台里）。
 * 这个项目在「投资档案」那个入口上就这么漏过一次（页面注册了、菜单加了、
 * 跳转也写了，唯独忘了那张表）。
 *
 * 注意 t2（分红日历）：它原本是底部栏里的一个 Tab，那时走 wx.switchTab；
 * 从底部栏撤下来之后它和另外三个一样是普通页面，所以统一从这张表里出 ——
 * 再对它 switchTab 会重置 getCurrentPages 的栈，表现是"日历打开了，但返回键没了"。
 */
const TOOL_ROUTES = {
  t1: '/pages/tool/tool?id=t1', // 复利计算器
  t2: '/pages/calendar/calendar', // 分红日历
  t3: '/pages/tool/tool?id=t3', // 息率对比
  t4: '/pages/tool/tool?id=t4', // 定投回测
  // 不在发现页那四张卡里，但属于同一类"读完就能动手"的落点
  lifeExpense: '/pages/life-expense/life-expense' // 生活支出
}

/**
 * 跳到一个工具，返回实际用的 URL（空串＝这个 id 没登记落点）。
 *
 * 把返回值交给调用方，是为了让"没落点"这件事能被看见：静默无反应正是
 * 「点了没反应」的成因，而 warn 只对开发有效，界面上该有提示就由调用方给。
 */
function goTool(id) {
  const url = TOOL_ROUTES[id] || ''
  if (!url) {
    console.warn('[tool] 这个 id 没有登记落点：' + id)
    return ''
  }
  wx.navigateTo({ url: url })
  return url
}

module.exports = { TOOL_ROUTES, goTool }
