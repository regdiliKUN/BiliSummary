/** 渲染进程逻辑：批量队列、历史记录、界面状态与主进程通信。 */
import type {
  AppConfig,
  CollectionEpisode,
  CollectionJobRequest,
  HistoryEntry,
  HistoryRecord,
  JobProgress,
  JobResult,
  LlmProviderKind,
  TranscriptSource,
  VideoCollection,
  VideoInfo,
} from '../core/types.js';
import { formatCollectionTimestamp } from '../core/utils/collection.js';
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
  // 视图
  viewWorkspace: $('view-workspace'),
  viewHistory: $('view-history'),
  navButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-btn')),

  // 导入
  urlInput: $<HTMLTextAreaElement>('url-input'),
  importBtn: $<HTMLButtonElement>('import-btn'),
  pasteBtn: $<HTMLButtonElement>('paste-btn'),
  importHint: $('import-hint'),
  skipHistory: $<HTMLInputElement>('skip-history'),

  // 队列
  queueList: $('queue-list'),
  queueEmpty: $('queue-empty'),
  queueSummary: $('queue-summary'),
  sourceSelect: $<HTMLSelectElement>('source-select'),
  providerSelect: $<HTMLSelectElement>('provider-select'),
  videoConcurrency: $<HTMLInputElement>('video-concurrency'),
  cancelAll: $<HTMLButtonElement>('cancel-all'),
  clearDone: $<HTMLButtonElement>('clear-done'),
  exportAll: $<HTMLButtonElement>('export-all'),
  startAll: $<HTMLButtonElement>('start-all'),
  overallFill: $('overall-fill'),
  overallText: $('overall-text'),
  resultHost: $('result-host'),
  actionBar: document.querySelector<HTMLElement>('.action-bar')!,

  // 历史
  historyCount: $('history-count'),
  historySummary: $('history-summary'),
  historySearch: $<HTMLInputElement>('history-search'),
  historyFilter: $<HTMLSelectElement>('history-filter'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  historyDetailHost: $('history-detail-host'),
  historyExportMerged: $<HTMLButtonElement>('history-export-merged'),
  historyExportFolder: $<HTMLButtonElement>('history-export-folder'),
  historyOpenFolder: $<HTMLButtonElement>('history-open-folder'),
  historyClear: $<HTMLButtonElement>('history-clear'),

  // 通用
  collectionModal: $('collection-modal'),
  collectionTitle: $('collection-title'),
  collectionSub: $('collection-sub'),
  collectionList: $('collection-list'),
  collectionCount: $('collect-count'),
  collectionHint: $('collection-hint'),
  collectionConfirm: $<HTMLButtonElement>('collection-confirm'),
  collectionCancel: $<HTMLButtonElement>('collection-cancel'),
  closeCollection: $<HTMLButtonElement>('close-collection'),
  collectAll: $<HTMLButtonElement>('collect-all'),
  collectNone: $<HTMLButtonElement>('collect-none'),
  collectInvert: $<HTMLButtonElement>('collect-invert'),

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

type TaskStatus =
  | 'parsing'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

interface Task {
  id: string;
  url: string;
  part?: number;
  video?: VideoInfo;
  status: TaskStatus;
  percent: number;
  message: string;
  detail?: string;
  error?: string;
  hint?: string;
  result?: JobResult;
  historyId?: string;
  /** single = 单视频任务；collection = 合集合并任务 */
  kind: 'single' | 'collection';
  /** 合集合并任务的请求体与展示信息 */
  collectionRequest?: CollectionJobRequest;
  collectionCover?: string;
  episodeCount?: number;
}

/** 合集选集弹窗的状态。 */
interface CollectionPickState {
  video: VideoInfo;
  collection: VideoCollection;
  selected: Set<string>;
  mode: 'separate' | 'merged';
}

let config: AppConfig | null = null;
let tasks: Task[] = [];
let historyEntries: HistoryEntry[] = [];
let activeView: 'workspace' | 'history' = 'workspace';
let toastTimer: number | undefined;
let importing = false;
let collectionPick: CollectionPickState | null = null;

const rowEls = new Map<string, HTMLElement>();
let shownResultKey: string | null = null;

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

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  const restMinutes = m % 60;
  return restMinutes ? `${h} 小时 ${restMinutes} 分` : `${h} 小时`;
}

function formatCount(n: number): string {
  if (!n) return '0';
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function el2<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 并发受限地遍历（用于批量解析视频信息）。 */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) continue;
        await fn(item, index);
      }
    }),
  );
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  parsing: '解析中',
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已存在',
};

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function init(): Promise<void> {
  config = await api.getConfig();
  populateProviderSelect(config);
  el.sourceSelect.value = 'auto';
  el.videoConcurrency.value = String(config.videoConcurrency ?? 2);
  el.skipHistory.checked = config.saveHistory !== false;

  setupSettingsForm(config);
  bindEvents();

  await Promise.all([refreshLoginStatus(), loadHistory()]);
  renderQueue();
}

