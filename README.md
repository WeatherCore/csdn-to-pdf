<div align="center">

# 📄 CSDN → PDF

**把一篇 CSDN 文章"读干净"——粘贴链接，得到只含标题与正文的清净阅读页，一键存成 A4 排版的 PDF。**

*Read CSDN articles clean, then keep them as PDF.* / Vite + TypeScript · Cloudflare Workers · 零存储

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/)
[![No Framework](https://img.shields.io/badge/frontend-zero--framework-000000?style=flat-square)](./src/main.ts)
[![Storage](https://img.shields.io/badge/storage-zero-10B981?style=flat-square)](#-核心亮点)

[快速开始](#-快速开始) · [架构总览](#-架构总览) · [核心亮点](#-核心亮点) · [项目结构](#-项目结构)

</div>

---

## 🤔 这是什么

CSDN 的文章页塞满了评论区、侧栏、广告、AI 摘要和"关注博主"遮罩——直接 Ctrl+P 打印，纸上是垃圾场。

**csdn-to-pdf** 是一台"正文榨汁机"：

1. 粘贴一篇 `blog.csdn.net` 文章链接；
2. 服务端（Cloudflare Worker）抓取页面，**白名单净化**：剥掉一切脚手架，只留标题与正文；
3. 浏览器呈现清净阅读页（代码高亮、图片、目录锚点原样保留）；
4. 点"打印 / 存 PDF"——**无打印对话框**，本地/云端无头引擎直接渲染并下载成品 PDF（Letter 纸、侧边栏书签大纲、页脚页码）。

> **约定边界**：VIP / 付费专栏文章直接拒绝，本工具不做（403）。免费正文读完即走，服务端**零存储**——不落库、不缓存、不留痕。

<details>
<summary><b>💡 为什么不直接浏览器里抓 CSDN？</b>（点击展开）</summary>

CSDN 不提供跨域 CORS 头，浏览器直连会被同源策略拦截；图片防盗链（csdnimg.cn）也按 referer 拒绝外站。所以抓取必须放在服务端：没有 CORS 限制，还能伪装完整的浏览器请求头，并给图片统一加 `no-referrer` 破防盗链。
</details>

## ✨ 功能全景

- 🧹 **剥掉脚手架** — 评论区/侧栏/广告/复制按钮/AI 摘要，一个不留（`JUNK_SELECTORS`，worker/src/index.ts:44）
- 🛡️ **白名单净化** — 标签与属性双白名单，杜绝脚本注入，`innerHTML` 注入有三道闸（index.ts:64-87）
- 🖼️ **图片防盗链破解** — 正文图片统一 `referrerpolicy="no-referrer"`（index.ts:136）
- 📝 **代码高亮保留** — `pre` 内 `CODE/SPAN` 特赦 class，自绘 6 类 hljs 配色，零高亮库依赖（index.ts:129，style.css:346）
- 📑 **目录锚点可点** — 标题 `id` 与正文空锚点保留，打印成 PDF 后目录跳转依然有效（index.ts:78-84）
- 🖨️ **无对话框 PDF 引擎** — 双引擎路由：本地无头 Chromium（puppeteer-core 驱动本机 Edge/Chrome）→ 云端 Browser Rendering，产出带 **PDF 书签大纲（h1-h3）** + **页脚页码** 的成品文件，逻辑学自 ipynb-to-pdf（server/local-pdf.ts / src/print-doc.ts）
- 🖼️ **图片等待兜底** — PDF 渲染前等待网络空闲 + 逐张确认图片加载，CSDN 图床慢图不缺页（server/local-pdf.ts:104-108）
- 🌗 **自动深浅双模式** — `prefers-color-scheme` 整套换色，含打印专属浅色皮（style.css:31-48）
- ⚠️ **截断诚实提示** — "关注可见"文章只抓到开头时亮黄条告知，并给出补救路径（index.ts:214-218）
- 🚫 **付费边界拒绝** — 组合判据识别 VIP/付费专栏，明确拒绝不误杀（index.ts:196-204）
- 🕳️ **零存储** — 抓完即走，Worker 无数据库、无缓存、无日志留存

## 🏗️ 架构总览

```mermaid
flowchart TB
    subgraph FE["浏览器 · 单页三状态（零框架）"]
        HOME["home<br/>粘贴链接 + 示例按钮"]
        SKEL["loading<br/>骨架屏"]
        READER["reading<br/>清净阅读页"]
        PRINT["window.print()<br/>@media print 换皮"]
    end

    subgraph WK["Cloudflare Worker（静态 + API 同体）"]
        ROUTE{"default.fetch<br/>路由分发"}
        API["handleExtract<br/>校验 → 抓取 → 付费判定<br/>→ 净化 → 截断检测"]
        SAN["extractArticle<br/>剥壳 · 白名单 · 瘦身"]
        ASSETS["ASSETS binding<br/>vite build 产物 dist/"]
    end

    CSDN["blog.csdn.net<br/>文章页 HTML"]

    HOME -- "GET /api/extract?url=…" --> ROUTE
    ROUTE -- "/api/*" --> API
    ROUTE -- "其余路径" --> ASSETS
    API --> SAN
    SAN -- "伪装浏览器头抓取<br/>(可选 CSDN_COOKIE)" --> CSDN
    API -- "JSON {title, html, truncated}" --> READER
    READER --> PRINT
    HOME -.->|HTTP 5173<br/>dev 代理 8787| ROUTE
```

| 层 | 技术 | 落点 |
|---|---|---|
| 前端 | Vite 8 + TypeScript 7，零框架单页 | `index.html` / `src/main.ts` / `src/style.css` |
| 后端 | Cloudflare Worker（fetch 处理器） | `worker/src/index.ts` |
| 解析 | node-html-parser（唯一业务依赖） | `worker/src/index.ts:13` |
| 部署 | wrangler 4，静态资产与 API 同一 Worker | `wrangler.toml` |

## 💡 核心亮点

1. **白名单净化管线（deny-by-default）** — 不是拉黑名单拦截，而是"没申报的一律没收"：`KEEP_TAGS` 31 个标签之外连内容删除，每个标签属性按 `allowedAttrs` 收窄，script/iframe/表单在 `JUNK_SELECTORS` 阶段整块剥除。这是 `innerHTML` 注入前的安全前提（worker/src/index.ts:64-137）。
2. **三级兜底对抗改版** — 标题取值 `h1.title-article → og:title → <title>`、正文容器 `#content_views → .article_content → .markdown_views`，CSDN 小改版不致全挂（index.ts:103-114）。
3. **打印皮与工具皮分离** — 前端只调一次 `window.print()`，A4 版式、页边距、防跨页截断、隐藏工具界面全部由 22 行打印 CSS 声明，打印链路零 JS（src/style.css:392-413）。
4. **组合判据付费检测** — 遮罩文案付费字样 ∨（购买按钮 ∧ data-price），且需 `articleType=1` 前置条件——多信号防止误杀免费文章（index.ts:196-204）。
5. **一个部署全搞定** — `wrangler.toml` 把 `dist/` 挂成 `ASSETS` 绑定，Worker 一个 `fetch` 同时服务静态页与 `/api`，`npm run deploy` 一次上线（index.ts:222-231）。
6. **no-referrer 破防盗链** — 给所有正文图片强制 `referrerpolicy="no-referrer"`，csdnimg.cn 对"无来源"请求放行（index.ts:136）。

## 🗂️ 项目结构

```
csdn-to-pdf/
├── 🌐 index.html          # 单页骨架：顶栏双态 + home/skeleton/reader 三状态
├── 📁 src/                # ─── 前端（Vite 构建）───
│   ├── ⚛️ main.ts         # 三值状态机 + 事件绑定 + API 调用（98 行）
│   ├── 🎨 style.css       # 设计 token / 三状态样式 / 打印排版（423 行）
│   └── 🏷️ vite-env.d.ts   # Vite 类型声明
├── 📁 worker/             # ─── 后端（Cloudflare Worker）───
│   ├── ⭐ src/index.ts    # 全部业务逻辑：抓取 + 净化管线 + 路由（231 行）
│   └── 🏷️ tsconfig.json   # workers-types 配置
├── ⚙️ vite.config.ts      # dev 时 /api 代理到 wrangler (8787)
├── ⚙️ wrangler.toml       # ASSETS 绑定 dist/，静态与 API 同 Worker
└── 📦 package.json        # dev:fe / dev:api / build / preview / deploy / typecheck
```


## 🚀 快速开始

**0️⃣ 环境要求**

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | npm 随附 |
| Cloudflare 账号 | 可选 | 仅部署需要 |

**1️⃣ 安装依赖**

```bash
npm install
```

**2️⃣ 启动本地开发（两个终端）**

```bash
npm run dev:api    # 终端 1：wrangler dev → API @ http://127.0.0.1:8787
npm run dev:fe     # 终端 2：Vite dev → 页面 @ http://localhost:5173（/api 已代理）
```

**3️⃣ 体验核心链路**

1. 打开 [http://localhost:5173](http://localhost:5173)
2. 点"试一试"任一示例文章（一键填入并转换）
3. 阅读页点 **打印 / 存 PDF** → 本地引擎直接下载成品 PDF（需先跑 `npm run pdf-server`；未启动时会给出明确指引）

**4️⃣ 类型检查 / 构建 / 部署**

```bash
npm run typecheck    # 前端 + 后端双 tsconfig 校验
npm run pdf-server   # 本地 PDF 引擎（无头 Chromium，端口 8788）
npm run preview      # 本地全真预览：一个端口同时服务页面与 API
npm run deploy       # 构建 + 部署到 Cloudflare Workers
```

## ⚙️ 配置说明

| 配置 | 位置 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| Worker 名 / 兼容日期 | `wrangler.toml` | 否 | `csdn-to-pdf` / `2025-01-01` | 部署标识与运行时行为快照 |
| 静态资产绑定 | `wrangler.toml [assets]` | 否 | `directory=./dist`，`binding=ASSETS` | 与 vite `outDir` 对齐 |
| dev 代理 | `vite.config.ts` | 否 | `/api → 127.0.0.1:8789` | 仅 `dev:fe` 生效 |
| 本地 PDF 引擎端口 | `server/local-pdf.ts` / `$env:PDF_SERVER_PORT` | 否 | `8788` | 8787 留给 ipynb-to-pdf 的 pdf-server |
| `CSDN_COOKIE` | `wrangler secret put` / 本地 `.dev.vars` | 否 | 无 | 登录态 Cookie，"关注可见"截断文章拿全文用。已随 fetch 发送（index.ts:187-199） |

💡 **最低可用配置**：以上全部留默认即可运行——`npm install` 后两条 dev 命令就能转换文章。

## 🗺️ Roadmap

- [x] 服务端抓取 + URL 白名单校验
- [x] 白名单净化（标签 + 属性 + 空壳清理）
- [x] 图片 no-referrer 破防盗链
- [x] 代码高亮 class 保留与自绘配色
- [x] ~~A4 打印排版~~ → 无对话框 PDF 引擎（书签大纲 + 页脚页码，学自 ipynb-to-pdf）
- [x] VIP/付费文章边界拒绝 + 截断诚实提示
- [x] 深浅双模式 + 窄屏适配
- [x] 修复 `CSDN_COOKIE` 未随 fetch 发送的缺陷（fetch 现引用 headers 变量）
- [ ] `a[href]` scheme 校验（拦截 `javascript:` 链接）
- [ ] 导出 Markdown
- [ ] 适配第二个站点（如掘金 / 博客园）

<div align="center">

**只留正文，其他全清。**

觉得有用请点一个 ⭐ · Fork → Branch → PR 欢迎参与

</div>
