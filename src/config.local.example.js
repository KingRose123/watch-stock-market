/**
 * 本机私有配置 · 模板
 *
 * ⚠️ 首次克隆仓库后，**必须先做这一步**，否则构建会直接失败：
 *
 *     cp src/config.local.example.js src/config.local.js
 *
 * 然后把下面的 API_BASE 改成你自己的后端地址。
 *
 * 为什么不给个默认值兜底：config.local.js 是被 .gitignore 忽略的，
 * 仓库里根本没有它 —— 而 Metro 的 require 是**静态解析**的，
 * 找不到这个模块时打包会报错，try/catch 兜不住。
 * 这正是想要的效果：宁可让人一眼看到"少了一步配置"，
 * 也不要把某台服务器的地址硬编进公开代码里。
 */
module.exports = {
  // 例：'https://api.your-domain.com'
  //
  // 暂时没有 HTTPS 就先用 http:// —— 但要记得同步确认
  // android/app/src/main/AndroidManifest.xml 里的
  // android:usesCleartextTraffic="true" 还开着（Android 9 起默认禁止明文流量）。
  API_BASE: 'http://your-server.example.com'
}