function populateProviderSelect(cfg: AppConfig): void {
  el.providerSelect.innerHTML = '';
  const options: { value: LlmProviderKind; label: string }[] = [
    { value: 'openai', label: 'OpenAI 兼容接口' },
    { value: 'deepseek', label: 'DeepSeek 官方 API' },
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
  // 视图切换
  for (const btn of el.navButtons) {
    btn.addEventListener('click', () => switchView(btn.dataset.view === 'history' ? 'history' : 'workspace'));
  }

  // 导入
  el.importBtn.addEventListener('click', () => void handleImport());
  el.pasteBtn.addEventListener('click', () => void handlePaste());
  el.urlInput.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + Enter 快速导入
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleImport();
    }
  });

  // 队列
  el.startAll.addEventListener('click', () => void handleStartAll());
  el.cancelAll.addEventListener('click', () => void handleCancelAll());
  el.clearDone.addEventListener('click', () => handleClearDone());
  el.exportAll.addEventListener('click', () => void handleExportAll());
  el.providerSelect.addEventListener('change', () => {
    if (config) config.llmProvider = el.providerSelect.value as LlmProviderKind;
  });
  el.videoConcurrency.addEventListener('change', () => {
    const value = Number(el.videoConcurrency.value) || 2;
    el.videoConcurrency.value = String(value);
    if (config) config.videoConcurrency = value;
    void api.setConcurrency(value);
  });

  // 历史
  el.historySearch.addEventListener('input', () => renderHistory());
  el.historyFilter.addEventListener('change', () => renderHistory());
  el.historyExportMerged.addEventListener('click', () => void handleHistoryExport('merged'));
  el.historyExportFolder.addEventListener('click', () => void handleHistoryExport('folder'));
  el.historyOpenFolder.addEventListener('click', () => void api.openHistoryFolder());
  el.historyClear.addEventListener('click', () => void handleHistoryClear());

  // 合集选集弹窗
  el.closeCollection.addEventListener('click', closeCollectionModal);
  el.collectionCancel.addEventListener('click', closeCollectionModal);
  el.collectionModal
    .querySelector('[data-close-collection]')
    ?.addEventListener('click', closeCollectionModal);
  el.collectionConfirm.addEventListener('click', () => void handleCollectionConfirm());
  el.collectAll.addEventListener('click', () => toggleAllEpisodes(true));
  el.collectNone.addEventListener('click', () => toggleAllEpisodes(false));
  el.collectInvert.addEventListener('click', invertEpisodes);
  document
    .querySelectorAll<HTMLInputElement>('input[name="collection-mode"]')
    .forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!collectionPick) return;
        collectionPick.mode = radio.value === 'merged' ? 'merged' : 'separate';
        updateCollectionSelection();
      });
    });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && collectionPick) closeCollectionModal();
  });

  // 设置
  el.openSettings.addEventListener('click', () => openSettings());
  el.closeSettings.addEventListener('click', () => closeSettings());
  el.settingsModal.querySelector('[data-close]')?.addEventListener('click', () => closeSettings());
  el.saveSettings.addEventListener('click', () => void handleSaveSettings());
  el.loginStatus.addEventListener('click', () => void handleLogin());

  // 主进程事件
  api.onJobProgress(handleProgress);
  api.onJobDone(handleDone);
  api.onJobFailed(handleFailed);
  api.onJobCancelled(handleCancelled);
  api.onLoginChanged(() => void refreshLoginStatus());
}

function switchView(view: 'workspace' | 'history'): void {
  activeView = view;
  for (const btn of el.navButtons) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  el.viewWorkspace.classList.toggle('hidden', view !== 'workspace');
  el.viewHistory.classList.toggle('hidden', view !== 'history');
  // 底部操作条只服务工作台
  el.actionBar.classList.toggle('hidden', view !== 'workspace');
  if (view === 'history') void loadHistory();
}

/* ------------------------------------------------------------------ */
/* 导入：解析多条链接                                                  */
/* ------------------------------------------------------------------ */

/** 从一段文本里抽出所有视频标识（支持多行、分享文案、短链）。 */
function extractTargets(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const value = raw
      .trim()
      .replace(/[)\]】」』），。、；;,>]+$/g, '')
      .trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const urls = trimmed.match(/https?:\/\/[^\s"'<>]+/g);
    if (urls?.length) {
      urls.forEach(push);
      continue;
    }

    const bvs = trimmed.match(/BV[0-9A-Za-z]{10}/g);
    if (bvs?.length) {
      bvs.forEach(push);
      continue;
    }

    const avs = trimmed.match(/av\d+/gi);
    if (avs?.length) {
      avs.forEach(push);
      continue;
    }

    // 认不出来也先收下，让后端给出明确错误
    push(trimmed);
  }

  return out;
}

function extractPart(url: string): number | undefined {
  const m = url.match(/[?&]p=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function createTask(url: string): Task {
  return {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    url,
    part: extractPart(url),
    status: 'parsing',
    percent: 0,
    message: '正在解析视频信息',
    kind: 'single',
  };
}

/** 新建一个合集合并任务（合集只产出一份摘要）。 */
function createCollectionTask(
  video: VideoInfo,
  collection: VideoCollection,
  episodes: CollectionEpisode[],
): Task {
  const totalDuration = episodes.reduce((sum, ep) => sum + ep.duration, 0);
  return {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    url: `collection://${collection.id}`,
    status: 'queued',
    percent: 0,
    message: `合并 ${episodes.length} 集，等待开始`,
    kind: 'collection',
    episodeCount: episodes.length,
    collectionCover: collection.cover,
    collectionRequest: {
      title: collection.title,
      collectionId: collection.id,
      total: collection.total,
      episodes: episodes.map((ep) => ({
        url: `https://www.bilibili.com/video/${ep.bvid}`,
        title: ep.title,
      })),
    },
    video: {
      ...video,
      title: `合集《${collection.title}》`,
      duration: totalDuration,
      parts: [],
      collection: null,
    },
  };
}

async function handlePaste(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      showToast('剪贴板是空的', 'error');
      return;
    }
    el.urlInput.value = el.urlInput.value.trim()
      ? `${el.urlInput.value.trim()}\n${text.trim()}`
      : text.trim();
    showToast('已粘贴', 'ok');
  } catch (err) {
    showToast(`读取剪贴板失败：${(err as Error).message}`, 'error');
  }
}

async function handleImport(): Promise<void> {
  if (importing) return;
  const targets = extractTargets(el.urlInput.value);
  if (!targets.length) {
    showToast('没有识别到视频链接或 BV 号', 'error');
    return;
  }
  if (targets.length > 100) {
    showToast('一次最多导入 100 条，已截断', 'error');
    targets.length = 100;
  }

  // 已在队列里的链接不重复加入
  const existing = new Set(tasks.map((t) => t.url.toLowerCase()));
  const fresh = targets.filter((url) => !existing.has(url.toLowerCase()));
  if (!fresh.length) {
    showToast('这些链接都已经在队列里了', 'error');
    return;
  }

  importing = true;
  el.importBtn.disabled = true;
  el.importBtn.textContent = `解析中 0/${fresh.length}`;

  const added = fresh.map(createTask);
  tasks.push(...added);
  renderQueue();

  await resolveTasks(added, (done) => {
    el.importBtn.textContent = `解析中 ${done}/${fresh.length}`;
  });

  importing = false;
  el.importBtn.disabled = false;
  el.importBtn.textContent = '解析并加入队列';

  const queued = added.filter((t) => t.status === 'queued').length;
  const skipped = added.filter((t) => t.status === 'skipped').length;
  const failed = added.filter((t) => t.status === 'failed').length;
  const parts = [`加入 ${queued} 个`];
  if (skipped) parts.push(`跳过 ${skipped} 个已存在`);
  if (failed) parts.push(`${failed} 个解析失败`);
  showToast(parts.join('，'), failed ? 'error' : 'ok');

  if (queued) el.urlInput.value = '';
  updateOverall();
}

