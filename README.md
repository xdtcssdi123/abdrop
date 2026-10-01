# ABDrop · 极简艾宾浩斯卡片记忆 App

一个**没有多余界面**的记忆 App:首页只有卡片堆叠,滑动即复习。
拍照或手输知识点,AI 归纳成问答卡,按艾宾浩斯曲线自动调度。
**完全兼容 Anki** —— 能导入 `.apkg` 与纯文本导出,也能导出回 Anki。

---

## 三步上手

```bash
pnpm install          # 自动同步 sql.js wasm 到 public/
pnpm dev              # 浏览器调试 http://localhost:3000
pnpm test             # 801 个单测
```

打包移动端:

```bash
pnpm cap:sync         # 构建静态产物 + 同步到 Android/iOS 工程
pnpm cap:android      # 打开 Android Studio
pnpm cap:ios          # 打开 Xcode(需 macOS)
```

---

## 交互设计(首页即全部)

| 手势 | 行为 |
|---|---|
| **单击卡片** | 全屏打开答案(问题收成小标题,答案/图片全屏可滚动;再点一下或返回键关闭) |
| **右滑 > 阈值** | 标记已掌握 · 飘绿色对勾 · 记忆等级 +1 |
| **左滑 > 阈值** | 归入待复习 · 飘黄色时钟 · 等级回到第 1 档重走 |

> 滑动阈值 = 视口宽 1/3,横屏封顶 150px,横竖屏手感一致。
> 只有从**卡片本体**开始的手势才生效:点/滑空白处不会打开答案,也不会带动卡片。

录入与复习分组切换统一在**设置页**(齿轮 → 录入知识点 / 合集管理 → 复习范围),首页不放置任何录入或分组入口。

> Android 返回键:首页按一次提示「再按一次退出」,两秒内再按才退出;设置/管理员页按返回键回退上一页。全屏答案打开时返回键先关闭答案层。

---

## 每日打卡(可选)

设置页「打卡提醒」卡片可开启并配置**开始/结束时间**。开启后:

- 当天若还没打卡,从开始时间起**每小时发一条系统通知**(应用在后台/关闭时由系统按时发出),
  直到完成打卡或到结束时间;
- **刷完全部待复习卡片即自动完成今日打卡**;首页右上角显示**只读打卡状态标签**(不可点击);
- 提醒窗口按整点切片,调度逻辑集中在 `lib/checkin.ts`,全部可单测。

> **调试**:管理员页提供「时间调试」,可临时偏移当前时间(如 +1 天 / 调到明天 9 点),
> 验证到期后 App 的状态(复习队列、打卡)。偏移只影响 App 内时间判断,系统通知仍按真实时钟。

未达阈值的滑动会弹簧回位,不会误判 —— 阈值与仲裁规则集中在
`lib/gesture.ts`,全部可单测。

---

## 架构

```
lib/          纯逻辑层(零框架依赖,测试全覆盖)
  srs.ts            艾宾浩斯调度引擎 —— 经典表 20min/1h/9h/1d/2d/6d/31d × Anki 字段双轨
  gesture.ts        手势状态机(滑动/单击/空白过滤,阈值与互斥)
  motion.ts         动效常量与降级策略
  db.ts             IndexedDB 仓储(内存实现作为降级,接口契约一致)
  markdown.ts       Markdown 渲染(markdown-it + DOMPurify,防注入)
  ai.ts             AI 请求构造与响应解析(纯函数,支持图片识别)
  anki.ts           Anki 解析:HTML 清洗 / TSV / .apkg(SQLite + zstd)
  anki-map.ts       Anki ↔ ABDrop 模型映射(确定性 id,保证幂等导入)
  anki-io.ts        导入导出编排
  review-service.ts 复习主干(滑动 → 调度 → 落库 → 出队)

components/   视图层(只画界面,不含业务规则)
composables/  状态与原生能力桥接
pages/        首页(卡片堆叠) + 设置页(录入知识点 + 打卡/全屏 + 三项管理)
```

### 几个关键决策

**1. 跟手不用动画库。**
补间库会给触摸加一帧以上延迟。卡片拖动直接写 `transform` +
`will-change: transform` 才能保住 60fps 的手指贴合感;而滑出、补位这类
"非跟手"动画才交给 Motion One,缓动统一、可中断。

**2. 记忆等级用固定阶梯,同时保留 Anki 字段。**
间隔由 `level` 决定(经典艾宾浩斯表:20 分钟 → 1 小时 → 9 小时 → 1 天 →
2 天 → 6 天 → 31 天,行为可预测),但 `ivl` / `factor` / `type` / `lapses`
全部算出并持久化 —— 所以 `.apkg` 导入不丢调度信息,导出回 Anki 也合理。
答错回第 1 档重走;同一张卡连续答错 3 次(中途答对清零)顺延到次日。

