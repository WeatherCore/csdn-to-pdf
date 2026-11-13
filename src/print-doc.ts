/**
 * print-doc.ts — 打印文档构造（学自 ipynb-to-pdf 的 render.ts buildPrintDocument）
 *
 * 把阅读页的正文包成一段自包含、可打印的完整 HTML：
 * - 自带 PRINT_CSS，与云端/本地引擎的 @page 参数严格一致（Letter、2cm 边距）
 * - print-color-adjust: exact 保证代码底色、表格条纹进 PDF
 * - 代码块/表格/图片防劈开，标题不孤悬页底
 * - 永远浅色（打印场景，不受系统深色模式影响）
 */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

/** PDF 文件名清洗：去掉 Windows/浏览器不允许的字符 */
export function sanitizeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'csdn-article').slice(0, 80);
}

export const PRINT_CSS = `
@page { size: letter; margin: 2cm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; color: #222; font-size: 10.5pt; line-height: 1.85;
  font-family: -apple-system, "Segoe UI", "Helvetica Neue", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif;
  word-wrap: break-word;
}
.article-print { padding: 0 4px; }

/* ---------- 标题：纯文字层级，字号字重区分（对齐参考版裁决） ---------- */
.doc-title { font-size: 1.9em; text-align: center; margin: 0 0 1.2em; line-height: 1.35; }
.article-print h1 { font-size: 1.55em; margin: 1.1em 0 .5em; line-height: 1.35; font-weight: 700; break-after: avoid; }
.article-print h2 { font-size: 1.35em; margin: 1.1em 0 .5em; line-height: 1.35; font-weight: 700; break-after: avoid; }
.article-print h3 { font-size: 1.2em; margin: 1em 0 .4em; font-weight: 700; break-after: avoid; }
.article-print h4, .article-print h5, .article-print h6 { margin: 1em 0 .4em; font-weight: 700; break-after: avoid; }
.article-print p { margin: .5em 0; }
.article-print ul, .article-print ol { margin: .4em 0; padding-left: 2em; }
.article-print li { margin: .18em 0; }
.article-print blockquote {
  margin: .6em 0; padding: .1em 1em; color: #555; border-left: 4px solid #dfe2e5;
}
.article-print hr { border: none; border-top: 1px solid #ddd; margin: 1em 0; }
.article-print a { color: #106ba3; text-decoration: none; }
.article-print code {
  font-family: "JetBrains Mono", Consolas, "Courier New", "PingFang SC", "Microsoft YaHei", monospace;
  font-size: .88em; background: #f5f5f5; border-radius: 3px; padding: .08em .35em;
}

/* ---------- 代码块：浅底色，允许跨页切割（整块避断会把长块推下页、留大片空白） ---------- */
.article-print pre {
  margin: .6em 0; padding: 8px 12px; overflow-x: hidden;
  background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4px;
  font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
  font-size: .85em; line-height: 1.55;
  white-space: pre-wrap; word-break: break-all;
  color: #1f2328;
}
.article-print pre code { background: none; padding: 0; font-size: 1em; color: inherit; }

/* ---------- 表格：原味细线风，允许跨页切割；整行仍不劈开（按行切，不切行中间） ---------- */
.article-print table {
  border-collapse: collapse; margin: .6em 0; max-width: 100%;
  font-size: .95em;
}
.article-print tr { break-inside: avoid; }
.article-print th, .article-print td {
  border: 1px solid #d8d8d8; padding: 4px 9px; text-align: left; vertical-align: top;
}
.article-print th { background: #f4f4f4; font-weight: 700; }
.article-print tr:nth-child(even) td { background: #fafafa; }

/* ---------- 图片：不劈开、不超宽 ---------- */
.article-print img { max-width: 100%; height: auto; break-inside: avoid; }

/* ---------- 代码高亮：GitHub 风浅色（Prism token：CSDN 服务端自带 token/* 标记；hljs 兜底）
   与 style.css 阅读页配色严格一致（共识：两处同色） ---------- */
.token.comment, .token.prolog, .token.cdata { color: #6a737d; font-style: italic; }
.token.doctype, .token.punctuation { color: #1f2328; }
.token.keyword, .token.selector-tag, .token.literal { color: #d73a49; }
.token.string, .token.char, .token.regexp, .token.addition { color: #032f62; }
.token.number, .token.boolean, .token.constant, .token.symbol { color: #005cc5; }
.token.title, .token.name, .token.selector-id, .token.function { color: #6f42c1; }
.token.attr-name, .token.attribute, .token.variable, .token.template-variable { color: #e36209; }
.token.section, .token.type, .token.builtin { color: #22863a; }
.token.operator, .token.entity, .token.url { color: #d73a49; }
.token.macro.property, .token.directive-hash { color: #e36209; }
.token.directive { color: #d73a49; }
.token.tag { color: #22863a; }
.token.deleted { color: #b31d28; }
.token.italic { font-style: italic; }
.token.bold { font-weight: 700; }
.hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal { color: #d73a49; }
.hljs-string, .hljs-regexp, .hljs-addition { color: #032f62; }
.hljs-number, .hljs-built_in, .hljs-symbol { color: #005cc5; }
.hljs-title, .hljs-name, .hljs-selector-id { color: #6f42c1; }
.hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable { color: #e36209; }
.hljs-section, .hljs-type { color: #22863a; }
`;

/** 导出/云端发送用的完整文档：与引擎 PDF 参数（Letter、2cm）严格一致 */
export function buildPrintDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<article class="article-print"><h1 class="doc-title">${esc(title)}</h1>${bodyHtml}</article>
</body>
</html>`;
}