/**
 * 批量解析视频信息：拉标题/封面/合集归属，并按需跳过历史里已有的。
 * 导入与「合集单独生成」共用。
 */
async function resolveTasks(list: Task[], onTick?: (done: number, total: number) => void): Promise<void> {
  let done = 0;
  await mapLimit(list, 3, async (task) => {
    try {
      const info = await api.fetchVideoInfo(task.url);
      task.video = info;
      task.part = task.part ?? 1;
      task.status = 'queued';
      task.message = '等待开始';

      if (el.skipHistory.checked) {
        const hit = historyEntries.find(
          (entry) =>
            !entry.collectionTitle &&
            entry.bvid === info.bvid &&
            entry.part === (task.part ?? 1),
        );
        if (hit) {
          task.status = 'skipped';
          task.historyId = hit.id;
          task.message = `已在历史记录中（${formatDate(hit.createdAt)}）`;
        }
      }
    } catch (err) {
      task.status = 'failed';
      task.message = '解析失败';
      task.error = (err as Error).message || '无法解析该链接';
    } finally {
      done += 1;
      onTick?.(done, list.length);
      renderQueue();
    }
  });
}

/* ------------------------------------------------------------------ */
/* 队列渲染                                                            */
/* ------------------------------------------------------------------ */

function renderQueue(): void {
  rowEls.clear();
  el.queueList.innerHTML = '';
  el.queueEmpty.classList.toggle('hidden', tasks.length > 0);

  for (const task of tasks) {
    const row = buildTaskRow(task);
    rowEls.set(task.id, row);
    el.queueList.appendChild(row);
  }

  updateOverall();
}

function buildTaskRow(task: Task): HTMLElement {
  const row = el2('div', `queue-row st-${task.status}`);
  row.dataset.id = task.id;

  const cover = el2('img', 'q-cover');
  const coverSrc = task.collectionCover || task.video?.cover;
  if (coverSrc) cover.src = coverSrc;
  cover.alt = '';
  row.appendChild(cover);

  const main = el2('div', 'q-main');

  const titleLine = el2('div', 'q-title-line');
  const title = el2('span', 'q-title', task.video?.title ?? task.url);
  title.title = task.video?.title ?? task.url;
  titleLine.appendChild(title);

  if (task.kind === 'collection') {
    titleLine.appendChild(
      el2('span', 'chip chip-collection', `合并 ${task.episodeCount ?? 0} 集`),
    );
  } else if (task.video?.collection) {
    const collection = task.video.collection;
    const chip = el2(
      'button',
      'chip chip-collection chip-action',
      `合集 · 共 ${collection.episodes.length} 集`,
    );
    chip.type = 'button';
    chip.title = `属于合集《${collection.title}》，点击选择要处理的集`;
    chip.addEventListener('click', () => openCollectionModal(task.video!));
    titleLine.appendChild(chip);
  }

  if (task.kind === 'single' && task.video && task.video.parts.length > 1) {
    const select = el2('select', 'input select select-tiny');
    task.video.parts.forEach((part) => {
      const option = el2('option', undefined, `P${part.page} ${part.title}`);
      option.value = String(part.page);
      select.appendChild(option);
    });
    select.value = String(task.part ?? 1);
    select.disabled = task.status === 'running' || task.status === 'done';
    select.addEventListener('change', () => {
      task.part = Number(select.value);
      task.status = task.status === 'done' || task.status === 'skipped' ? 'queued' : task.status;
      task.result = undefined;
      renderQueue();
    });
    titleLine.appendChild(select);
  }
  main.appendChild(titleLine);

  const meta = el2('div', 'q-meta');
  const metaParts: string[] = [];
  if (task.kind === 'collection') {
    metaParts.push('合集合并生成');
    metaParts.push(`覆盖 ${task.episodeCount ?? 0} 集`);
    metaParts.push(formatDuration(task.video?.duration ?? 0));
  } else if (task.video) {
    metaParts.push(task.video.owner?.name ?? '');
    metaParts.push(formatDuration(task.video.duration));
    metaParts.push(task.video.bvid);
    metaParts.push(`播放 ${formatCount(task.video.stat?.view ?? 0)}`);
  } else {
    metaParts.push(task.url);
  }
  meta.textContent = metaParts.filter(Boolean).join(' · ');
  main.appendChild(meta);

  const progress = el2('div', 'q-progress');
  const bar = el2('div', 'progress-bar');
  const fill = el2('div', 'progress-fill');
  fill.style.width = `${clamp(task.percent)}%`;
  bar.appendChild(fill);
  const percent = el2('span', 'q-percent', `${Math.round(clamp(task.percent))}%`);
  progress.append(bar, percent);
  progress.classList.toggle('hidden', task.status !== 'running');
  main.appendChild(progress);

  const msg = el2('div', 'q-msg');
  msg.textContent = task.error ? `${task.message}：${task.error}` : task.message;
  if (task.status === 'failed') msg.classList.add('q-msg-error');
  if (task.status === 'skipped') msg.classList.add('q-msg-dim');
  main.appendChild(msg);

  if (task.hint) {
    const hint = el2('div', 'q-hint', task.hint);
    main.appendChild(hint);
  }

  row.appendChild(main);

  const right = el2('div', 'q-right');
  right.appendChild(el2('span', `badge-status st-${task.status}`, STATUS_LABEL[task.status]));

  const actions = el2('div', 'q-actions');

  const canView = task.status === 'done' || task.status === 'skipped';
  const viewBtn = el2('button', 'btn btn-ghost btn-xs', '查看');
  viewBtn.type = 'button';
  viewBtn.disabled = !canView;
  viewBtn.addEventListener('click', () => void showTaskResult(task));
  actions.appendChild(viewBtn);

  if (task.status === 'running' || task.status === 'queued') {
    const cancelBtn = el2('button', 'btn btn-ghost btn-xs', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => void api.cancelJob(task.id));
    actions.appendChild(cancelBtn);
  } else if (task.status === 'failed' || task.status === 'cancelled') {
    const retryBtn = el2('button', 'btn btn-ghost btn-xs', '重试');
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', () => {
      task.status = 'queued';
      task.error = undefined;
      task.hint = undefined;
      task.message = '等待开始';
      renderQueue();
      void handleStartAll([task]);
    });
    actions.appendChild(retryBtn);
  }

  if (task.status !== 'running') {
    const removeBtn = el2('button', 'btn btn-ghost btn-xs', '移除');
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => {
      tasks = tasks.filter((t) => t.id !== task.id);
      renderQueue();
    });
    actions.appendChild(removeBtn);
  }

  right.appendChild(actions);
  row.appendChild(right);

  return row;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** 只更新进度相关 DOM，避免整表重建导致闪烁。 */
