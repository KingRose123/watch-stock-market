/**
 * App 端配置。
 *
 * ⚠️ **真实的后端地址不在这里**。它在本机私有的 config.local.js 里
 *    （该文件被 .gitignore 忽略，不进版本库）；仓库里公开的只有
 *    config.local.example.js 这个模板。
 *
 *    首次克隆仓库后必须先做一步：
 *
 *        cp src/config.local.example.js src/config.local.js
 *
 *    然后把 API_BASE 填成你自己的地址。
 *
 *    不这么做的话构建会直接失败。这是刻意的 —— 公开仓库里不该出现
 *    任何具体服务器的地址；想让代码"开箱即跑"而把地址写死，
 *    等于把它一并交给了所有人。
 *
 * ── 关于协议（改地址时一起看）──────────────────────────────
 *
 * ⚠️ 若你的地址是 HTTP，AndroidManifest 里必须开着明文流量
 *    （android:usesCleartextTraffic="true"）—— Android 9 起默认禁止，
 *    release 包不开的话表现是「连不上」，而不是一个能看出原因的报错。
 *
 *    三处代价都是延后的：支付回调必须是 HTTPS、部分运营商会对 HTTP
 *    注入广告、应用商店上架要求 HTTPS。证书配好后把地址改成 https，
 *    并去掉 manifest 里那一行即可。
 *
 * 另：无论 HTTP 还是 HTTPS，国内节点都要求域名完成 ICP 备案 ——
 *    未备案域名访问 80/443 会被云厂商直接拦截，这与用哪种协议无关。
 */
const local = require('./config.local.js')

const API_BASE = local.API_BASE

// 请求默认超时
const DEFAULT_TIMEOUT = 10000

// 快照整份上传的超时（数据大的用户会慢一些）
const UPLOAD_TIMEOUT = 15000

module.exports = {
  API_BASE,
  DEFAULT_TIMEOUT,
  UPLOAD_TIMEOUT
}
