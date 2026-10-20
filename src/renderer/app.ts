/** 渲染进程逻辑：界面状态与主进程通信。 */
import type {
  AppConfig,
  JobProgress,
  JobResult,
  LlmProviderKind,
  VideoInfo,
  VideoSummary,
} from '../core/types.js';
import type { BiliSummaryApi } from '../preload/preload.js';

declare global {
  interface Window {
    api: BiliSummaryApi;
  }
}

const api = window.api;

/* ------------------------------------------------------------------ */
/* 元素引用                                                            */
/* ------------------------------------------------------------------ */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const el = {
  urlInput: $<HTMLInputElement>('url-input'),
  fetchInfo: $<HTMLButtonElement>('fetch-info'),
  videoCard: $('video-card'),
  videoCover: $<HTMLImageElement>('video-cover'),
  videoTitle: $<HTMLAnchorElement>('video-title'),
  videoStats: $('video-stats'),
  partSelect: $<HTMLSelectElement>('part-select'),
  sourceSelect: $<HTMLSelectElement>('source-select'),
  providerSelect: $<HTMLSelectElement>('provider-select'),

  progressCard: $('progress-card'),
  progressFill: $('progress-fill'),
  progressPercent: $('progress-percent'),
  progressMessage: $('progress-message'),
  progressDetail: $('progress-detail'),
  cancelJob: $<HTMLButtonElement>('cancel-job'),

  errorCard: $('error-card'),
  errorMessage: $('error-message'),
  errorHint: $('error-hint'),

  resultCard: $('result-card'),
  summaryTldr: $('summary-tldr'),
  summaryPoints: $('summary-points'),
  summaryOutline: $('summary-outline'),
  summarySegments: $('summary-segments'),
  insightsBlock: $('insights-block'),
  summaryInsights: $('summary-insights'),
  warningsBlock: $('warnings-block'),
  summaryWarnings: $('summary-warnings'),
  summaryMeta: $('summary-meta'),
  markdownView: $('markdown-view'),
  transcriptView: $('transcript-view'),
  copyMd: $<HTMLButtonElement>('copy-md'),
  saveMd: $<HTMLButtonElement>('save-md'),
  exportTranscript: $<HTMLButtonElement>('export-transcript'),

  emptyCard: $('empty-card'),
  startJob: $<HTMLButtonElement>('start-job'),
  actionHint: $('action-hint'),

  loginStatus: $<HTMLButtonElement>('login-status'),
  loginText: $('login-text'),
  openSettings: $<HTMLButtonElement>('open-settings'),
  createShortcut: $<HTMLButtonElement>('create-shortcut'),
  removeShortcut: $<HTMLButtonElement>('remove-shortcut'),
  shortcutStatus: $('shortcut-status'),

  settingsModal: $('settings-modal'),
  closeSettings: $<HTMLButtonElement>('close-settings'),
  saveSettings: $<HTMLButtonElement>('save-settings'),
  settingsStatus: $('settings-status'),
  toast: $('toast'),
};

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

