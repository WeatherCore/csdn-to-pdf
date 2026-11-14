import './style.css';
import '@phosphor-icons/web/regular';
import { buildPrintDocument, sanitizeFilename } from './print-doc';

/* ============================================================
   CSDN → PDF · 分屏工作台
   首页单栏 → 首次转换展开为双栏：左正文 / 右 PDF 页内预览。
   一步到位：点一次「转换」= 抓正文 + 生成 PDF。重转不清场，
   旧内容原地保留，右侧盖「转换中」进度层，新内容到达才替换。
   ============================================================ */

type Phase = 'home' | 'workbench';
type PdfState = 'empty' | 'skeleton' | 'busy' | 'ready' | 'fallback' | 'error';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  home: $('home'),
  topbarHome: $('topbar-home'),
  topbarReading: $('topbar-reading'),
  formHome: $('url-form-home') as HTMLFormElement,
  inputHome: $('url-input-home') as HTMLInputElement,
  goBtnHome: $('go-btn-home') as HTMLButtonElement,
  statusHome: $('status-home'),

  workbench: $('workbench'),
  form: $('url-form') as HTMLFormElement,
  input: $('url-input') as HTMLInputElement,
  goBtn: $('go-btn') as HTMLButtonElement,

  truncNote: $('truncation-note'),
  title: $('article-title'),
  body: $('article-body'),
  readerSkeleton: $('reader-skeleton'),
  readerEmpty: $('reader-empty'),
  readerError: $('reader-error'),
  readerErrorMsg: $('reader-error-msg'),

  pdfHead: $('pdf-head'),
  pdfName: $('pdf-name'),
  pdfMeta: $('pdf-meta'),
  pdfRegen: $('pdf-regen') as HTMLButtonElement,
  pdfOpen: $('pdf-open') as HTMLButtonElement,
  pdfDownload: $('pdf-download') as HTMLButtonElement,

  pdfEmpty: $('pdf-empty'),
  pdfSkeleton: $('pdf-skeleton'),
  pdfBusy: $('pdf-busy'),
  busyStages: $('busy-stages'),
  pdfFrame: $('pdf-frame') as HTMLIFrameElement,
  pdfFallback: $('pdf-fallback'),
  pdfFallbackDownload: $('pdf-fallback-download') as HTMLButtonElement,
  pdfError: $('pdf-error'),
  pdfErrorMsg: $('pdf-error-msg'),
  pdfRetry: $('pdf-retry') as HTMLButtonElement,
};

/* ---------------- 状态 ---------------- */

let phase: Phase = 'home';
let readerHasContent = false;

let currentTitle = '';
let currentBody = '';

let pdfBlobUrl = '';
let pdfFilename = '';
let converting = false;

let extractAbort: AbortController | null = null;
let pdfAbort: AbortController | null = null;
let runToken = 0; // 递增令牌：过期的异步回调不得写 UI（新转换获胜）

const NARROW_MQ = '(max-width: 1023px)';
const LOCAL_PDF_BASE = 'http://127.0.0.1:8788';
const LOCAL_PROBE_TTL_MS = 60_000;
let localProbe: Promise<boolean> | null = null;
let localProbeAt = 0;

/* ---------------- 阶段与渲染 ---------------- */

function setPhase(p: Phase): void {
  phase = p;
  els.home.hidden = p !== 'home';
  els.workbench.hidden = p !== 'workbench';
  els.topbarHome.hidden = p !== 'home';
  els.topbarReading.hidden = p !== 'workbench';
}

function renderStages(active: number): void {
  const stages = ['获取正文', '发送 HTML', '浏览器渲染', '生成 PDF'];
  els.busyStages.innerHTML = stages
    .map((s, i) => {
      const cls = i < active ? 'done' : i === active ? 'active' : '';
      const icon = i < active ? 'ph-check-circle' : i === active ? 'ph-circle-notch' : 'ph-circle';
      return `<span class="stage ${cls}"><i class="ph ${icon}" aria-hidden="true"></i>${s}</span>`;
    })
    .join('');
}

/** 左侧：骨架（首转无内容时）/ 空态 / 错误条 / 正文，四者互斥显隐 */
function setLeftView(view: 'skeleton' | 'empty' | 'error' | 'content'): void {
  els.readerSkeleton.hidden = view !== 'skeleton';
  els.readerEmpty.hidden = view !== 'empty';
  els.readerError.hidden = view !== 'error';
  const showContent = view === 'content';
  els.title.hidden = !showContent;
  els.body.hidden = !showContent;
}

function applyReader(title: string, bodyHtml: string, truncated: boolean): void {
  currentTitle = title;
  currentBody = bodyHtml;
  els.title.textContent = title;
  els.body.innerHTML = bodyHtml;
  els.truncNote.hidden = !truncated;
  readerHasContent = true;
  setLeftView('content');
  document.title = title ? `${title} · CSDN → PDF` : 'CSDN → PDF';
}

function setLeftError(msg: string): void {
  els.readerErrorMsg.textContent = msg;
  setLeftView('error');
}

/* ---------------- PDF 面板 ---------------- */