**3. 导入必须幂等。**
卡片 id 由 `noteId + 字段指纹` 确定性生成,不用随机数。
同一份 `.apkg` 导入两次不会产生重复卡片(有专门测试守着)。

**4. 模型对齐 Anki。**
`front` / `back` / `tags` 与 Anki 笔记字段一一对应,所以三向互操作
(apkg 导入、TSV 导入、导出回 Anki)都不丢信息。

**5. 离线优先。**
sql.js 的 wasm 放在 `public/` 随包发布,不走 CDN;
IndexedDB 不可用时自动降级为内存实现,接口完全一致。

---

## Anki 兼容性

**支持导入**

- `.apkg` / `.colpkg` 集合包 —— 解包 → 读 SQLite → 按模板渲染正反面。
  支持 2.1.50+ 的 zstd 压缩库(`collection.anki21b`),图片导出为 dataURL。
- Anki「导出 → 纯文本」(TSV / CSV) —— 识别 `#separator` / `#columns` /
  `#tags column` / `#deck column` 头部,也兼容无头部的裸 TSV。
- 牌组 `父::子` 取末级作为合集名。

**支持导出**

- Anki TSV / CSV(带回 Anki 可识别的头部指令,可直接导入 Anki)。
- ABDrop 配置快照 JSON(「保存配置」:AI 配置 + 当前复习范围 + 合集 + 卡片与全部复习进度,
  一个文件整体备份;「加载配置」可完整还原,兼容旧版 v2 备份)。

---

## 测试

```
801 个测试 / 29 个套件
```

| 套件(部分) | 覆盖 |
|---|---|
| `srs.spec.ts` | 经典艾宾浩斯间隔、等级推进、连续失败顺延、因子上下限 |
| `db.spec.ts` | 仓储契约 —— **同一套断言跑 IndexedDB 与内存两个实现** |
| `gesture.spec.ts` | 阈值(含横屏封顶)、方向锁、单双击仲裁、空白过滤 |
| `markdown.spec.ts` | Markdown 渲染与防注入 |
| `ai.spec.ts` | 请求构造、四类响应解析、图片识别、模型列表、超时降级 |
| `anki.spec.ts` | HTML 清洗、TSV 解析、模板渲染、导出往返一致性 |
| `apkg.spec.ts` | **用 sql.js 现场造真 `.apkg` 再解析回来** |
| `anki-map.spec.ts` | 确定性 id、幂等导入、牌组→合集 |
| `review-service.spec.ts` | 端到端:录入 → 复习 → 阶梯推进 |
| `pages.spec.ts` | 首页/设置/管理员页集成(手势、打卡、全屏答案、自动打卡) |
| `components.spec.ts` | 卡片正反面、徽标、录入框校验 |
| `viewport.spec.ts` | 键盘避让、横屏卡片尺寸 |

两个刻意的测试设计:

- **契约测试**:`db.ts` 的 IndexedDB 与内存实现跑同一份断言,
  保证降级路径不会悄悄行为不一致。
- **端到端 apkg**:不喂假数据,测试里现场构造结构与 Anki 一致的
  SQLite + zip,再用生产代码解析 —— 这是"兼容 Anki"最硬的证据。

```bash
pnpm test              # 全部
pnpm test:coverage     # 覆盖率
pnpm typecheck         # vue-tsc 严格模式
```

---

## AI 配置

设置页 → AI 接口配置。内置 OpenAI / DeepSeek / Anthropic / 自定义预设。

- 任何失败都**不阻塞录入**:AI 挂掉时照常保存,只是没有归纳内容。
- 未启用 AI 时,原文首句自动作为卡片正面。
- API Key 只存在本机(localStorage / Preferences),不上传任何服务器。

> 浏览器直连第三方 API 需要对方允许 CORS。Anthropic 已通过
> `anthropic-dangerous-direct-browser-access` 头处理;国内使用建议
> DeepSeek 或自建网关。

> 「保存配置」导出的 JSON 文件含 API Key,请勿外传。

---

## 数据存储

ABDrop **全部数据存在本机**,无账号、无云端同步。分两类存储:

### 1. 卡片与合集 → IndexedDB(真正的数据库)

核心数据用 **IndexedDB**(浏览器/App 内置的本地 NoSQL 数据库,经 `idb` 库封装,见 `lib/db.ts`):

