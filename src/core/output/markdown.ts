/** 把摘要渲染成 Markdown / SRT 等可导出格式。 */
import type {
  DanmakuItem,
  Transcript,
  VideoInfo,
  VideoSummary,
} from '../types.js';
import { formatDate, formatDurationCn, formatTimestamp, toSrtTimestamp } from '../utils/time.js';

/** 渲染完整的摘要 Markdown。 */
export function renderMarkdown(params: {
  video: VideoInfo;
  summary: VideoSummary;
  transcript?: Transcript;
  danmaku?: DanmakuItem[];
  includeTranscript?: boolean;
}): string {
  const { video, summary, transcript, danmaku, includeTranscript } = params;
  const lines: string[] = [];

  lines.push(`# ${video.title}`);
  lines.push('');

  // 元信息表
  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  lines.push(`| UP主 | ${video.owner.name} |`);
  lines.push(`| 时长 | ${formatDurationCn(video.duration)} |`);
  lines.push(`| BV号 | ${video.bvid} |`);
  lines.push(`| 链接 | ${video.url} |`);
  if (video.pubdate) lines.push(`| 发布于 | ${formatDate(video.pubdate)} |`);
  lines.push(`| 播放 | ${formatCount(video.stat.view)} |`);
  lines.push(`| 点赞 | ${formatCount(video.stat.like)} |`);
  lines.push(`| 投币 | ${formatCount(video.stat.coin)} |`);
  lines.push(`| 收藏 | ${formatCount(video.stat.favorite)} |`);
  lines.push(`| 弹幕 | ${formatCount(video.stat.danmaku)} |`);
  lines.push('');

  if (video.desc.trim()) {
    lines.push('## 视频简介');
    lines.push('');
    lines.push(video.desc.trim());
    lines.push('');
  }

  if (summary.warnings?.length) {
    lines.push('## ⚠️ 注意');
    lines.push('');
    for (const warning of summary.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  if (summary.tldr) {
    lines.push('## 一句话总结');
    lines.push('');
    lines.push(summary.tldr);
    lines.push('');
  }

  if (summary.keyPoints.length) {
    lines.push('## 关键要点');
    lines.push('');
    for (const point of summary.keyPoints) {
      lines.push(`- ${point}`);
    }
    lines.push('');
  }

  if (summary.outline.length) {
    lines.push('## 章节速览');
    lines.push('');
    for (const item of summary.outline) {
      lines.push(`- \`${formatTimestamp(item.start)}\` ${item.title}`);
    }
    lines.push('');
  }

  if (summary.segments.length) {
    lines.push('## 分段摘要');
    lines.push('');
    for (const seg of summary.segments) {
      lines.push(
        `### ${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)} · ${seg.title}`,
      );
      if (seg.points.length) {
        lines.push('');
        for (const point of seg.points) {
          lines.push(`- ${point}`);
        }
      }
      if (seg.summary) {
        lines.push('');
        lines.push(`**概述**：${seg.summary}`);
      }
      lines.push('');
    }
  }

  if (summary.insights.length) {
    lines.push('## 关键洞察');
    lines.push('');
    for (const insight of summary.insights) {
      lines.push(`- ${insight}`);
    }
    lines.push('');
  }

  if (includeTranscript && transcript?.segments.length) {
    lines.push('## 字幕全文');
    lines.push('');
    for (const seg of transcript.segments) {
      lines.push(`\`${formatTimestamp(seg.start)}\` ${seg.text}`);
      lines.push('');
    }
  }

  if (danmaku?.length) {
    lines.push('## 高光弹幕');
    lines.push('');
    for (const item of danmaku.slice(0, 50)) {
      lines.push(`- \`${formatTimestamp(item.time)}\` ${item.text}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `> 由 BiliSummary 生成于 ${formatDate(Math.floor(Date.now() / 1000))} · 模型：${summary.model} · 字幕来源：${sourceLabel(summary.transcriptSource)}`,
  );
  lines.push('');

  return lines.join('\n');
}

/** 渲染字幕全文为 Markdown。 */
export function renderTranscriptMarkdown(
  transcript: Transcript,
  video?: VideoInfo,
): string {
  const lines: string[] = [];
  if (video) {
    lines.push(`# ${video.title} — 字幕`);
    lines.push('');
    lines.push(`> ${video.url}`);
    lines.push('');
  }
  for (const seg of transcript.segments) {
    lines.push(`\`${formatTimestamp(seg.start)}\` ${seg.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 渲染为 SRT 字幕文件。 */
export function renderSrt(transcript: Transcript): string {
  const lines: string[] = [];
  transcript.segments.forEach((seg, i) => {
    lines.push(String(i + 1));
    lines.push(`${toSrtTimestamp(seg.start)} --> ${toSrtTimestamp(seg.end)}`);
    lines.push(seg.text);
    lines.push('');
  });
  return lines.join('\n');
}

/** 生成本地文件名。 */
export function buildFileName(video: VideoInfo, suffix = '摘要'): string {
  const safe = video.title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${safe}-${video.bvid}-${suffix}.md`;
}

function formatCount(n: number): string {
  if (!n) return '0';
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'subtitle':
      return 'B站官方字幕';
    case 'asr':
      return '语音识别';
    case 'bilibili-ai':
      return 'B站官方AI总结';
    default:
      return source;
  }
}