function patchTaskRow(task: Task): void {
  const row = rowEls.get(task.id);
  if (!row) {
    renderQueue();
    return;
  }
  row.className = `queue-row st-${task.status}`;

  const fill = row.querySelector<HTMLElement>('.progress-fill');
  const percent = row.querySelector<HTMLElement>('.q-percent');
  const progress = row.querySelector<HTMLElement>('.q-progress');
  const msg = row.querySelector<HTMLElement>('.q-msg');
  const badge = row.querySelector<HTMLElement>('.badge-status');

  if (fill) fill.style.width = `${clamp(task.percent)}%`;
  if (percent) percent.textContent = `${Math.round(clamp(task.percent))}%`;
  if (progress) {
    progress.classList.toggle('hidden', task.status !== 'running');
  }
  if (msg) {
    msg.textContent = task.error ? `${task.message}：${task.error}` : task.message;
    msg.classList.toggle('q-msg-error', task.status === 'failed');
    msg.classList.toggle('q-msg-dim', task.status === 'skipped');
  }
  if (badge) {
    badge.textContent = STATUS_LABEL[task.status];
    badge.className = `badge-status st-${task.status}`;
  }
}

function updateOverall(): void {
  const total = tasks.length;
  const running = tasks.filter((t) => t.status === 'running').length;
  const queued = tasks.filter((t) => t.status === 'queued').length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const skipped = tasks.filter((t) => t.status === 'skipped').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;

  const actionable = tasks.filter((t) => t.status === 'queued' || t.status === 'failed' || t.status === 'cancelled');
  el.startAll.disabled = actionable.length === 0;
  el.startAll.textContent = running
    ? `继续生成${actionable.length ? `（${actionable.length}）` : ''}`
    : actionable.length
      ? `开始生成（${actionable.length}）`
      : '开始生成';

  if (!total) {
    el.queueSummary.textContent = '空';
    el.overallText.textContent = '队列为空';
    el.overallFill.style.width = '0%';
    return;
  }

  const summary: string[] = [`共 ${total}`];
  if (done) summary.push(`完成 ${done}`);
  if (running) summary.push(`进行中 ${running}`);
  if (queued) summary.push(`排队 ${queued}`);
  if (skipped) summary.push(`已存在 ${skipped}`);
  if (failed) summary.push(`失败 ${failed}`);
  el.queueSummary.textContent = summary.join(' · ');

  const settled = done + skipped + failed;
  const percent = total
    ? Math.round((settled * 100 + tasks.reduce((sum, t) => sum + (t.status === 'running' ? clamp(t.percent) : 0), 0)) / total)
    : 0;
  el.overallFill.style.width = `${percent}%`;

  const bits = [`已完成 ${done + skipped} / ${total}`];
  if (running) bits.push(`进行中 ${running}`);
  if (failed) bits.push(`失败 ${failed}`);
  el.overallText.textContent = bits.join(' · ');
}

/* ------------------------------------------------------------------ */
/* 合集选集                                                            */
/* ------------------------------------------------------------------ */

/** 队列里已有的 bvid 集合（用于提示重复）。 */
function queuedBvids(): Set<string> {
  const set = new Set<string>();
  for (const task of tasks) {
    if (task.kind === 'single' && task.video?.bvid) set.add(task.video.bvid);
  }
  return set;
}

function openCollectionModal(video: VideoInfo): void {
  const collection = video.collection;
  if (!collection) return;

  const inQueue = queuedBvids();
  const selected = new Set<string>();
  for (const ep of collection.episodes) {
    if (!inQueue.has(ep.bvid)) selected.add(ep.bvid);
  }
  // 全都已在队列里时，默认还是全选，方便用户改选
  if (!selected.size) collection.episodes.forEach((ep) => selected.add(ep.bvid));

  collectionPick = { video, collection, selected, mode: 'separate' };

  el.collectionTitle.textContent = `合集《${collection.title}》`;
  const totalDuration = collection.episodes.reduce((sum, ep) => sum + ep.duration, 0);
  el.collectionSub.textContent =
    `共 ${collection.total} 集 · 总时长 ${formatDuration(totalDuration)}` +
    (collection.complete ? '' : ' · 集数未取全，可能还有更多');
  el.collectionHint.textContent = '';
  const separate = document.querySelector<HTMLInputElement>(
    'input[name="collection-mode"][value="separate"]',
  );
  if (separate) separate.checked = true;

  renderCollectionModal();
  el.collectionModal.classList.remove('hidden');
}

function closeCollectionModal(): void {
  el.collectionModal.classList.add('hidden');
  collectionPick = null;
}

function renderCollectionModal(): void {
  const state = collectionPick;
  if (!state) return;

  const inQueue = queuedBvids();
  el.collectionList.innerHTML = '';

  for (const ep of state.collection.episodes) {
    const row = el2('label', 'collect-row');

    const box = el2('input');
    box.type = 'checkbox';
    box.checked = state.selected.has(ep.bvid);
    box.addEventListener('change', () => {
      if (!collectionPick) return;
      if (box.checked) collectionPick.selected.add(ep.bvid);
      else collectionPick.selected.delete(ep.bvid);
      updateCollectionSelection();
    });
    row.appendChild(box);

    row.appendChild(el2('span', 'collect-index', `P${ep.index}`));

    const cover = el2('img', 'collect-cover');
    if (ep.cover) cover.src = ep.cover;
    cover.alt = '';
    row.appendChild(cover);

    const main = el2('div', 'collect-main');
    const title = el2('span', 'collect-title', ep.title);
    title.title = ep.title;
    main.appendChild(title);
    const metaBits = [formatDuration(ep.duration), ep.bvid];
    if (ep.section) metaBits.push(ep.section);
    main.appendChild(el2('span', 'collect-meta', metaBits.join(' · ')));
    row.appendChild(main);

    if (inQueue.has(ep.bvid)) row.appendChild(el2('span', 'chip', '已在队列'));

    el.collectionList.appendChild(row);
  }

  updateCollectionSelection();
}

