/**
 * 本地导出服务 — 无头 Chromium（本机 Edge/Chrome）直接渲染 PDF。
 * 逻辑忠实移植自 ipynb-to-pdf 的 server/local-pdf.ts：
 * 无打印对话框、参数全代码控制、产出带侧边栏书签大纲（outline，h1-h3 自动生成）
 * + 页脚页码。差异：端口 8788 起（本项目 8789 被 wrangler dev 占用），
 * 并接受 body.filename 作为下载文件名。
 *
 * 启动：npm run pdf-server（仅监听 127.0.0.1）
 */

import puppeteer, { Browser } from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.PDF_SERVER_PORT ?? 8788);
/** 允许调用本服务的来源（vite dev 5173 + wrangler dev 8789 + vite preview 4173） */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8789',
  'http://127.0.0.1:8789',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

/** 本机浏览器定位：优先 Edge，回退 Chrome */
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('未找到 Edge/Chrome，请确认已安装');
  browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--disable-gpu', '--no-first-run'],
  });
  return browser;
}

/** 与 print-doc.ts PRINT_CSS 的 @page 一致：Letter、2cm 边距 */
const PDF_OPTS = {
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    `<div style="width:100%;font-size:9px;color:#888;text-align:center;` +
    `font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">` +
    `第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>`,
  margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' },
  outline: true, // PDF 侧边栏书签大纲（Chromium 实验特性）
  timeout: 120_000,
} as const;

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_') || 'article';
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}.pdf`;
}

function cors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin ?? '';
  // DNS rebinding / 恶意网页加固（学自 ipynb-to-pdf）：仅接受本机来源与 Host，其余一律 403/404
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'origin not allowed' }));
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  // 无 Origin 的请求（curl / 同源 POST）必须是同源 Host
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'host not allowed' }));
    return false;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return false;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/api/local-pdf')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'POST /api/local-pdf only' }));
    return false;
  }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
    res.writeHead(415, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Content-Type must be application/json' }));
    return false;
  }
  return true;
}

const server = createServer(async (req, res) => {
  if (!cors(req, res)) return;

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: { html?: string; filename?: string };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad json' }));
    return;
  }
  const html = body.html ?? '';
  if (html.length < 20 || html.length > 60_000_000) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'html size out of range' }));
    return;
  }
  const filename = (body.filename ?? 'article').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || 'article';

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });
      // 显式等待网络空闲（CSDN 外链图慢，这里必须等）
      await page.waitForNetworkIdle({ idleTime: 700, timeout: 60_000 }).catch(() => { /* 超时继续：长文档总有慢图 */ });
      // 等待所有图片完成（二次确认，图床慢图兜底）
      await page.evaluate(() => Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete)
          .map((img) => new Promise<void>((r) => { img.onload = () => r(); img.onerror = () => r(); })),
      ));
      const pdf = Buffer.from(await page.pdf({ ...PDF_OPTS }));

      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition(filename),
        'X-Outline': 'true',
      });
      res.end(pdf);
    } finally {
      await page.close().catch(() => { /* 页面已崩溃时关闭失败也要兜住，避免掩盖主异常 */ });
    }
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
});

// 只绑回环地址：本机自用，不对局域网开放
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[pdf-server] 端口 ${PORT} 已被占用。`);
    console.error('  通常是上一次的服务还在跑。解决：');
    console.error(`  PowerShell:  Get-NetTCPConnection -LocalPort ${PORT} | Select -Expand OwningProcess | % { Stop-Process -Id $_ -Force }`);
    console.error(`  或换端口：   $env:PDF_SERVER_PORT=8789 后重新 npm run pdf-server`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[pdf-server] http://127.0.0.1:${PORT} (仅本机可用)`);
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
