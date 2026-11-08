/**
 * CSDN → PDF 清净阅读工具 · Cloudflare Worker
 *
 * 职责：/api/extract?url=<CSDN 文章链接>
 *   1. 校验并规范化 URL（只接受 blog.csdn.net 的文章页）
 *   2. 服务端抓取文章页 HTML（免登录，正文完整，已实测）
 *   3. VIP/付费文章 → 明确拒绝（本工具的约定边界）
 *   4. 解析出标题 + 正文（#content_views），剥除一切 CSDN 脚手架
 *   5. 白名单清洗属性，杜绝脚本注入，图片加 no-referrer 破防盗链
 *   6. 返回 { title, html }，用完即弃，服务端零存储
 */

import { parse } from 'node-html-parser';

export interface Env {
  ASSETS: Fetcher;
  /** 可选：CSDN 登录态 Cookie。配置后"关注可见"的截断文章也能拿全文（wrangler secret put CSDN_COOKIE） */
  CSDN_COOKIE?: string;
  /** Browser Rendering 绑定（Cloudflare 付费版）：POST /api/pdf 渲染 PDF */
  BROWSER?: BrowserRun;
}

/** PDF 渲染参数（学自 ipynb-to-pdf worker）：Letter、2cm、书签大纲、页脚页码 */
const PDF_OPTIONS = {
  pdfOptions: {
    format: 'letter' as const,
    printBackground: true,
    preferCSSPageSize: true,
    outline: true,
    displayHeaderFooter: true,
    footerTemplate:
      `<div style="width:100%;font-size:9px;color:#888;text-align:center;` +
      `font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">` +
      `第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>`,
    headerTemplate: '<div></div>',
    margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' },
    timeout: 30000,
  },
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 允许 jupiter.blog.csdn.net 这类子域名 */
const CSDN_ARTICLE_RE =
  /^https?:\/\/([a-z0-9-]+\.)*blog\.csdn\.net\/[^/?#]+\/article\/details\/\d+\/?(\?.*)?$/i;

function canonicalize(raw: string): string | null {
  const trimmed = raw.trim();
  if (!CSDN_ARTICLE_RE.test(trimmed)) return null;
  const u = new URL(trimmed);
  // 去掉 spm 等追踪参数，只留干净路径
  return `https://${u.host}${u.pathname}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 清洗时整个剥掉的元素：评论框、脚本、外挂卡片…… */
const JUNK_SELECTORS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'form',
  'button',
  'input',
  'noscript',
  '.hide-article-box', // “关注博主即可阅读全文”遮罩（正文本来就完整）
  '.hljs-button', // 代码复制按钮
  '.csdn-tracking-statistics',
  '.recommend-box',
  '.template-box', // 文末“技术共进”模板卡
];

/** 允许保留的标签，其余连内容一起丢弃 */
const KEEP_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'PRE', 'CODE',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
  'IMG', 'A', 'BR', 'HR',
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'SUP', 'SUB', 'KBD',
  'SPAN', 'DIV', 'SECTION', 'FIGURE', 'FIGCAPTION', 'CENTER', 'FONT',
]);

/** 各标签允许保留的属性（class 只在 pre 内部保留，给代码高亮用） */
function allowedAttrs(tag: string): string[] {
  switch (tag) {
    // 锚点 a 保留 id：CSDN 把标题锚点放在标题内空 <a id> 上，正文目录跳转靠它
    case 'A': return ['href', 'title', 'id'];
    case 'IMG': return ['src', 'alt', 'title'];
    case 'OL': return ['start'];
    case 'TH': case 'TD': return ['colspan', 'rowspan'];
    // 标题保留 id：正文目录（文章目录）的锚点跳转靠它，Chrome 打印成 PDF 后链接依然可点
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
      return ['id'];
    default: return [];
  }
}

/** 判断节点是否位于某个 <pre> 内部（决定 class 属性去留） */
function insidePre(el: { parentNode: unknown }): boolean {
  let node = el.parentNode as { tagName?: string; parentNode?: unknown } | null;
  while (node) {
    if (node.tagName === 'PRE') return true;
    node = (node.parentNode ?? null) as { tagName?: string; parentNode?: unknown } | null;
  }
  return false;
}

function extractArticle(html: string): { title: string; html: string } | null {
  const root = parse(html);

  // ---- 标题：h1 优先，og:title 兜底，最后 <title> 去后缀 ----
  let title =
    root.querySelector('h1.title-article')?.textContent?.trim() ||
    root.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    root.querySelector('title')?.textContent?.replace(/_.*?CSDN.*?博客.*/, '').trim() ||
    '';

  // ---- 正文容器（多个选择器兜底，防 CSDN 小改版）----
  const content =
    root.querySelector('#content_views') ??
    root.querySelector('.article_content') ??
    root.querySelector('.markdown_views');
  if (!content) return null;

  // ---- 整块剥除垃圾 ----
  for (const sel of JUNK_SELECTORS) {
    for (const el of content.querySelectorAll(sel)) el.remove();
  }

  // ---- 属性白名单 + class 特赦（代码高亮）----
  for (const el of content.querySelectorAll('*')) {
    const tag = (el.tagName ?? '').toUpperCase();
    if (tag && !KEEP_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    const allowed = allowedAttrs(tag);
    if (insidePre(el) && (tag === 'CODE' || tag === 'SPAN' || tag === 'PRE')) {
      allowed.push('class');
    }
    for (const attr of Object.keys(el.attributes)) {
      if (!allowed.includes(attr)) el.removeAttribute(attr);
    }
    // 图片一律 no-referrer 破 csdnimg.cn 防盗链
    if (tag === 'IMG') el.setAttribute('referrerpolicy', 'no-referrer');
  }

  // ---- 删空壳节点（无文字也无图的 p/div/section/li/blockquote）----
  for (const el of content.querySelectorAll('p, div, section, li, blockquote, span')) {
    const tag = el.tagName?.toUpperCase();
    if (['P', 'DIV', 'SECTION', 'LI', 'BLOCKQUOTE', 'SPAN'].includes(tag)) {
      if (!el.text.trim() && !el.querySelector('img')) el.remove();
    }
  }

  title = title || '未命名文章';
  return { title, html: content.innerHTML };
}

async function handleExtract(url: URL, env: Env): Promise<Response> {
  const target = canonicalize(url.searchParams.get('url') ?? '');
  if (!target) {
    return json(
      { error: '请粘贴 CSDN 文章链接，形如 https://blog.csdn.net/xxx/article/details/123456' },
      400,
    );
  }

  const headers: Record<string, string> = {
    'user-agent': BROWSER_UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: 'https://blog.csdn.net/',
  };
  // 登录态：配了 secret 才带，直接原样作为 Cookie 头
  if (env.CSDN_COOKIE) headers.cookie = env.CSDN_COOKIE;

  let resp: Response;
  try {
    resp = await fetch(target, {
      headers,
      redirect: 'follow',
    });
  } catch {
    return json({ error: '抓取失败：网络异常，稍后再试。' }, 502);
  }

  if (!resp.ok) {
    if (resp.status === 403 || resp.status === 412 || resp.status === 503) {
      return json(
        { error: `CSDN 拦截了本次请求（HTTP ${resp.status}，疑似 WAF 风控）。稍等几分钟再试。` },
        502,
      );
    }
    return json({ error: `抓取失败：目标站返回 HTTP ${resp.status}` }, 502);
  }

  const html = await resp.text();

  // ---- 付费内容判定（组合判据，避免单信号误杀）----
  // 遮罩盒文案含购买字样，或 付费专栏购买按钮（data-price）+ articleType=1 同时出现 → 拒绝
  const boxMatch = html.match(/<div class="hide-article-box[\s\S]{0,1200}?<\/div>/);
  const boxText = boxMatch ? boxMatch[0].replace(/<[^>]+>/g, ' ') : '';
  const paidColumnBtn = /class="[^"]*articleColumnBt[^"]*"/.test(html) && /data-price="\d/.test(html);
  const isPaid = /VIP|付费|解锁|下载积分|订阅专栏解锁/.test(boxText) || paidColumnBtn;
  if (isPaid && /\barticleType\s*=\s*1\b/.test(html)) {
    return json({ error: '这是一篇 VIP/付费专栏文章，本工具不做（约定边界）。' }, 403);
  }

  const article = extractArticle(html);
  if (!article) {
    return json(
      { error: '没找到正文：文章可能已被删除，或 CSDN 改版了。' },
      404,
    );
  }

  // 截断检测：正文文本量异常少（< 1200 字）且页面带"关注可见"遮罩（免费截断文）。
  // 付费专栏已在上面拒绝；这里抓的是"未登录只给开头"的免费文章。
  const textLen = article.html.replace(/<[^>]+>/g, '').length;
  const followOnlyBox = /hide-article-box/.test(html) && /关注博主/.test(html);
  const truncated = textLen < 1200 && followOnlyBox;
  return json({ ...article, truncated });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/extract') {
      return handleExtract(url, env);
    }

    // POST /api/pdf：前端送来完整打印 HTML，Browser Rendering 渲成 PDF 流式返回
    if (url.pathname === '/api/pdf') {
      if (request.method !== 'POST') {
        return json({ error: 'Method Not Allowed: POST only' }, 405);
      }
      if (!env.BROWSER) {
        return json(
          { error: '云端 PDF 引擎未启用（需要 Cloudflare 付费版 Workers 的 Browser Rendering 绑定）。本地请运行 npm run pdf-server。' },
          501,
        );
      }
      let body: { html?: string; filename?: string };
      try {
        body = (await request.json()) as { html?: string; filename?: string };
      } catch {
        return json({ error: '请求体不是合法 JSON' }, 400);
      }
      const html = body.html ?? '';
      if (html.length < 20) return json({ error: '缺少 html 字段或内容过短' }, 400);
      // 上限保护：免费档浏览器时长有限（约 25MB 文本）
      if (html.length > 25_000_000) return json({ error: 'HTML 过大' }, 413);

      try {
        const pdf = await env.BROWSER.quickAction('pdf', { html, ...PDF_OPTIONS });
        const filename = (body.filename ?? 'article').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || 'article';
        const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
        return new Response(pdf.body, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}.pdf`,
          },
        });
      } catch (e) {
        return json({ error: `浏览器渲染失败：${e instanceof Error ? e.message : String(e)}` }, 502);
      }
    }

    // 其余请求交给静态资源（vite build 产物）
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
