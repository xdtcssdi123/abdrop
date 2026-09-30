# ABDrop · 极简艾宾浩斯卡片记忆 App

一个**没有多余界面**的记忆 App:首页只有卡片堆叠,滑动即复习。
拍照或手输知识点,AI 归纳成问答卡,按艾宾浩斯曲线自动调度。
**完全兼容 Anki** —— 能导入 `.apkg` 与纯文本导出,也能导出回 Anki。

---

## 三步上手

```bash
pnpm install          # 自动同步 sql.js wasm 到 public/
pnpm dev              # 浏览器调试 http://localhost:3000
pnpm test             # 325 个单测
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
| **单击卡片** | 翻面看答案(先回忆,后核对) |
| **右滑 > 1/3 屏** | 标记已掌握 · 飘绿色对勾 · 记忆等级 +1 |
| **左滑 > 1/3 屏** | 归入待复习 · 飘黄色时钟 · 等级回到 1 |

录入与复习分组切换统一在**设置页**(齿轮 → 录入知识点 / 合集管理 → 复习范围),首页不放置任何录入或分组入口。

> Android 返回键:首页按一次提示「再按一次退出」,两秒内再按才退出;设置/管理员页按返回键回退上一页。

---

## 每日打卡提醒(可选)

设置页「打卡提醒」卡片可开启并配置**开始/结束时间**。开启后:

- 当天若还没打卡,从开始时间起**每小时发一条系统通知**(应用在后台/关闭时由系统按时发出),
  直到完成打卡或到结束时间;
- 首页右上角常驻打卡胶囊,点一下完成今日打卡;打卡状态每天自动重置;
- 提醒窗口按整点切片,调度逻辑集中在 `lib/checkin.ts`,全部可单测。

> **调试**:管理员页提供「时间调试」,可临时偏移当前时间(如 +1 天 / 调到明天 9 点),
> 验证到期后 App 的状态(复习队列、打卡胶囊)。偏移只影响 App 内时间判断,系统通知仍按真实时钟。

未达 1/3 屏的滑动会弹簧回位,不会误判 —— 阈值与仲裁规则集中在
`lib/gesture.ts`,全部可单测。

---

## 架构

```
lib/          纯逻辑层(零框架依赖,测试全覆盖)
  srs.ts            艾宾浩斯调度引擎 —— 1/2/4/7/15 天阶梯 × Anki 字段双轨
  gesture.ts        手势状态机(滑动/单击翻面/下拉识别,阈值与互斥)
  motion.ts         动效常量与降级策略
  db.ts             IndexedDB 仓储(内存实现作为降级,接口契约一致)
  ai.ts             AI 请求构造与响应解析(纯函数)
  anki.ts           Anki 解析:HTML 清洗 / TSV / .apkg(SQLite + zstd)
  anki-map.ts       Anki ↔ ABDrop 模型映射(确定性 id,保证幂等导入)
  anki-io.ts        导入导出编排
  review-service.ts 复习主干(滑动 → 调度 → 落库 → 出队)

components/   视图层(只画界面,不含业务规则)
composables/  状态与原生能力桥接
pages/        首页(卡片堆叠) + 设置页(录入知识点 + 打卡提醒 + 三项管理)
```

### 几个关键决策

**1. 跟手不用动画库。**
补间库会给触摸加一帧以上延迟。卡片拖动直接写 `transform` +
`will-change: transform` 才能保住 60fps 的手指贴合感;而滑出、补位这类
"非跟手"动画才交给 Motion One,缓动统一、可中断。

**2. 记忆等级用固定阶梯,同时保留 Anki 字段。**
间隔由 `level` 决定(行为可预测,用户看得懂为什么明天又出现),
但 `ivl` / `factor` / `type` / `lapses` 全部算出并持久化 ——
所以 `.apkg` 导入不丢调度信息,导出回 Anki 也合理。

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
325 个测试 / 9 个套件
```

| 套件 | 覆盖 |
|---|---|
| `srs.spec.ts` | 阶梯间隔、等级推进、因子上下限、到期排序 |
| `db.spec.ts` | 仓储契约 —— **同一套断言跑 IndexedDB 与内存两个实现** |
| `gesture.spec.ts` | 阈值、方向锁、单双击仲裁、手势互斥 |
| `ai.spec.ts` | 请求构造、四类响应解析、超时与错误降级 |
| `anki.spec.ts` | HTML 清洗、TSV 解析、模板渲染、导出往返一致性 |
| `apkg.spec.ts` | **用 sql.js 现场造真 `.apkg` 再解析回来** |
| `anki-map.spec.ts` | 确定性 id、幂等导入、牌组→合集 |
| `review-service.spec.ts` | 端到端:录入 → 复习 → 阶梯推进 |
| `components.spec.ts` | 卡片正反面、徽标、录入框校验 |

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

## 数据与隐私

全部数据存在本机 IndexedDB,无账号、无云端、无埋点。
唯一的网络请求是用户自己配置的 AI 接口(且仅在点击「AI 归纳」时发生)。