function updateCollectionSelection(): void {
  const state = collectionPick;
  if (!state) return;
  const picked = state.collection.episodes.filter((ep) => state.selected.has(ep.bvid));
  const duration = picked.reduce((sum, ep) => sum + ep.duration, 0);
  el.collectionCount.textContent =
    `已选 ${picked.length} / ${state.collection.episodes.length} 集 · ${formatDuration(duration)}`;
  el.collectionConfirm.disabled = picked.length === 0;
  el.collectionConfirm.textContent =
    state.mode === 'merged'
      ? `合并生成（${picked.length} 集）`
      : `加入队列（${picked.length} 集）`;
}

function toggleAllEpisodes(all: boolean): void {
  const state = collectionPick;
  if (!state) return;
  state.selected.clear();
  if (all) state.collection.episodes.forEach((ep) => state.selected.add(ep.bvid));
  renderCollectionModal();
}

function invertEpisodes(): void {
  const state = collectionPick;
  if (!state) return;
  const next = new Set<string>();
  for (const ep of state.collection.episodes) {
    if (!state.selected.has(ep.bvid)) next.add(ep.bvid);
  }
  state.selected = next;
  renderCollectionModal();
}

async function handleCollectionConfirm(): Promise<void> {
  const state = collectionPick;
  if (!state) return;

  const picked = state.collection.episodes.filter((ep) => state.selected.has(ep.bvid));
  if (!picked.length) {
    showToast('至少勾选一集', 'error');
    return;
  }

  // 合并模式：只建一个任务，只产出一份摘要
  if (state.mode === 'merged') {
    const task = createCollectionTask(state.video, state.collection, picked);
    tasks.push(task);
    renderQueue();
    closeCollectionModal();
    showToast(`已加入合集合并任务（覆盖 ${picked.length} 集），点「开始生成」执行`, 'ok');
    return;
  }

  // 单独模式：勾选几集就加几条任务
  const existing = queuedBvids();
  const fresh = picked.filter((ep) => !existing.has(ep.bvid));
  if (!fresh.length) {
    showToast('勾选的视频都已经在队列里了', 'error');
    return;
  }

  const added = fresh.map((ep) => createTask(`https://www.bilibili.com/video/${ep.bvid}`));
  tasks.push(...added);
  renderQueue();
  closeCollectionModal();
  showToast(`已加入 ${added.length} 集，正在解析`, 'ok');

  await resolveTasks(added);
  updateOverall();
}

/* ------------------------------------------------------------------ */
/* 开始 / 取消                                                         */
/* ------------------------------------------------------------------ */

async function handleStartAll(only?: Task[]): Promise<void> {
  const pool = only ?? tasks;
  const runnable = pool.filter(
    (t) => t.status === 'queued' || t.status === 'failed' || t.status === 'cancelled',
  );
  if (!runnable.length) {
    showToast('没有待生成的任务', 'error');
    return;
  }

  const source = el.sourceSelect.value as 'auto' | TranscriptSource;
  const provider = el.providerSelect.value as LlmProviderKind;
  const concurrency = Number(el.videoConcurrency.value) || config?.videoConcurrency || 2;

  for (const task of runnable) {
    task.status = 'queued';
    task.percent = 0;
    task.error = undefined;
    task.hint = undefined;
    task.message = task.kind === 'collection' ? '等待开始合并' : '等待开始';
    task.result = undefined;
  }
  renderQueue();

  const singles = runnable.filter((task) => task.kind === 'single');
  const merged = runnable.filter((task) => task.kind === 'collection');

  try {
    if (singles.length) {
      const res = await api.startBatch(
        singles.map((task) => ({
          taskId: task.id,
          request: {
            url: task.url,
            part: task.part,
            source: source === 'auto' ? undefined : (source as TranscriptSource),
            provider,
          },
        })),
        concurrency,
      );
      if (!res.ok) {
        showToast('启动失败', 'error');
        return;
      }
    }

    // 合集合并任务单独提交，一个任务只产出 1 份摘要
    for (const task of merged) {
      if (!task.collectionRequest) continue;
      const res = await api.startCollection(task.id, {
        ...task.collectionRequest,
        source: source === 'auto' ? undefined : (source as TranscriptSource),
        provider,
      });
      if (!res.ok) {
        task.status = 'failed';
        task.message = '启动失败';
        task.error = res.message || '合集任务启动失败';
        renderQueue();
      }
    }

    const total = singles.length + merged.length;
    showToast(`已提交 ${total} 个任务，并发 ${concurrency}`, 'ok');
  } catch (err) {
    showToast(`启动失败：${(err as Error).message}`, 'error');
  }
}

async function handleCancelAll(): Promise<void> {
  await api.cancelAllJobs();
  showToast('已取消全部任务', 'info');
}

function handleClearDone(): void {
  const before = tasks.length;
  tasks = tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'skipped' && t.status !== 'cancelled',
  );
  renderQueue();
  showToast(`已清除 ${before - tasks.length} 项`, 'ok');
}

function handleProgress(progress: JobProgress): void {
  const task = tasks.find((t) => t.id === progress.jobId);
  if (!task) return;
  task.status = 'running';
  task.percent = progress.percent;
  task.message = progress.message;
  task.detail = progress.detail;
  patchTaskRow(task);
  updateOverall();
}

function handleDone(result: JobResult): void {
  const task = tasks.find((t) => t.id === result.jobId);
  if (task) {
    task.status = 'done';
    task.percent = 100;
    task.message = `${result.summary.model} · ${SOURCE_LABEL[result.summary.transcriptSource] ?? '已生成'}`;
    task.error = undefined;
    task.result = result;
    renderQueue();
  }
  showToast(`「${result.video.title}」摘要完成`, 'ok');

  // 结果区空着就直接展示，否则保持用户正在看的那篇
  if (!shownResultKey && task) {
    void showTaskResult(task, { scroll: false });
  }

  void loadHistory();
}

function handleFailed(info: { jobId: string; message: string; hint?: string }): void {
  const task = tasks.find((t) => t.id === info.jobId);
  if (!task) return;
  task.status = 'failed';
  task.message = '生成失败';
  task.error = info.message;
  task.hint = info.hint;
  renderQueue();
  showToast(`${task.video?.title ?? task.url} 失败`, 'error');
}

function handleCancelled(info: { jobId: string }): void {
  const task = tasks.find((t) => t.id === info.jobId);
  if (!task) return;
  task.status = 'cancelled';
  task.message = '已取消';
  renderQueue();
}

/* ------------------------------------------------------------------ */
/* 结果面板                                                            */
/* ------------------------------------------------------------------ */

