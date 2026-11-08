# Description

## 中文版

csdn-to-pdf 是 Cloudflare Workers 上的 CSDN 文章清净阅读与转 PDF 工具：粘贴链接，服务端抓取正文、剥除评论侧栏广告，只留标题与正文，一键存成 A4 PDF。含金量在净化与打印工程：标签属性双白名单拒绝默认净化堵 innerHTML 注入，正文图片 no-referrer 破 csdnimg.cn 防盗链，标题与正文容器三级兜底抗改版，组合判据付费检测防误杀，双条件截断检测诚实提示，A4 打印 CSS 防代码块跨页截断；VIP/付费文章明确拒绝，服务端零存储。工程为 main.ts 三状态机加 index.ts 净化管线，node-html-parser 解析，静态资产与 API 同 Worker 一次部署，适合常读 CSDN 要干净存档的开发者。

## English

csdn-to-pdf turns a CSDN blog article into a clean reading page — and then a print-ready A4 PDF — with one paste. A Cloudflare Worker fetches the article server-side (no CORS walls, full browser-like headers), strips every piece of CSDN scaffolding, and returns only the title and body. Its craft lives in sanitization and print engineering: a deny-by-default dual whitelist (tags + per-tag attributes) closes innerHTML injection, body images ship with referrerpolicy=no-referrer to defeat csdnimg.cn hotlink protection, triple-fallback selectors for the title and content container absorb site redesigns, a multi-signal paywall check rejects VIP/paid columns without killing free ones, and a dual-condition truncation probe honestly flags articles cut by login-gated previews. Print layout is pure CSS: @page A4 with break-inside:avoid keeps code blocks, tables and images from splitting across pages. Zero storage — nothing is persisted anywhere. Built as a src/main.ts three-state frontend plus a worker/src/index.ts sanitization pipeline on node-html-parser, with static assets and API served by one Worker for one-command deploys.