let config: AppConfig | null = null;
let currentVideo: VideoInfo | null = null;
let currentResult: JobResult | null = null;
let currentJobId: string | null = null;
let toastTimer: number | undefined;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function showToast(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  el.toast.textContent = message;
  el.toast.className = `toast ${kind === 'info' ? '' : kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.classList.add('hidden');
  }, 3200);
}

function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function formatCount(n: number): string {
  if (!n) return '0';
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

function setBusy(busy: boolean): void {
  el.startJob.disabled = busy || !currentVideo;
  el.fetchInfo.disabled = busy;
  el.urlInput.disabled = busy;
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function init(): Promise<void> {
  config = await api.getConfig();
  populateProviderSelect(config);
  await refreshLoginStatus();
  setupSettingsForm(config);
  bindEvents();
}

function populateProviderSelect(cfg: AppConfig): void {
  el.providerSelect.innerHTML = '';
  const options: { value: LlmProviderKind; label: string }[] = [
    { value: 'openai', label: 'OpenAI 兼容接口' },
    { value: 'ollama', label: 'Ollama 本地模型' },
    { value: 'bilibili', label: 'B站官方 AI 总结' },
  ];
  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    el.providerSelect.appendChild(option);
  }
  el.providerSelect.value = cfg.llmProvider;
}

async function refreshLoginStatus(): Promise<void> {
  try {
    const status = await api.getLoginStatus();
    el.loginText.textContent = status.ok ? status.user : '未登录';
    el.loginStatus.classList.toggle('logged-in', status.ok);
  } catch {
    el.loginText.textContent = '未登录';
  }
}

function bindEvents(): void {
  el.fetchInfo.addEventListener('click', () => void handleFetchInfo());
  el.startJob.addEventListener('click', () => void handleStartJob());
  el.cancelJob.addEventListener('click', () => void handleCancelJob());
  el.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void handleFetchInfo();
  });

  el.openSettings.addEventListener('click', () => openSettings());
  el.closeSettings.addEventListener('click', () => closeSettings());
  el.settingsModal.querySelector('[data-close]')?.addEventListener('click', () => closeSettings());
  el.saveSettings.addEventListener('click', () => void handleSaveSettings());

  el.loginStatus.addEventListener('click', () => void handleLogin());
  el.providerSelect.addEventListener('change', () => {
    if (config) config.llmProvider = el.providerSelect.value as LlmProviderKind;
  });

  // 标签页
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById(`tab-${tab.dataset.tab}`);
      panel?.classList.add('active');
    });
  });

  el.copyMd.addEventListener('click', () => void handleCopy());
  el.saveMd.addEventListener('click', () => void handleSave());
  el.exportTranscript.addEventListener('click', () => void handleExportTranscript());

  // 主进程事件
  api.onJobProgress(handleProgress);
  api.onJobDone(handleDone);
  api.onJobFailed(handleFailed);
  api.onJobCancelled(handleCancelled);
  api.onLoginChanged(() => void refreshLoginStatus());
}

/* ------------------------------------------------------------------ */
/* 获取视频信息                                                        */
/* ------------------------------------------------------------------ */

async function handleFetchInfo(): Promise<void> {
  const url = el.urlInput.value.trim();
  if (!url) {
    showToast('请输入视频链接', 'error');
    return;
  }

  el.fetchInfo.disabled = true;
  el.fetchInfo.textContent = '获取中…';
  try {
    const video = await api.fetchVideoInfo(url);
    currentVideo = video;
    renderVideoInfo(video);
    el.startJob.disabled = false;
    el.actionHint.textContent = '准备就绪';
    el.errorCard.classList.add('hidden');
    showToast('获取成功', 'ok');
  } catch (err) {
    showToast((err as Error).message || '获取失败', 'error');
    el.errorCard.classList.remove('hidden');
    el.errorMessage.textContent = (err as Error).message || '获取失败';
    el.errorHint.textContent = '';
  } finally {
    el.fetchInfo.disabled = false;
    el.fetchInfo.textContent = '获取信息';
  }
}

function renderVideoInfo(video: VideoInfo): void {
  el.videoCard.classList.remove('hidden');
  el.emptyCard.classList.add('hidden');
  el.videoCover.src = video.cover;
  el.videoTitle.textContent = video.title;
  el.videoTitle.href = video.url;

  el.videoStats.innerHTML = '';
  const stats: [string, number][] = [
    ['播放', video.stat.view],
    ['点赞', video.stat.like],
    ['投币', video.stat.coin],
    ['收藏', video.stat.favorite],
    ['弹幕', video.stat.danmaku],
  ];
  for (const [label, value] of stats) {
    const span = document.createElement('span');
    span.textContent = `${label} ${formatCount(value)}`;
    el.videoStats.appendChild(span);
  }

  el.partSelect.innerHTML = '';
  video.parts.forEach((part) => {
    const option = document.createElement('option');
    option.value = String(part.page);
    option.textContent = `P${part.page} ${part.title} (${formatTimestamp(part.duration)})`;
    el.partSelect.appendChild(option);
  });
  el.partSelect.disabled = video.parts.length <= 1;

  // 链接里带 ?p= 时预选对应的分P
  const urlPart = Number(el.urlInput.value.match(/[?&]p=(\d+)/)?.[1] ?? '1');
  if (urlPart > 1 && video.parts.some((p) => p.page === urlPart)) {
    el.partSelect.value = String(urlPart);
  }
}

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

async function handleStartJob(): Promise<void> {
  if (!currentVideo) return;

  el.errorCard.classList.add('hidden');
  el.resultCard.classList.add('hidden');
  el.progressCard.classList.remove('hidden');
  el.progressFill.style.width = '0%';
  el.progressPercent.textContent = '0%';
  el.progressMessage.textContent = '正在启动…';
  el.progressDetail.textContent = '';
  setBusy(true);

  try {
    const part = Number(el.partSelect.value || '1');
    const source = el.sourceSelect.value as 'auto' | 'subtitle' | 'asr' | 'bilibili-ai';
    const provider = el.providerSelect.value as LlmProviderKind;

    const { jobId } = await api.startJob({
      url: el.urlInput.value.trim(),
      part,
      source: source === 'auto' ? undefined : source,
      provider,
    });
    currentJobId = jobId;
  } catch (err) {
    setBusy(false);
    el.progressCard.classList.add('hidden');
    showError((err as Error).message);
  }
}

async function handleCancelJob(): Promise<void> {
  if (!currentJobId) return;
  await api.cancelJob(currentJobId);
  currentJobId = null;
  el.progressMessage.textContent = '正在取消…';
}

function handleProgress(progress: JobProgress): void {
  el.progressFill.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`;
  el.progressPercent.textContent = `${Math.round(progress.percent)}%`;
  el.progressMessage.textContent = progress.message;
  el.progressDetail.textContent = progress.detail || '';
}