async function showTaskResult(task: Task, opts: { scroll?: boolean } = {}): Promise<void> {
  let result = task.result;
  if (!result && task.historyId) {
    const record = await api.getHistory(task.historyId);
    if (record) {
      result = record.result;
      task.result = result;
    }
  }
  if (!result) {
    showToast('这条还没有生成结果', 'error');
    return;
  }
  const panel = createResultPanel(result, {
    onClose: () => {
      el.resultHost.innerHTML = '';
      shownResultKey = null;
    },
  });
  el.resultHost.innerHTML = '';
  el.resultHost.appendChild(panel);
  shownResultKey = task.id;
  // 批量生成时不要抢走视线，只有用户主动点「查看」才滚动过去
  if (opts.scroll !== false) {
    el.resultHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const SOURCE_LABEL: Record<string, string> = {
  subtitle: 'B站官方字幕',
  asr: '语音识别',
  'bilibili-ai': 'B站官方AI总结',
  none: '无',
};

function createResultPanel(
  result: JobResult,
  opts: { onClose?: () => void; compact?: boolean } = {},
): HTMLElement {
  const summary = result.summary;
  const wrap = el2('section', 'card result-card');

  const head = el2('div', 'card-head result-head');
  const titleBox = el2('div', 'result-title-box');
  const link = el2('a', 'result-title', result.video.title);
  link.href = result.video.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  titleBox.appendChild(link);

  const metaBits = result.collection
    ? [
        `合集《${result.collection.title}》`,
        `覆盖 ${result.collection.covered}/${result.collection.total} 集`,
        formatDuration(
          result.collection.episodes.reduce((sum, ep) => sum + ep.duration, 0),
        ),
      ]
    : [
        result.video.owner?.name ?? '',
        formatDuration(result.video.duration),
        result.video.bvid,
      ];
  const meta = el2('div', 'result-meta', metaBits.filter(Boolean).join(' · '));
  titleBox.appendChild(meta);
  head.appendChild(titleBox);

  // 合集结果的时间戳是「虚拟时间轴」，要还原成「第 N 集 mm:ss」
  const fmtTime = result.collection
    ? (seconds: number, title?: string) =>
        formatCollectionTimestamp(result.collection!.episodes, seconds, title)
    : (seconds: number) => formatTimestamp(seconds);

  const actions = el2('div', 'head-actions');

  const copyBtn = el2('button', 'btn btn-ghost btn-sm', '复制 Markdown');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(result.markdown);
      showToast('已复制到剪贴板', 'ok');
    } catch {
      showToast('复制失败', 'error');
    }
  });
  actions.appendChild(copyBtn);

  const saveBtn = el2('button', 'btn btn-ghost btn-sm', '保存');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', async () => {
    const name = `${result.video.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 50)}-${result.video.bvid}.md`;
    const res = await api.saveMarkdown(name, result.markdown);
    if (res.ok && res.path) showToast(`已保存到 ${res.path}`, 'ok');
  });
  actions.appendChild(saveBtn);

  const srtBtn = el2('button', 'btn btn-ghost btn-sm', '导出字幕');
  srtBtn.type = 'button';
  srtBtn.disabled = !result.transcript.segments.length;
  srtBtn.addEventListener('click', async () => {
    const content = result.transcript.segments
      .map((seg, i) => `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text}\n`)
      .join('\n');
    const res = await api.exportTranscript(`${result.video.bvid}.srt`, content);
    if (res.ok && res.path) showToast(`已导出到 ${res.path}`, 'ok');
  });
  actions.appendChild(srtBtn);

  if (opts.onClose) {
    const closeBtn = el2('button', 'btn btn-ghost btn-sm', '关闭');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => opts.onClose?.());
    actions.appendChild(closeBtn);
  }
  head.appendChild(actions);
  wrap.appendChild(head);

  // 标签页
  const tabs = el2('div', 'tabs');
  const panels: { key: string; label: string }[] = [
    { key: 'summary', label: '摘要' },
    { key: 'markdown', label: 'Markdown' },
    { key: 'transcript', label: `字幕（${result.transcript.segments.length}）` },
  ];
  const panelEls = new Map<string, HTMLElement>();

  for (const [index, item] of panels.entries()) {
    const tab = el2('button', `tab${index === 0 ? ' active' : ''}`, item.label);
    tab.type = 'button';
    const panel = el2('div', `tab-panel${index === 0 ? ' active' : ''}`);
    panelEls.set(item.key, panel);
    tab.addEventListener('click', () => {
      tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      panelEls.forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      panel.classList.add('active');
    });
    tabs.appendChild(tab);
  }
  wrap.appendChild(tabs);

  // 摘要面板
  const summaryPanel = panelEls.get('summary')!;

  if (result.collection) {
    const list = el2('div', 'collection-episodes');
    for (const ep of result.collection.episodes) {
      const row = el2('div', 'collection-episode');
      row.appendChild(el2('span', 'ce-index', `第${ep.index}集`));
      const ceTitle = el2('a', 'ce-title', ep.title);
      ceTitle.href = ep.url;
      ceTitle.target = '_blank';
      ceTitle.rel = 'noreferrer';
      ceTitle.title = ep.title;
      row.appendChild(ceTitle);
      row.appendChild(el2('span', 'ce-meta', formatDuration(ep.duration)));
      if (!ep.segmentCount) {
        row.appendChild(el2('span', 'chip chip-warn', '无字幕'));
      }
      list.appendChild(row);
    }
    summaryPanel.appendChild(
      summaryBlock(
        `收录视频（${result.collection.covered}/${result.collection.total} 集）`,
        list,
      ),
    );
  }

  summaryPanel.appendChild(summaryBlock('一句话总结', el2('p', 'tldr', summary.tldr || '（无）')));

  if (summary.keyPoints?.length) {
    summaryPanel.appendChild(summaryBlock('关键要点', buildList(summary.keyPoints)));
  }
  if (summary.outline?.length) {
    const outline = el2('ul', 'outline');
    for (const item of summary.outline) {
      const li = el2('li');
      li.append(el2('code', undefined, fmtTime(item.start, item.title)), el2('span', undefined, item.title));
      outline.appendChild(li);
    }
    summaryPanel.appendChild(summaryBlock('章节速览', outline));
  }
  if (summary.segments?.length) {
    const segs = el2('div', 'segments');
    for (const seg of summary.segments) {
      const box = el2('div', 'segment');
      const segHead = el2('div', 'segment-head');
      segHead.append(
        el2('span', 'segment-time', `${fmtTime(seg.start, seg.title)} - ${fmtTime(seg.end, seg.title)}`),
        el2('span', 'segment-title', seg.title),
      );
      box.appendChild(segHead);
      if (seg.points?.length) {
        const ul = el2('ul', 'segment-points');
        for (const point of seg.points) ul.appendChild(el2('li', undefined, point));
        box.appendChild(ul);
      }
      if (seg.summary) box.appendChild(el2('p', 'segment-summary', seg.summary));
      segs.appendChild(box);
    }
    summaryPanel.appendChild(summaryBlock('分段摘要', segs));
  }
  if (summary.insights?.length) {
    summaryPanel.appendChild(summaryBlock('关键洞察', buildList(summary.insights)));
  }
  if (summary.warnings?.length) {
    const block = summaryBlock('注意', buildList(summary.warnings));
    block.classList.add('warning-block');
    summaryPanel.appendChild(block);
  }

  summaryPanel.appendChild(
    el2(
      'p',
      'summary-meta',
      `模型：${summary.model} · 字幕来源：${SOURCE_LABEL[summary.transcriptSource] ?? summary.transcriptSource} · 生成于 ${new Date(summary.createdAt).toLocaleString('zh-CN')}`,
    ),
  );

  // Markdown 面板
  const mdPanel = panelEls.get('markdown')!;
  const pre = el2('pre', 'markdown-view', result.markdown);
  mdPanel.appendChild(pre);

  // 字幕面板
  const trPanel = panelEls.get('transcript')!;
  if (result.transcript.segments.length) {
    const list = el2('div', 'transcript');
    for (const seg of result.transcript.segments) {
      const line = el2('div', 'transcript-line');
      line.append(
        el2('span', 'transcript-time', fmtTime(seg.start)),
        el2('span', undefined, seg.text),
      );
      list.appendChild(line);
    }
    trPanel.appendChild(list);
  } else {
    trPanel.appendChild(el2('p', 'hint-text', '这篇没有字幕（可能来自 B 站官方 AI 总结）。'));
  }

  for (const panel of panelEls.values()) wrap.appendChild(panel);
  return wrap;
}

