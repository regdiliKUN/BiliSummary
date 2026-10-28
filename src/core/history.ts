/**
 * 本地历史记录。
 *
 * 目录结构：
 *   <dir>/index.json          轻量索引（列表用，含标题 / TL;DR / 收藏等）
 *   <dir>/items/<id>.json     单条完整结果（含 Markdown、字幕、结构化摘要）
 *
 * 设计要点：
 * - 索引与内容分开，列表刷新不必读入全部字幕，几千条也不会卡。
 * - 写入采用「临时文件 + rename」，避免进程被强杀时留下半个 JSON。
 * - 超过上限按时间淘汰最旧的，同时删除对应内容文件。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { HistoryEntry, HistoryRecord, JobResult } from './types.js';

/** 文件名里不能出现的字符（Windows 最严格，统一按它来）。 */
const ILLEGAL_NAME = /[\\/:*?"<>|\r\n\t]/g;

function safeFileName(input: string, maxLength = 60): string {
  const cleaned = (input || '')
    .replace(ILLEGAL_NAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned || '未命名';
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

export interface AddHistoryOptions {
  /** 最多保留条数，<=0 表示不限制 */
  limit?: number;
}

export class HistoryStore {
  readonly dir: string;
  readonly itemsDir: string;
  readonly indexFile: string;

  private entries: HistoryEntry[] | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.itemsDir = join(dir, 'items');
    this.indexFile = join(dir, 'index.json');
  }

  private ensureDirs(): void {
    if (!existsSync(this.itemsDir)) mkdirSync(this.itemsDir, { recursive: true });
  }

  private loadIndex(): HistoryEntry[] {
    if (this.entries) return this.entries;
    this.ensureDirs();
    try {
      if (existsSync(this.indexFile)) {
        const raw = readFileSync(this.indexFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.entries = parsed.filter(isEntryLike);
          return this.entries;
        }
      }
    } catch (err) {
      console.warn(`历史索引读取失败，按空索引处理：${(err as Error).message}`);
    }
    this.entries = [];
    return this.entries;
  }

  private saveIndex(): void {
    this.ensureDirs();
    atomicWrite(this.indexFile, JSON.stringify(this.entries ?? [], null, 2));
  }

  /** 列出全部历史（新 -> 旧）。 */
  list(): HistoryEntry[] {
    return this.loadIndex().slice();
  }

  /** 按 id 读取完整记录。 */
  get(id: string): HistoryRecord | null {
    const entry = this.loadIndex().find((item) => item.id === id);
    if (!entry) return null;
    const file = join(this.itemsDir, `${id}.json`);
    try {
      if (!existsSync(file)) return null;
      const result = JSON.parse(readFileSync(file, 'utf8')) as JobResult;
      return { entry, result };
    } catch (err) {
      console.warn(`历史记录 ${id} 读取失败：${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 判断某个视频（含分P）是否已有记录，返回最新一条。
   *
   * 合集合并记录挂在「第一集」的 bvid 上，但它覆盖的是多集，
   * 不能当成「这个视频已经总结过」，所以要排除。
   */
  find(bvid: string, part = 1): HistoryEntry | null {
    return (
      this.loadIndex().find(
        (item) => !item.collectionTitle && item.bvid === bvid && item.part === part,
      ) ?? null
    );
  }

  /** 写入一条新记录。 */
  add(result: JobResult, opts: AddHistoryOptions = {}): HistoryEntry {
    this.ensureDirs();
    const entries = this.loadIndex();
    const createdAt = new Date().toISOString();
    const id = this.buildId(result, createdAt);

    const entry: HistoryEntry = {
      id,
      bvid: result.video.bvid,
      part: extractPart(result),
      title: result.video.title,
      url: result.video.url,
      cover: result.video.cover,
      owner: result.video.owner?.name ?? '',
      duration: result.video.duration,
      createdAt,
      model: result.summary.model,
      provider: result.summary.provider,
      transcriptSource: result.summary.transcriptSource,
      tldr: result.summary.tldr ?? '',
      keyPoints: (result.summary.keyPoints ?? []).slice(0, 8),
      favorite: false,
      markdownLength: result.markdown?.length ?? 0,
      collectionTitle: result.collection?.title,
      episodeCount: result.collection?.covered,
    };

    atomicWrite(join(this.itemsDir, `${id}.json`), JSON.stringify(result));

    entries.unshift(entry);
    this.saveIndex();
    this.prune(opts.limit ?? 500);
    return entry;
  }

  /** 删除一条。 */
  remove(id: string): boolean {
    const entries = this.loadIndex();
    const idx = entries.findIndex((item) => item.id === id);
    if (idx < 0) return false;
    entries.splice(idx, 1);
    this.saveIndex();
    this.unlinkItem(id);
    return true;
  }

  /** 清空全部。 */
  clear(): number {
    const entries = this.loadIndex();
    const count = entries.length;
    this.entries = [];
    this.saveIndex();
    try {
      for (const name of readdirSync(this.itemsDir)) {
        if (name.endsWith('.json')) {
          try {
            unlinkSync(join(this.itemsDir, name));
          } catch {
            /* 单个文件删除失败不影响整体清空 */
          }
        }
      }
    } catch {
      /* 目录不存在等，忽略 */
    }
    return count;
  }

  /** 设置收藏状态。 */
  setFavorite(id: string, favorite: boolean): HistoryEntry | null {
    const entry = this.loadIndex().find((item) => item.id === id);
    if (!entry) return null;
    entry.favorite = favorite;
    this.saveIndex();
    return entry;
  }

  /** 更新标题等轻量字段。 */
  patchEntry(id: string, patch: Partial<Pick<HistoryEntry, 'title' | 'favorite'>>): HistoryEntry | null {
    const entry = this.loadIndex().find((item) => item.id === id);
    if (!entry) return null;
    Object.assign(entry, patch);
    this.saveIndex();
    return entry;
  }

  /** 把多条记录合并成一个 Markdown 文档。 */
  buildMergedMarkdown(ids: string[]): { content: string; missing: string[] } {
    const missing: string[] = [];
    const parts: string[] = [];
    const picked: { entry: HistoryEntry; markdown: string }[] = [];

    for (const id of ids) {
      const record = this.get(id);
      if (!record) {
        missing.push(id);
        continue;
      }
      picked.push({ entry: record.entry, markdown: record.result.markdown });
    }

    const now = new Date();
    parts.push('# BiliSummary 批量摘要');
    parts.push('');
    parts.push(`> 导出时间：${now.toLocaleString('zh-CN')} · 共 ${picked.length} 篇`);
    parts.push('');
    parts.push('## 目录');
    parts.push('');
    picked.forEach((item, i) => {
      parts.push(`${i + 1}. ${item.entry.title}（${item.entry.bvid}）`);
    });
    parts.push('');
    parts.push('---');
    parts.push('');

    for (const item of picked) {
      parts.push(`<!-- ${item.entry.id} -->`);
      parts.push(item.markdown.trim());
      parts.push('');
      parts.push('---');
      parts.push('');
    }

    return { content: parts.join('\n'), missing };
  }

  /** 把多条记录各自写成独立文件，返回写入数量。 */
  exportToFolder(ids: string[], targetDir: string): { written: number; missing: string[] } {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const missing: string[] = [];
    const used = new Set<string>();
    let written = 0;

    for (const id of ids) {
      const record = this.get(id);
      if (!record) {
        missing.push(id);
        continue;
      }
      const base = `${safeFileName(record.entry.title, 50)}-${record.entry.bvid}`;
      let name = `${base}.md`;
      let n = 2;
      while (used.has(name) || existsSync(join(targetDir, name))) {
        name = `${base}-${n}.md`;
        n += 1;
      }
      used.add(name);
      writeFileSync(join(targetDir, name), record.result.markdown, 'utf8');
      written += 1;
    }

    return { written, missing };
  }

  /** 超出上限时淘汰最旧的记录。 */
  private prune(limit: number): void {
    if (!limit || limit <= 0) return;
    const entries = this.loadIndex();
    if (entries.length <= limit) return;
    const removed = entries.splice(limit);
    this.saveIndex();
    for (const item of removed) this.unlinkItem(item.id);
  }

  private unlinkItem(id: string): void {
    try {
      const file = join(this.itemsDir, `${id}.json`);
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* 忽略 */
    }
  }

  private buildId(result: JobResult, createdAt: string): string {
    const stamp = Date.parse(createdAt).toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    const part = extractPart(result);
    return `${result.video.bvid}${part > 1 ? `_p${part}` : ''}_${stamp}_${rand}`;
  }
}

/** 从结果里推断分P号：标题被 runJob 拼成「原标题 - P2 xxx」。 */
function extractPart(result: JobResult): number {
  const fromTitle = result.video.title.match(/- P(\d+)\s/);
  if (fromTitle) return Number(fromTitle[1]);
  const part = result.video.parts?.find((p) => p.cid === result.video.cid);
  return part?.page ?? 1;
}

function isEntryLike(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.bvid === 'string' && typeof v.createdAt === 'string';
}