function handleDone(result: JobResult): void {
  currentJobId = null;
  currentResult = result;
  setBusy(false);
  el.progressFill.style.width = '100%';
  el.progressPercent.textContent = '100%';
  el.progressMessage.textContent = '完成';
  renderResult(result);
  showToast('摘要生成完成', 'ok');
}

function handleFailed(info: { jobId: string; message: string; hint?: string }): void {
  currentJobId = null;
  setBusy(false);
  el.progressCard.classList.add('hidden');
  showError(info.message, info.hint);
  showToast('生成失败', 'error');
}

function handleCancelled(): void {
  currentJobId = null;
  setBusy(false);
  el.progressCard.classList.add('hidden');
  showToast('已取消', 'info');
}

function showError(message: string, hint?: string): void {
  el.errorCard.classList.remove('hidden');
  el.errorMessage.textContent = message;
  el.errorHint.textContent = hint || '';
}

/* ------------------------------------------------------------------ */
/* 结果渲染                                                            */
/* ------------------------------------------------------------------ */

function renderResult(result: JobResult): void {
  const summary = result.summary;
  el.resultCard.classList.remove('hidden');

  el.summaryTldr.textContent = summary.tldr || '（无）';

  renderList(el.summaryPoints, summary.keyPoints);
  renderList(el.summaryOutline, summary.outline.map((o) => `[${formatTimestamp(o.start)}] ${o.title}`), true);
  renderSegments(summary.segments);

  if (summary.insights.length) {
    el.insightsBlock.classList.remove('hidden');
    renderList(el.summaryInsights, summary.insights);
  } else {
    el.insightsBlock.classList.add('hidden');
  }

  if (summary.warnings?.length) {
    el.warningsBlock.classList.remove('hidden');
    renderList(el.summaryWarnings, summary.warnings);
    showToast('摘要可能不完整，请查看「注意」', 'error');
  } else {
    el.warningsBlock.classList.add('hidden');
  }

  const sourceLabel: Record<string, string> = {
    subtitle: 'B站官方字幕',
    asr: '语音识别',
    'bilibili-ai': 'B站官方AI总结',
  };
  el.summaryMeta.textContent = `模型：${summary.model} · 字幕来源：${sourceLabel[summary.transcriptSource] || summary.transcriptSource} · 生成于 ${new Date(result.summary.createdAt).toLocaleString('zh-CN')}`;

  el.markdownView.textContent = result.markdown;

  el.transcriptView.innerHTML = '';
  for (const seg of result.transcript.segments) {
    const line = document.createElement('div');
    line.className = 'transcript-line';
    const time = document.createElement('span');
    time.className = 'transcript-time';
    time.textContent = formatTimestamp(seg.start);
    const text = document.createElement('span');
    text.textContent = seg.text;
    line.append(time, text);
    el.transcriptView.appendChild(line);
  }
}