function summaryBlock(title: string, content: HTMLElement): HTMLElement {
  const block = el2('div', 'summary-block');
  block.appendChild(el2('h3', undefined, title));
  block.appendChild(content);
  return block;
}

function buildList(items: string[]): HTMLElement {
  const ul = el2('ul', 'points');
  for (const item of items) ul.appendChild(el2('li', undefined, item));
  return ul;
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
/* 队列导出                                                            */
/* ------------------------------------------------------------------ */

async function handleExportAll(): Promise<void> {
  const finished = tasks.filter((t) => t.status === 'done' && t.result);
  if (!finished.length) {
    showToast('还没有已完成的任务', 'error');
    return;
  }

  const now = new Date();
  const parts: string[] = [
    '# BiliSummary 批量摘要',
    '',
    `> 导出时间：${now.toLocaleString('zh-CN')} · 共 ${finished.length} 篇`,
    '',
    '## 目录',
    '',
    ...finished.map((t, i) => `${i + 1}. ${t.result!.video.title}（${t.result!.video.bvid}）`),
    '',
    '---',
    '',
  ];
  for (const task of finished) {
    parts.push(task.result!.markdown.trim(), '', '---', '');
  }

  const stamp = now.toISOString().slice(0, 10);
  const res = await api.saveMarkdown(`BiliSummary-批量摘要-${stamp}.md`, parts.join('\n'));
  if (res.ok && res.path) showToast(`已导出 ${finished.length} 篇到 ${res.path}`, 'ok');
}

/* ------------------------------------------------------------------ */
/* 历史记录                                                            */
/* ------------------------------------------------------------------ */

async function loadHistory(): Promise<void> {
  try {
    historyEntries = await api.listHistory();
  } catch (err) {
    console.error('读取历史失败', err);
    historyEntries = [];
  }
  updateHistoryCount();
  if (activeView === 'history') renderHistory();
}

function updateHistoryCount(): void {
  el.historyCount.textContent = String(historyEntries.length);
  el.historyCount.classList.toggle('hidden', historyEntries.length === 0);
}

function filteredHistory(): HistoryEntry[] {
  const keyword = el.historySearch.value.trim().toLowerCase();
  const onlyFav = el.historyFilter.value === 'fav';
  return historyEntries.filter((entry) => {
    if (onlyFav && !entry.favorite) return false;
    if (!keyword) return true;
    return (
      entry.title.toLowerCase().includes(keyword) ||
      entry.bvid.toLowerCase().includes(keyword) ||
      entry.owner.toLowerCase().includes(keyword) ||
      entry.tldr.toLowerCase().includes(keyword)
    );
  });
}

function renderHistory(): void {
  const list = filteredHistory();
  el.historyList.innerHTML = '';
  el.historyEmpty.classList.toggle('hidden', list.length > 0);
  el.historyEmpty.querySelector('p')!.textContent = historyEntries.length
    ? '没有匹配的记录，换个关键词试试。'
    : '还没有历史记录。';

  el.historySummary.textContent = historyEntries.length
    ? `共 ${historyEntries.length} 条${list.length !== historyEntries.length ? ` · 筛选出 ${list.length}` : ''}`
    : '';

  const frag = document.createDocumentFragment();
  for (const entry of list) {
    frag.appendChild(buildHistoryRow(entry));
  }
  el.historyList.appendChild(frag);
}

function buildHistoryRow(entry: HistoryEntry): HTMLElement {
  const row = el2('div', 'history-row');

  const cover = el2('img', 'h-cover');
  if (entry.cover) cover.src = entry.cover;
  cover.alt = '';
  row.appendChild(cover);

  const main = el2('div', 'h-main');
  const title = el2('a', 'h-title', entry.title);
  title.href = entry.url;
  title.target = '_blank';
  title.rel = 'noreferrer';
  main.appendChild(title);

  const metaBits = [
    entry.collectionTitle ? `合集《${entry.collectionTitle}》· ${entry.episodeCount ?? 0} 集合并` : '',
    entry.owner,
    formatDuration(entry.duration),
    entry.bvid,
    entry.part > 1 ? `P${entry.part}` : '',
    formatDate(entry.createdAt),
    SOURCE_LABEL[entry.transcriptSource] ?? entry.transcriptSource,
  ].filter(Boolean);
  main.appendChild(el2('div', 'h-meta', metaBits.join(' · ')));

  if (entry.tldr) main.appendChild(el2('p', 'h-tldr', entry.tldr));

  row.appendChild(main);

  const actions = el2('div', 'h-actions');

  const openBtn = el2('button', 'btn btn-ghost btn-xs', '查看');
  openBtn.type = 'button';
  openBtn.addEventListener('click', () => void openHistory(entry.id));
  actions.appendChild(openBtn);

  const favBtn = el2('button', `btn btn-ghost btn-xs${entry.favorite ? ' is-fav' : ''}`, entry.favorite ? '★ 已收藏' : '☆ 收藏');
  favBtn.type = 'button';
  favBtn.addEventListener('click', async () => {
    const updated = await api.favoriteHistory(entry.id, !entry.favorite);
    if (updated) {
      entry.favorite = updated.favorite;
      renderHistory();
    }
  });
  actions.appendChild(favBtn);

  const copyBtn = el2('button', 'btn btn-ghost btn-xs', '复制');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    const record = await api.getHistory(entry.id);
    if (!record) {
      showToast('记录已丢失', 'error');
      return;
    }
    await navigator.clipboard.writeText(record.result.markdown);
    showToast('已复制 Markdown', 'ok');
  });
  actions.appendChild(copyBtn);

  const delBtn = el2('button', 'btn btn-ghost btn-xs danger', '删除');
  delBtn.type = 'button';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm(`删除「${entry.title}」这条记录？`)) return;
    await api.deleteHistory(entry.id);
    historyEntries = historyEntries.filter((e) => e.id !== entry.id);
    updateHistoryCount();
    renderHistory();
    showToast('已删除', 'ok');
  });
  actions.appendChild(delBtn);

  row.appendChild(actions);
  return row;
}

