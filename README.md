# 收息佬 · App

面向「攒股收息」投资者的记账与内容客户端：记录持仓与分红、看持仓的真实
收益率、浏览收息相关的社区内容。

> **这个仓库只有客户端。** 服务端与后台管理台不在其中，因此这里既没有
> 服务端代码，也**没有任何服务器地址** —— 地址在本地配置文件里，
> 由使用者自己填（见下面的「必须先做」）。

## 技术栈

| | |
|---|---|
| 框架 | React Native 0.79 + Expo 53 |
| 引擎 | Hermes，新架构（Fabric / TurboModules）已开启 |
| 导航 | React Navigation 7（栈 + 底部悬浮标签栏） |
| 图表 | react-native-svg |
| 目标平台 | Android（默认只打 `arm64-v8a`） |

## 目录结构

```
App.js                     应用入口：导航容器与页面注册
app.json                   Expo 配置（包名、版本、图标、权限）
index.js                   RN 注册入口
babel.config.js
src/
  app.js                   全局 App 实例（登录态、引导、会员档位）
  config.js                配置读入口 —— 后端地址从 config.local.js 来
  config.local.example.js  ⚠️ 必须复制成 config.local.js 才能构建
  theme.js                 配色与通用样式（全 App 观感的唯一来源，换肤改这里）
  screens/                 页面：持仓 / 社区 / 发现 / 我的 / 各种二级页
  components/              通用组件（图标、悬浮标签栏、图片、骨架屏…）
  utils/                   数据层
    api.js                   唯一的数据读写入口，统一返回 { code, msg, data }
    store.js                 本地状态与云端快照
    quote.js                 行情 / 分红 / 基金净值
    cloud.js                 后端请求（登录态、token、超时）
    util.js / validate.js / membership.js / poll.js / toolRoutes.js …
  compat/                  小程序 API 的适配层（setData、导航封装、storage…）
android/                   Android 原生工程（Gradle）
assets/                    图标源图
_gen_icons.py              从源图生成各档 mipmap 的脚本（可选，需要 Pillow）
```

## 快速开始

### 环境要求

- Node.js 18+
- JDK 17
- Android SDK（platform 35、build-tools 36）+ 一台已授权的设备或模拟器

### 1. 安装依赖

```bash
npm install
```

### 2. ⚠️ 配置后端地址（必做，否则构建会失败）

```bash
cp src/config.local.example.js src/config.local.js
```

然后编辑 `src/config.local.js`，把 `API_BASE` 改成你自己的后端地址。

这个文件在 `.gitignore` 里，**不会被提交** —— 仓库里公开的永远只是模板。

> 为什么不做个默认值兜底：Metro 的 `require` 是静态解析的，找不到
> `config.local.js` 时打包会直接报错，`try/catch` 兜不住。这是刻意的 ——
> 与其把某台服务器的地址硬编进公开代码，不如让人一眼看到"少了一步配置"。

### 3. 配置发布签名（只有要打 release 包时才需要）

```bash
cp android/keystore.properties.example android/keystore.properties
```

按模板里的说明用 `keytool` 生成自己的 keystore，再把密码填进去。
同样不会被提交。

### 4. 跑起来

```bash
npm run android        # 调试版，装到已连接的设备
```

Windows 下也可以直接双击 `build-dev.bat`（它会推断 Android SDK 位置）。

## 构建发布版

```bash
cd android
./gradlew assembleRelease
```

产物在 `android/app/build/outputs/apk/release/app-release.apk`。

> ⚠️ **不要用 `gradlew clean`**。本项目是新架构，原生代码走 CMake 编译；
> `clean` 会删掉 `build/` 却留下 `.cxx/`，两者引用关系断掉后 CMake 重新
> 生成会失败（`CMake Generate step failed`）。要重新构建直接跑
> `assembleRelease` 即可 —— JS 改动每次都会重新打 bundle，不会漏。

## 几个说明

- **数据存在哪**：账户、持仓、交易、分红记录默认都在本机
  （`AsyncStorage`），可整份同步到你自己的后端；行情来自公开行情接口。
- **后端接口**：请求封装在 `src/utils/cloud.js`，路径约定见该文件顶部注释。
- **换肤**：全 App 配色集中在 `src/theme.js`，改那一个文件即可切换
  （内置「科技蓝」「经典绿」「黑白灰·橙」三套）。
- **图标**：桌面图标有普通 / Pro 两套，通过 `activity-alias` 切换，
  见 `android/app/src/main/AndroidManifest.xml` 的注释。

## 许可

暂未指定开源许可证。若要公开分发，请自行补充 `LICENSE`。