function renderList(container: HTMLElement, items: string[], raw = false): void {
  container.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    if (raw) {
      const code = document.createElement('code');
      code.textContent = item;
      li.appendChild(code);
    } else {
      li.textContent = item;
    }
    container.appendChild(li);
  }
}

function renderSegments(segments: VideoSummary['segments']): void {
  el.summarySegments.innerHTML = '';
  for (const seg of segments) {
    const wrap = document.createElement('div');
    wrap.className = 'segment';

    const head = document.createElement('div');
    head.className = 'segment-head';
    const time = document.createElement('span');
    time.className = 'segment-time';
    time.textContent = `${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}`;
    const title = document.createElement('span');
    title.className = 'segment-title';
    title.textContent = seg.title;
    head.append(time, title);
    wrap.appendChild(head);

    if (seg.points.length) {
      const ul = document.createElement('ul');
      ul.className = 'segment-points';
      for (const point of seg.points) {
        const li = document.createElement('li');
        li.textContent = point;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    if (seg.summary) {
      const p = document.createElement('p');
      p.className = 'segment-summary';
      p.textContent = seg.summary;
      wrap.appendChild(p);
    }

    el.summarySegments.appendChild(wrap);
  }
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

async function handleCopy(): Promise<void> {
  if (!currentResult) return;
  try {
    await navigator.clipboard.writeText(currentResult.markdown);
    showToast('已复制到剪贴板', 'ok');
  } catch {
    showToast('复制失败', 'error');
  }
}

async function handleSave(): Promise<void> {
  if (!currentResult) return;
  const name = `${currentResult.video.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 50)}-${currentResult.video.bvid}.md`;
  const res = await api.saveMarkdown(name, currentResult.markdown);
  if (res.ok && res.path) showToast(`已保存到 ${res.path}`, 'ok');
}

async function handleExportTranscript(): Promise<void> {
  if (!currentResult) return;
  const segs = currentResult.transcript.segments;
  const content = segs
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`)
    .join('\n');
  const name = `${currentResult.video.bvid}.srt`;
  const res = await api.exportTranscript(name, content);
  if (res.ok && res.path) showToast(`已导出到 ${res.path}`, 'ok');
}

function srtTime(seconds: number): string {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

async function handleLogin(): Promise<void> {
  showToast('正在打开登录窗口…', 'info');
  try {
    const res = await api.startLogin();
    if (res.ok) {
      showToast(res.message, 'ok');
      await refreshLoginStatus();
    } else {
      showToast(res.message, 'error');
    }
  } catch (err) {
    showToast((err as Error).message, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function setupSettingsForm(cfg: AppConfig): void {
  ($<HTMLSelectElement>('cfg-llm-provider')).value = cfg.llmProvider;
  ($<HTMLInputElement>('cfg-openai-base')).value = cfg.openai.baseUrl;
  ($<HTMLInputElement>('cfg-openai-key')).value = cfg.openai.apiKey;
  ($<HTMLInputElement>('cfg-openai-model')).value = cfg.openai.model;
  ($<HTMLInputElement>('cfg-openai-temp')).value = String(cfg.openai.temperature);
  ($<HTMLInputElement>('cfg-openai-budget')).value = String(cfg.openai.contextChars);

  ($<HTMLInputElement>('cfg-ollama-base')).value = cfg.ollama.baseUrl;
  setOllamaModelOptions(cfg.ollama.model);
  ($<HTMLInputElement>('cfg-ollama-temp')).value = String(cfg.ollama.temperature);
  ($<HTMLInputElement>('cfg-ollama-budget')).value = String(cfg.ollama.contextChars);
  ($<HTMLInputElement>('cfg-ollama-nothink')).checked = cfg.ollama.disableThinking !== false;

  ($<HTMLSelectElement>('cfg-asr-provider')).value = cfg.asrProvider;
  ($<HTMLInputElement>('cfg-asr-base')).value = cfg.openaiAsr.baseUrl;
  ($<HTMLInputElement>('cfg-asr-key')).value = cfg.openaiAsr.apiKey;
  ($<HTMLInputElement>('cfg-asr-model')).value = cfg.openaiAsr.model;
  ($<HTMLInputElement>('cfg-whisper-bin')).value = cfg.whisperCpp.binaryPath;
  ($<HTMLInputElement>('cfg-whisper-model')).value = cfg.whisperCpp.modelPath;
  ($<HTMLInputElement>('cfg-ffmpeg')).value = cfg.whisperCpp.ffmpegPath;

  ($<HTMLTextAreaElement>('cfg-cookie')).value = cfg.cookie;
  ($<HTMLInputElement>('cfg-language')).value = cfg.summaryLanguage;
  ($<HTMLInputElement>('cfg-concurrency')).value = String(cfg.concurrency);
  ($<HTMLInputElement>('cfg-use-danmaku')).checked = cfg.useDanmaku;
  ($<HTMLInputElement>('cfg-export-transcript')).checked = cfg.exportTranscript;

  updateProviderFields();
  updateAsrFields();
}

function updateProviderFields(): void {
  const kind = ($<HTMLSelectElement>('cfg-llm-provider')).value;
  $('cfg-openai').classList.toggle('hidden', kind !== 'openai');
  $('cfg-ollama').classList.toggle('hidden', kind !== 'ollama');
  $('cfg-bilibili').classList.toggle('hidden', kind !== 'bilibili');
}

function updateAsrFields(): void {
  const kind = ($<HTMLSelectElement>('cfg-asr-provider')).value;
  $('cfg-asr-openai').classList.toggle('hidden', kind !== 'openai');
  $('cfg-asr-whisper').classList.toggle('hidden', kind !== 'whisper-cpp');
}

function openSettings(): void {
  el.settingsModal.classList.remove('hidden');
  el.settingsStatus.textContent = '';
  void refreshShortcutState();
}

function closeSettings(): void {
  el.settingsModal.classList.add('hidden');
}

async function handleSaveSettings(): Promise<void> {
  const partial: Partial<AppConfig> = {
    llmProvider: $<HTMLSelectElement>('cfg-llm-provider').value as LlmProviderKind,
    openai: {
      baseUrl: $<HTMLInputElement>('cfg-openai-base').value.trim(),
      apiKey: $<HTMLInputElement>('cfg-openai-key').value.trim(),
      model: $<HTMLInputElement>('cfg-openai-model').value.trim(),
      temperature: Number($<HTMLInputElement>('cfg-openai-temp').value) || 0.3,
      maxTokens: config?.openai.maxTokens ?? 4096,
      contextChars: Number($<HTMLInputElement>('cfg-openai-budget').value) || 12000,
    },
    ollama: {
      baseUrl: $<HTMLInputElement>('cfg-ollama-base').value.trim(),
      model: $<HTMLSelectElement>('cfg-ollama-model').value,
      temperature: Number($<HTMLInputElement>('cfg-ollama-temp').value) || 0.3,
      maxTokens: config?.ollama.maxTokens ?? 4096,
      contextChars: Number($<HTMLInputElement>('cfg-ollama-budget').value) || 8000,
      disableThinking: $<HTMLInputElement>('cfg-ollama-nothink').checked,
    },
    asrProvider: $<HTMLSelectElement>('cfg-asr-provider').value as AppConfig['asrProvider'],
    openaiAsr: {
      baseUrl: $<HTMLInputElement>('cfg-asr-base').value.trim(),
      apiKey: $<HTMLInputElement>('cfg-asr-key').value.trim(),
      model: $<HTMLInputElement>('cfg-asr-model').value.trim(),
      language: config?.openaiAsr.language ?? 'zh',
    },
    whisperCpp: {
      binaryPath: $<HTMLInputElement>('cfg-whisper-bin').value.trim(),
      modelPath: $<HTMLInputElement>('cfg-whisper-model').value.trim(),
      language: config?.whisperCpp.language ?? 'zh',
      ffmpegPath: $<HTMLInputElement>('cfg-ffmpeg').value.trim(),
    },
    cookie: $<HTMLTextAreaElement>('cfg-cookie').value.trim(),
    summaryLanguage: $<HTMLInputElement>('cfg-language').value.trim() || 'zh',
    concurrency: Number($<HTMLInputElement>('cfg-concurrency').value) || 3,
    useDanmaku: $<HTMLInputElement>('cfg-use-danmaku').checked,
    exportTranscript: $<HTMLInputElement>('cfg-export-transcript').checked,
  };

  try {
    config = await api.setConfig(partial);
    populateProviderSelect(config);
    await refreshLoginStatus();
    showToast('设置已保存', 'ok');

    // 把配置校验结果显示出来，避免用户以为配好了却用不了
    const issues = await api.validateConfig();
    if (issues.length) {
      el.settingsStatus.textContent = `已保存，但有 ${issues.length} 项需要确认：${issues.join('；')}`;
      el.settingsStatus.classList.add('settings-status-warn');
    } else {
      el.settingsStatus.textContent = '设置已保存，配置检查通过';
      el.settingsStatus.classList.remove('settings-status-warn');
    }
    window.setTimeout(() => {
      el.settingsStatus.textContent = '';
      el.settingsStatus.classList.remove('settings-status-warn');
    }, 6000);
  } catch (err) {
    el.settingsStatus.textContent = `保存失败：${(err as Error).message}`;
  }
}

/* ------------------------------------------------------------------ */
/* 设置里的测试按钮                                                    */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  $<HTMLSelectElement>('cfg-llm-provider').addEventListener('change', updateProviderFields);
  $<HTMLSelectElement>('cfg-asr-provider').addEventListener('change', updateAsrFields);

  $<HTMLButtonElement>('test-llm').addEventListener('click', () => void testProvider());
  $<HTMLButtonElement>('test-asr').addEventListener('click', () => void testAsr());
  $<HTMLButtonElement>('pick-whisper-bin').addEventListener('click', () => void pickPath('cfg-whisper-bin', 'exe'));
  $<HTMLButtonElement>('pick-whisper-model').addEventListener('click', () => void pickPath('cfg-whisper-model', 'model'));
  $<HTMLButtonElement>('pick-ffmpeg').addEventListener('click', () => void pickPath('cfg-ffmpeg', 'binary'));
  el.createShortcut.addEventListener('click', () => void handleCreateShortcut());
  el.removeShortcut.addEventListener('click', () => void handleRemoveShortcut());
  $<HTMLButtonElement>('scan-ollama').addEventListener('click', () => void scanOllamaModels());
  $<HTMLButtonElement>('install-whisper').addEventListener('click', () => void installWhisper());

  // whisper 安装进度
  api.onAsrInstallProgress((p) => {
    const fill = document.getElementById('whisper-progress-fill');
    const text = document.getElementById('whisper-progress-text');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, p.percent))}%`;
    if (text) text.textContent = p.message;
  });
  $<HTMLButtonElement>('cfg-login-btn').addEventListener('click', () => void handleLogin());
  $<HTMLButtonElement>('cfg-logout-btn').addEventListener('click', async () => {
    await api.logout();
    await refreshLoginStatus();
    showToast('已退出登录', 'ok');
  });
});