| 内容 | 存储位置 |
|---|---|
| 知识卡片(正面/背面/标签/图片/复习调度) | IndexedDB 对象仓库 |
| 合集(未分类 / 数学 / 英语…) | 同上 |

- **全本地、离线可用**,零网络依赖;
- 图片以 **base64(dataURL)** 直接随卡片存储,不依赖外部文件;
- 按 `ankiNoteId` 做导入去重;
- 无 IndexedDB 的环境(SSR / 单测)自动降级为内存实现,接口一致。

> 底层即系统自带的 IndexedDB 文件:Android 在 App 私有目录
> (`/data/data/com.abdrop.app/…`),iOS 同理。**卸载 App 会一并删除**。

### 2. 偏好设置 → localStorage(轻量键值)

小配置项用 localStorage 键值对,不必进数据库:

| 内容 | 存储键 |
|---|---|
| AI 接口配置(地址 / Key / 模型 / 图片识别开关) | `abdrop.ai.config` |
| 当前复习范围 | `abdrop.activeCollection` |
| 打卡日期 / 提醒配置 | `abdrop.checkin.date` · `abdrop.checkin.config` |
| 全屏沉浸开关 | `abdrop.fullscreen` |

### 备份与迁移

数据都存本机、没有云同步,换手机 / 卸载前请先备份:

- 设置页 → **数据导入导出 →「保存配置(含卡片与复习进度)」**,导出一个 JSON;
- 新手机装好后 → **「加载配置(还原备份)」** 完整恢复(含卡片、合集、调度进度与 AI 配置)。
- 另可导出 **Anki TSV/CSV**,或导入 Anki `.apkg` 互通。

> 「保存配置」导出的 JSON 含 API Key,请勿外传。

### AI 识图拆卡

录入框支持**选择多张图片**:每选一张追加进列表;开启「识别图片」后点「AI 识图拆卡」,
**每张图片逐张识别成一张卡片**(正面/背面/关键词),可在录入框里逐张编辑、移除,
保存时一次入库多张卡片(每卡带自己的图片)。单张识别失败不中断其余,失败原因会提示。

---

## 局域网管理(Web 服务)

设置页「局域网管理」面板可在手机本地起一个网页服务:

- 开启后显示形如 `http://192.168.x.x:8080` 的链接,**同一局域网的电脑 / 平板用浏览器打开**即可远程管理;
- 支持:浏览 / 新增 / 删除卡片、管理合集、切换复习范围、调整 AI 配置(apiKey 打码)、打卡开关、全屏;
- 所有操作**直接读写手机里的 IndexedDB / localStorage**,即时生效;
- 端口可在设置页修改(默认 8080),持久化在 `abdrop.lan.port`。

**实现**:Android 原生插件 `LocalServerPlugin`(Kotlin/Java 起极简 HTTP 服务器)→ Capacitor 桥接把请求转发给 JS 层 `lib/lan-api.ts`(纯路由,可单测)→ 管理页 `lib/lan-admin.ts`(单文件 HTML)。仅 Android 原生支持,Web 预览显示"仅原生可用"。

**安全提醒**:服务**无口令**,同网段任何设备都能访问;请仅在可信局域网开启,用完即关。

---

## 检查更新(GitHub Release)

设置页「检查更新」面板从 GitHub Release 获取最新版本:

- App 内比较**当前版本**(原生读 `build.gradle` 的 `versionName`)与 Release 标签(`v1.0.0` 语义化);
- 有新版本时展示更新说明与 APK 大小,一键跳转下载安装;
- 仓库固定为 `xdtcssdi123/abdrop`(改 `lib/update.ts` 的 `UPDATE_REPO_OWNER / UPDATE_REPO_NAME` 可指向自己的 fork);
- 原生走 CapacitorHttp,绕开 CORS;Web 直接 fetch GitHub API。

**发版流程**(打新 release):

1. 改 `android/app/build.gradle` 的 `versionCode`(+1)与 `versionName`(如 `1.1`);
2. 同步 `lib/update.ts` 的 `APP_VERSION / APP_VERSION_CODE`;
3. 重新打包并签名 APK(`dist-apk/ABDrop-<版本>-release.apk`);
4. `gh release create v<版本> dist-apk/*.apk --title "v<版本>" --notes "更新说明"`。

---

## 隐私

- 无账号、无云端、无埋点、无统计上报;
- 网络请求仅两类:用户自己配置的 AI 接口(仅点击「AI 归纳/识图」时),以及「检查更新」时的 GitHub API 请求(仅点击检查时);
- API Key 只存在本机(localStorage / Preferences),不上传任何服务器。
