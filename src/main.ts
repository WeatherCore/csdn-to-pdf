import './style.css';
import '@phosphor-icons/web/regular';
import { buildPrintDocument, sanitizeFilename } from './print-doc';

type Phase = 'home' | 'loading' | 'reading';

const els = {
  form: document.getElementById('url-form') as HTMLFormElement,
  input: document.getElementById('url-input') as HTMLInputElement,
  goBtn: document.getElementById('go-btn') as HTMLButtonElement,
  status: document.getElementById('status') as HTMLElement,
  home: document.getElementById('home') as HTMLElement,
  skeleton: document.getElementById('skeleton') as HTMLElement,
  reader: document.getElementById('reader') as HTMLElement,
  topbarHome: document.getElementById('topbar-home') as HTMLElement,
  topbarReading: document.getElementById('topbar-reading') as HTMLElement,
  backBtn: document.getElementById('back-btn') as HTMLButtonElement,
  printBtn: document.getElementById('print-btn') as HTMLButtonElement,
  againBtn: document.getElementById('again-btn') as HTMLButtonElement,
  truncNote: document.getElementById('truncation-note') as HTMLElement,
  title: document.getElementById('article-title') as HTMLElement,
  body: document.getElementById('article-body') as HTMLElement,
};

let currentTitle = '';
let printing = false; // 转换防重入（学自参考版）
let statusTimer: number | undefined;

function setPhase(phase: Phase): void {
  els.home.hidden = phase !== 'home';
  els.skeleton.hidden = phase !== 'loading';
  els.reader.hidden = phase !== 'reading';
  els.topbarHome.hidden = phase === 'reading';
  els.topbarReading.hidden = phase !== 'reading';
}

function setStatus(msg: string, isError = false): void {
  clearTimeout(statusTimer);
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
  if (msg && !isError) {
    statusTimer = window.setTimeout(() => {
      els.status.textContent = '';
    }, 6000);
  }
}

async function extract(url: string): Promise<void> {
  setPhase('loading');
  els.goBtn.disabled = true;

  try {
    const resp = await fetch(`/api/extract?url=${encodeURIComponent(url)}`);
    const data = (await resp.json()) as { title?: string; html?: string; error?: string; truncated?: boolean };
    if (!resp.ok) {
      setPhase('home');
      setStatus(data.error ?? `未知错误（HTTP ${resp.status}）`, true);
      return;
    }
    currentTitle = data.title ?? '';
    els.title.textContent = currentTitle;
    els.body.innerHTML = data.html ?? '';
    els.truncNote.hidden = !data.truncated;
    setPhase('reading');
    window.scrollTo({ top: 0 });
  } catch {
    setPhase('home');
    setStatus('请求失败：本地调试需要先跑 npm run dev:api。', true);
  } finally {
    els.goBtn.disabled = false;
  }
}

function goHome(): void {
  setPhase('home');
  els.input.focus();
}

/* ---------------- PDF 转换：本地引擎 → 云端引擎，无打印对话框（学自 ipynb-to-pdf） ---------------- */

/** 本地导出服务是否可达（1.2s 超时探测，结果缓存） */
let localProbe: Promise<boolean> | null = null;
const LOCAL_PDF_BASE = 'http://127.0.0.1:8788';
function probeLocal(): Promise<boolean> {
  if (!localProbe) {
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
      } catch { return false; }
    })();
  }
  return localProbe;
}

/** 云端转换阶段提示 */
function renderStages(active: number): string {
  const stages = ['发送 HTML', '浏览器渲染', '生成 PDF'];
  return `<div class="stages">` + stages.map((s, i) => {
    const cls = i < active ? 'done' : i === active ? 'active' : '';
    const icon = i < active ? 'ph-check-circle' : i === active ? 'ph-circle-notch' : 'ph-circle';
    return `<span class="stage ${cls}"><i class="ph ${icon}" aria-hidden="true"></i>${s}</span>`;
  }).join('') + `</div>`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename + '.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function convertToPdf(): Promise<void> {
  if (printing || !currentTitle) return;
  printing = true;
  els.printBtn.disabled = true;
  const filename = sanitizeFilename(currentTitle);
  const doc = buildPrintDocument(currentTitle, els.body.innerHTML);
  try {
    // ---- 路径 1：本地导出服务（无头 Chromium，书签 + 页码页脚） ----
    if (await probeLocal()) {
      setStatus('正在生成本地 PDF…');
      const resp = await fetch(`${LOCAL_PDF_BASE}/api/local-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: doc, filename }),
      });
      if (!resp.ok) throw new Error(`本地服务返回 ${resp.status}`);
      const blob = await resp.blob();
      if (blob.type !== 'application/pdf' || blob.size < 100) throw new Error('返回内容不是有效 PDF');
      downloadBlob(blob, filename);
      setStatus('PDF 已生成（本地引擎，含侧边栏书签），开始下载。');
      return;
    }

    // ---- 路径 2：云端 Worker（Browser Rendering，书签 + 页码页脚） ----
    setStatus(`正在生成 PDF…${renderStages(1)}`);
    const resp = await fetch('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: doc, filename }),
    });
    if (!resp.ok) {
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `服务端返回 ${resp.status}`);
    }
    setStatus(`正在生成 PDF…${renderStages(2)}`);
    const blob = await resp.blob();
    if (blob.type !== 'application/pdf' || blob.size < 100) throw new Error('返回内容不是有效 PDF');
    downloadBlob(blob, filename);
    setStatus('PDF 已生成（云端，含侧边栏书签），开始下载。');
  } catch (e) {
    setStatus(
      'PDF 引擎不可用。解决方法（二选一）：' +
      '① 另开一个终端跑 npm run pdf-server 启动本地引擎后重试；' +
      '② 部署到 Cloudflare 付费版（BROWSER 绑定）。' +
      `（详情：${e instanceof Error ? e.message : String(e)}）`,
      true,
    );
  } finally {
    printing = false;
    els.printBtn.disabled = false;
  }
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = els.input.value.trim();
  if (!url) {
    setStatus('先粘贴一个 CSDN 文章链接。', true);
    els.input.focus();
    return;
  }
  extract(url);
});

els.backBtn.addEventListener('click', goHome);
els.againBtn.addEventListener('click', goHome);
els.printBtn.addEventListener('click', () => void convertToPdf());

// 示例链接一键填入并转换
for (const btn of document.querySelectorAll<HTMLButtonElement>('.example-link')) {
  btn.addEventListener('click', () => {
    els.input.value = btn.dataset.url ?? '';
    extract(els.input.value);
  });
}
