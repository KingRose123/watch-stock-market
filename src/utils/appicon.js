/**
 * 桌面图标切换（仅 Android）—— **已停用**。
 *
 * 曾经的做法：普通会员用白色版图标，Pro 会员用深色版；用户一升级，
 * 桌面图标跟着变深色。
 *
 * ⚠️ 为什么停用：
 *
 * Android 改桌面图标只有一条路 —— 启停 manifest 里的 activity-alias。
 * 而启停它会**重建启动器图标并销毁当前 Activity**，用户侧看到的就是
 * 「登录进去，界面闪一下重来」。这个代价换一个「图标颜色反映会员档位」
 * 的收益不成比例：档位在 App 里到处都能看到（会员页、"我的"页、额度提示），
 * 而且它变化极不频繁 —— 为一次几乎不会发生的变化牺牲每次启动的观感，
 * 不划算。
 *
 * 原生模块（AppIconModule.kt）与 manifest 里的 activity-alias **都保留着**，
 * 没有删。想恢复只需把 sync() 改回真实实现、并恢复 api.js 里的调用。
 *
 * 停用后这个文件只剩一件事：reset() —— 把可能还停在深色版的图标退回默认。
 * 因为停用之前用户可能已经被切到深色版了，不主动复位就会一直停在那儿。
 */
const { NativeModules, Platform } = require('react-native')

// 只有 Android 有这套机制；iOS 不允许运行时改图标（要用户在设置里选）
const mod = Platform.OS === 'android' ? NativeModules.AppIcon : null

function available() {
  return !!(mod && typeof mod.setPro === 'function')
}

/**
 * 按会员档位切换图标 —— **已停用，永远什么都不做**。
 *
 * 保留函数签名是刻意的：调用点（api.js 的 syncMembership）不用改结构，
 * 也免得后来看代码的人以为这里漏了一段。
 * 永远 resolve(false)，调用方照旧可以无脑 .then()。
 */
function sync(isPro) {
  return Promise.resolve(false)
}

/**
 * 把桌面图标退回默认版（普通版）。
 *
 * 幂等且静默：原生侧会先判断当前是不是已经是默认图标，是的话不重建，
 * 所以每次启动都调它是安全的 —— 只有真正需要复位的那一次才会有动作，
 * 之后每次都是空跑。
 *
 * 这也是为什么它不需要"只做一次"的本地标记：标记会多一个要维护、
 * 而且可能因为清数据而失效的状态，而原生侧的幂等判断本来就免费。
 */
function reset() {
  if (!available() || typeof mod.setPro !== 'function') return Promise.resolve(false)
  return mod
    .setPro(false)
    .then((res) => !!(res && res.changed))
    .catch((e) => {
      console.warn('[appicon] 复位桌面图标失败：' + ((e && e.message) || e))
      return false
    })
}

/** 从原生侧读当前图标状态，用于排查「图标和档位对不上」。 */
function current() {
  if (!available() || typeof mod.isProIcon !== 'function') return Promise.resolve(null)
  return mod
    .isProIcon()
    .catch(() => null)
}

module.exports = { available, sync, reset, current }