async function openHistory(id: string): Promise<void> {
  const record: HistoryRecord | null = await api.getHistory(id);
  if (!record) {
    showToast('记录内容已丢失', 'error');
    return;
  }
  const panel = createResultPanel(record.result, {
    onClose: () => {
      el.historyDetailHost.innerHTML = '';
    },
  });
  el.historyDetailHost.innerHTML = '';
  el.historyDetailHost.appendChild(panel);
  el.historyDetailHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleHistoryExport(mode: 'merged' | 'folder'): Promise<void> {
  const ids = filteredHistory().map((entry) => entry.id);
  if (!ids.length) {
    showToast('没有可导出的记录', 'error');
    return;
  }
  const res =
    mode === 'merged' ? await api.exportHistoryMerged(ids) : await api.exportHistoryFolder(ids);
  if (res.canceled) return;
  if (res.ok) {
    showToast(`已导出 ${res.count ?? ids.length} 篇到 ${res.path}`, 'ok');
  } else {
    showToast(res.message || '导出失败', 'error');
  }
}

async function handleHistoryClear(): Promise<void> {
  if (!historyEntries.length) {
    showToast('历史记录已经是空的', 'info');
    return;
  }
  if (!window.confirm(`确定清空全部 ${historyEntries.length} 条历史记录？此操作不可恢复。`)) return;
  const res = await api.clearHistory();
  historyEntries = [];
  updateHistoryCount();
  renderHistory();
  el.historyDetailHost.innerHTML = '';
  showToast(`已清空 ${res.count} 条`, 'ok');
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

  ($<HTMLInputElement>('cfg-deepseek-base')).value = cfg.deepseek.baseUrl;
  ($<HTMLInputElement>('cfg-deepseek-key')).value = cfg.deepseek.apiKey;
  setDeepSeekModelOptions(cfg.deepseek.model);
  ($<HTMLInputElement>('cfg-deepseek-temp')).value = String(cfg.deepseek.temperature);
  ($<HTMLInputElement>('cfg-deepseek-budget')).value = String(cfg.deepseek.contextChars);

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
  ($<HTMLInputElement>('cfg-video-concurrency')).value = String(cfg.videoConcurrency ?? 2);
  ($<HTMLInputElement>('cfg-history-limit')).value = String(cfg.historyLimit ?? 500);
  ($<HTMLInputElement>('cfg-save-history')).checked = cfg.saveHistory !== false;
  ($<HTMLInputElement>('cfg-use-danmaku')).checked = cfg.useDanmaku;
  ($<HTMLInputElement>('cfg-export-transcript')).checked = cfg.exportTranscript;

  updateProviderFields();
  updateAsrFields();
}

function updateProviderFields(): void {
  const kind = ($<HTMLSelectElement>('cfg-llm-provider')).value;
  $('cfg-openai').classList.toggle('hidden', kind !== 'openai');
  $('cfg-deepseek').classList.toggle('hidden', kind !== 'deepseek');
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
    deepseek: {
      baseUrl: $<HTMLInputElement>('cfg-deepseek-base').value.trim(),
      apiKey: $<HTMLInputElement>('cfg-deepseek-key').value.trim(),
      model: $<HTMLSelectElement>('cfg-deepseek-model').value.trim() || 'deepseek-chat',
      temperature: Number($<HTMLInputElement>('cfg-deepseek-temp').value) || 0.3,
      maxTokens: config?.deepseek.maxTokens ?? 4096,
      contextChars: Number($<HTMLInputElement>('cfg-deepseek-budget').value) || 16000,
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
    videoConcurrency: Number($<HTMLInputElement>('cfg-video-concurrency').value) || 2,
    historyLimit: Number($<HTMLInputElement>('cfg-history-limit').value) || 500,
    saveHistory: $<HTMLInputElement>('cfg-save-history').checked,
    useDanmaku: $<HTMLInputElement>('cfg-use-danmaku').checked,
    exportTranscript: $<HTMLInputElement>('cfg-export-transcript').checked,
  };

  try {
    config = await api.setConfig(partial);
    populateProviderSelect(config);
    el.videoConcurrency.value = String(config.videoConcurrency ?? 2);
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
async function pickPath(inputId: string, kind: 'exe' | 'model' | 'binary'): Promise<void> {
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
/* DeepSeek 模型下拉                                                     */
/* ------------------------------------------------------------------ */

/** 填充 DeepSeek 模型下拉框；配置里若存了自定义模型名也要能保留。 */
function setDeepSeekModelOptions(current: string): void {
  const select = $<HTMLSelectElement>('cfg-deepseek-model');
  const known = Array.from(select.options).map((o) => o.value);
  if (current && !known.includes(current)) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = current;
    select.appendChild(option);
  }
  select.value = current || 'deepseek-chat';
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
async function refreshShortcutState(): Promise<void> {
  try {
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