async function testProvider(): Promise<void> {
  const result = $('test-llm-result');
  const kind = $<HTMLSelectElement>('cfg-llm-provider').value as LlmProviderKind;
  result.className = 'test-result';
  result.textContent = '测试中…';
  try {
    const res = await api.checkProvider(kind);
    result.className = `test-result ${res.ok ? 'ok' : 'fail'}`;
    result.textContent = res.message;
  } catch (err) {
    result.className = 'test-result fail';
    result.textContent = (err as Error).message;
  }
}

async function testAsr(): Promise<void> {
  const result = $('test-asr-result');
  result.className = 'test-result';
  result.textContent = '测试中…';
  try {
    const res = await api.checkAsr();
    result.className = `test-result ${res.ok ? 'ok' : 'fail'}`;
    result.textContent = res.message;
  } catch (err) {
    result.className = 'test-result fail';
    result.textContent = (err as Error).message;
  }
}

/** 弹出文件选择框并把路径写回输入框。 */
async function pickPath(
  inputId: string,
  kind: 'exe' | 'model' | 'binary',
): Promise<void> {
  try {
    const res = await api.pickFile(kind);
    if (res.ok && res.path) {
      $<HTMLInputElement>(inputId).value = res.path;
    }
  } catch (err) {
    showToast(`选择文件失败：${(err as Error).message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Ollama 模型检测                                                      */
/* ------------------------------------------------------------------ */

/** 填充 Ollama 模型下拉框。 */
function setOllamaModelOptions(current: string, models: string[] = []): void {
  const select = $<HTMLSelectElement>('cfg-ollama-model');
  select.innerHTML = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '自动选择（推荐）';
  select.appendChild(auto);

  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }

  // 配置里的模型即使没扫到也要能选回来
  if (current && !models.includes(current)) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = `${current}（未在本机检测到）`;
    select.appendChild(option);
  }

  select.value = current;
}

/** 检测本机 Ollama 已安装的模型。 */
async function scanOllamaModels(): Promise<void> {
  const hint = $('scan-ollama-hint');
  const btn = $<HTMLButtonElement>('scan-ollama');
  const baseUrl = $<HTMLInputElement>('cfg-ollama-base').value.trim();
  const current = $<HTMLSelectElement>('cfg-ollama-model').value;

  btn.disabled = true;
  hint.textContent = '正在连接 Ollama…';
  try {
    const res = await api.listOllamaModels(baseUrl);
    if (!res.ok) {
      hint.textContent = res.message || '连接失败';
      showToast(res.message || '连接 Ollama 失败', 'error');
      return;
    }
    setOllamaModelOptions(current, res.models);
    const chatModels = res.models.filter((m) => !/embed|minilm|bge-/i.test(m));
    hint.textContent = res.models.length
      ? `检测到 ${res.models.length} 个模型（可用于摘要：${chatModels.length} 个）。留空则自动挑选。`
      : 'Ollama 已连接但没有已下载的模型，请先执行 ollama pull qwen3:8b';
    if (chatModels.length) {
      showToast(`检测到 ${chatModels.length} 个可用模型`, 'ok');
    }
  } catch (err) {
    hint.textContent = `检测失败：${(err as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* whisper.cpp 一键安装                                                 */
/* ------------------------------------------------------------------ */

async function installWhisper(): Promise<void> {
  const btn = $<HTMLButtonElement>('install-whisper');
  const size = $<HTMLSelectElement>('cfg-whisper-model-size').value;
  const box = $('whisper-progress');
  const fill = $('whisper-progress-fill');
  const text = $('whisper-progress-text');

  btn.disabled = true;
  box.classList.remove('hidden');
  fill.style.width = '0%';
  text.textContent = '准备下载…';

  try {
    const res = await api.installAsr(size);
    if (res.ok) {
      text.textContent = res.message;
      fill.style.width = '100%';
      showToast('安装完成', 'ok');
      // 刷新配置里的路径显示
      const cfg = await api.getConfig();
      $<HTMLInputElement>('cfg-whisper-bin').value = cfg.whisperCpp.binaryPath;
      $<HTMLInputElement>('cfg-whisper-model').value = cfg.whisperCpp.modelPath;
      $<HTMLSelectElement>('cfg-asr-provider').value = cfg.asrProvider;
      updateAsrFields();
    } else {
      text.textContent = res.message;
      showToast(res.message, 'error');
    }
  } catch (err) {
    text.textContent = `安装失败：${(err as Error).message}`;
    showToast('安装失败', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 桌面快捷方式                                                        */
/* ------------------------------------------------------------------ */
/** 只更新按钮的可用状态，不动状态文案。 */
async function updateShortcutButtons(): Promise<void> {
  try {
    const state = await api.getShortcutState();
    el.createShortcut.disabled = !state.supported || !state.writable;
    el.removeShortcut.disabled = !state.exists;
  } catch {
    /* 忽略 */
  }
}

/** 刷新桌面快捷方式状态并更新界面。 */
async function refreshShortcutState(): Promise<void> {  try {
    const state = await api.getShortcutState();
    if (!state.supported) {
      el.shortcutStatus.textContent = state.message;
      el.createShortcut.disabled = true;
      el.removeShortcut.disabled = true;
      return;
    }

    el.createShortcut.disabled = !state.writable;
    el.removeShortcut.disabled = !state.exists;

    const lines: string[] = [];
    lines.push(state.message);
    if (state.exists && state.target) {
      lines.push(`当前指向：${state.target}`);
    }
    if (!state.writable) {
      lines.push('可尝试以管理员身份运行本应用后重试。');
    }
    el.shortcutStatus.textContent = lines.join('  ');
  } catch (err) {
    el.shortcutStatus.textContent = `读取快捷方式状态失败：${(err as Error).message}`;
  }
}

async function handleCreateShortcut(): Promise<void> {
  el.createShortcut.disabled = true;
  el.shortcutStatus.textContent = '正在创建…';
  try {
    const res = await api.createShortcut();
    // 先刷新按钮状态，再回填操作结果 —— 顺序反了会把结果文案覆盖掉
    await updateShortcutButtons();
    el.shortcutStatus.textContent = res.message;
    showToast(res.ok ? '桌面快捷方式已就绪' : res.message, res.ok ? 'ok' : 'error');
  } catch (err) {
    el.shortcutStatus.textContent = `创建失败：${(err as Error).message}`;
    showToast('创建快捷方式失败', 'error');
  }
}

async function handleRemoveShortcut(): Promise<void> {
  try {
    const res = await api.removeShortcut();
    await updateShortcutButtons();
    el.shortcutStatus.textContent = res.message;
    showToast(res.ok ? '已删除' : res.message, res.ok ? 'ok' : 'error');
  } catch (err) {
    el.shortcutStatus.textContent = `删除失败：${(err as Error).message}`;
    showToast('删除快捷方式失败', 'error');
  }
}

void init();