function setPdfState(s: PdfState): void {
  els.pdfEmpty.hidden = s !== 'empty';
  els.pdfSkeleton.hidden = s !== 'skeleton';
  els.pdfBusy.hidden = s !== 'busy';
  // busy 盖层要叠在旧 PDF 之上：已有成品时 busy 期间 iframe 保持可见
  els.pdfFrame.hidden = !(s === 'ready' || (s === 'busy' && !!pdfBlobUrl));
  els.pdfFallback.hidden = s !== 'fallback';
  els.pdfError.hidden = s !== 'error';
  els.pdfHead.hidden = s !== 'ready';
}

/** iframe 内联预览可用性：窄屏按共识直接降级为下载卡；移动 UA 同样降级 */
function canInlinePreview(): boolean {
  if (window.matchMedia(NARROW_MQ).matches) return false;
  return !/Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function publishPdf(blob: Blob, engineNote: string): void {
  if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
  pdfBlobUrl = URL.createObjectURL(blob);
  els.pdfName.textContent = pdfFilename;
  els.pdfMeta.textContent = `${formatBytes(blob.size)} · ${engineNote}`;
  if (canInlinePreview()) {
    els.pdfFrame.src = `${pdfBlobUrl}#view=FitH`;
    setPdfState('ready');
  } else {
    setPdfState('fallback');
  }
}

/** 清空工作台内容：下载完成后回主页时调用，给下一篇一个干净起点 */
function resetWorkbench(): void {
  currentTitle = '';
  currentBody = '';
  pdfFilename = '';
  pdfBlobUrl = ''; // 下载后旧 URL 已废弃（回收由 downloadPdf 的定时器负责）；
                   // 不清掉的话，下一篇转换失败会误判“有旧成品可回退”
  readerHasContent = false;
  els.title.textContent = '';
  els.body.innerHTML = '';
  els.truncNote.hidden = true;
  els.pdfFrame.removeAttribute('src');
  document.title = 'CSDN → PDF';
  setLeftView('empty');
  setPdfState('empty');
}

/** 下载 = 本篇流程终点：触发保存后回主页，光标落回输入框方便立即转下一篇。
    blob 延迟 30s 回收（对齐旧版 downloadBlob），确保下载已从 blob URL 启动。 */
function downloadPdf(): void {
  if (!pdfBlobUrl) return;
  const url = pdfBlobUrl;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${pdfFilename}.pdf`;
  a.click();

  resetWorkbench();
  setPhase('home');
  els.inputHome.value = '';
  els.statusHome.textContent = 'PDF 已下载，粘贴下一篇链接继续。';
  els.inputHome.focus();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    if (phase === 'home') els.statusHome.textContent = '';
  }, 30_000);
}

function validateBlob(blob: Blob): void {
  if (blob.type !== 'application/pdf' || blob.size < 100) {
    throw new Error('返回内容不是有效 PDF');
  }
}

/* ---------------- 本地引擎探测（60s TTL，学自 ipynb-to-pdf） ---------------- */

function probeLocal(): Promise<boolean> {
  const now = Date.now();
  if (!localProbe || now - localProbeAt > LOCAL_PROBE_TTL_MS) {
    localProbeAt = now;
    localProbe = (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1200);
        const r = await fetch(`${LOCAL_PDF_BASE}/api/local-pdf`, {
          method: 'OPTIONS',
          signal: ctrl.signal,
        });
        clearTimeout(t);
        return r.ok;
      } catch {
        return false;
      }
    })();
  }
  return localProbe;
}

/* ---------------- PDF 生成：本地引擎 → 云端引擎 ---------------- */

async function generatePdf(token: number): Promise<void> {
  const doc = buildPrintDocument(currentTitle, currentBody);
  pdfFilename = sanitizeFilename(currentTitle);
  pdfAbort = new AbortController();
  const { signal } = pdfAbort;

  // 路径 1：本地引擎（无头 Chromium，书签 + 页码页脚）
  if (await probeLocal()) {
    renderStages(1);
    try {
      const resp = await fetch(`${LOCAL_PDF_BASE}/api/local-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: doc, filename: pdfFilename }),
        signal,
      });
      if (token !== runToken) return;
      if (!resp.ok) throw new Error(`本地服务返回 ${resp.status}`);
      renderStages(2);
      const blob = await resp.blob();
      if (token !== runToken) return;
      validateBlob(blob);
      renderStages(3);
      publishPdf(blob, '本地引擎');
      return;
    } catch (localErr) {
      // 探测通过但转换失败：回退云端而不是直接报死
      if (token !== runToken) return;
      console.warn('[csdn-to-pdf] 本地引擎失败，回退云端：', localErr);
    }
  }

  // 路径 2：云端 Worker（Browser Rendering）
  renderStages(1);
  const resp = await fetch('/api/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: doc, filename: pdfFilename }),
    signal,
  });
  if (token !== runToken) return;
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `服务端返回 ${resp.status}`);
  }
  renderStages(2);
  const blob = await resp.blob();
  if (token !== runToken) return;
  validateBlob(blob);
  renderStages(3);
  publishPdf(blob, '云端引擎');
}

function pdfErrorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 转换 / 重生成期间的按钮闸 */
function setBusyButtons(busy: boolean): void {
  els.goBtn.disabled = busy;
  els.goBtnHome.disabled = busy;
  els.pdfRegen.disabled = busy;
  els.pdfRetry.disabled = busy;
}

/** 失败后右侧回到的状态：有旧成品回 ready，否则回空态 */
function settleRightAfterFailure(): void {
  setPdfState(pdfBlobUrl ? 'ready' : 'empty');
}

/* ---------------- 一步到位转换 ---------------- */

async function runConversion(url: string): Promise<void> {
  if (converting) return;
  converting = true;
  const token = ++runToken;
  extractAbort?.abort();
  pdfAbort?.abort();
  extractAbort = new AbortController();
  pdfAbort = null;

  setBusyButtons(true);
  setPdfState('busy');
  renderStages(0);
  if (!readerHasContent) setLeftView('skeleton');
  window.scrollTo({ top: 0 });

  // 阶段 0：抓取正文（失败报左侧）
  try {
    const resp = await fetch(`/api/extract?url=${encodeURIComponent(url)}`, {
      signal: extractAbort.signal,
    });
    if (token !== runToken) return;
    const data = (await resp.json().catch(() => ({}))) as {
      title?: string;
      html?: string;
      error?: string;
      truncated?: boolean;
    };
    if (token !== runToken) return;
    if (!resp.ok) throw new Error(data.error ?? `未知错误（HTTP ${resp.status}）`);
    applyReader(data.title ?? '', data.html ?? '', !!data.truncated);
  } catch (e) {
    if (token !== runToken) return;
    if (e instanceof DOMException && e.name === 'AbortError') return;
    const isLocalDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const detail = pdfErrorDetail(e);
    setLeftError(
      isLocalDev && detail.includes('Failed to fetch')
        ? '抓取失败：本地调试需要先跑 npm run dev:api。'
        : detail,
    );
    settleRightAfterFailure();
    return;
  } finally {
    if (token === runToken && els.readerError.hidden === false) converting = false;
  }

  // 阶段 1-3：生成 PDF（失败报右侧）
  try {
    await generatePdf(token);
  } catch (e) {
    if (token !== runToken) return;
    if (e instanceof DOMException && e.name === 'AbortError') return;
    const isLocalDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const detail = pdfErrorDetail(e);
    els.pdfErrorMsg.textContent = isLocalDev
      ? '两条引擎都不可用：① 另开终端跑 npm run pdf-server 启动本地引擎后重试；'
        + '② 部署到 Cloudflare 付费版（BROWSER 绑定）。（详情：' + detail + '）'
      : `PDF 生成暂时失败，请稍后重试。（详情：${detail}）`;
    setPdfState('error');
  } finally {
    if (token === runToken) {
      converting = false;
      setBusyButtons(false);
    }
  }
}

/** 仅重新生成 PDF（不动正文）：右侧「重新生成」与失败卡的「重试」共用 */
async function regenerate(): Promise<void> {
  if (converting || !currentBody) return;
  converting = true;
  const token = ++runToken;
  pdfAbort?.abort();

  setBusyButtons(true);
  setPdfState('busy');
  renderStages(1);
  try {
    await generatePdf(token);
  } catch (e) {
    if (token !== runToken) return;
    if (e instanceof DOMException && e.name === 'AbortError') return;
    els.pdfErrorMsg.textContent = `PDF 生成暂时失败，请稍后重试。（详情：${pdfErrorDetail(e)}）`;
    setPdfState('error');
  } finally {
    if (token === runToken) {
      converting = false;
      setBusyButtons(false);
    }
  }
}

/* ---------------- 入口：提交 URL（首页 / 工作台共用） ---------------- */

function submitUrl(raw: string, fromHome: boolean): void {
  const url = raw.trim();
  if (!url) {
    if (fromHome) {
      els.statusHome.textContent = '先粘贴一个 CSDN 文章链接。';
      els.inputHome.focus();
    } else {
      els.input.focus();
    }
    return;
  }
  if (phase === 'home') {
    els.input.value = url;
    setPhase('workbench');
    els.input.focus();
  }
  void runConversion(url);
}

els.formHome.addEventListener('submit', (e) => {
  e.preventDefault();
  submitUrl(els.inputHome.value, true);
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  submitUrl(els.input.value, false);
});

// 示例链接：一键填入并完整走一步到位流程
for (const btn of document.querySelectorAll<HTMLButtonElement>('.example-link')) {
  btn.addEventListener('click', () => {
    els.inputHome.value = btn.dataset.url ?? '';
    submitUrl(els.inputHome.value, true);
  });
}

/* ---------------- 右面板动作 ---------------- */

els.pdfDownload.addEventListener('click', downloadPdf);
els.pdfFallbackDownload.addEventListener('click', downloadPdf);
els.pdfOpen.addEventListener('click', () => {
  if (pdfBlobUrl) window.open(pdfBlobUrl, '_blank');
});
els.pdfRegen.addEventListener('click', () => void regenerate());
els.pdfRetry.addEventListener('click', () => void regenerate());
