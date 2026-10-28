/** 提示词模板。 */
import type { SummarySegment, TranscriptSegment } from '../types.js';
import { formatShort } from './chunk.js';

export const CHUNK_SYSTEM = `你是一名专业的视频内容分析师，擅长把带时间戳的字幕转录整理成结构化摘要。

严格要求：
1. 只输出一个 JSON 对象，不要输出任何解释、前言或 Markdown 代码块标记。
2. JSON 必须严格符合要求的结构。
3. 时间戳必须来自字幕文本中真实出现的时间标记（单位：秒），严禁编造或臆测。
4. 用与字幕内容相同的语言书写摘要。`;

export const MERGE_SYSTEM = `你是一名专业的视频内容编辑，负责把多段分段摘要整合成一份完整、连贯、有信息量的视频总结。

严格要求：
1. 只输出一个 JSON 对象，不要输出任何解释、前言或 Markdown 代码块标记。
2. JSON 必须严格符合要求的结构。
3. 保留原始分段的时间戳，不要修改时间。
4. 用与内容相同的语言书写。`;

/** 合集上下文：只在「合并生成」时传入。 */
export interface CollectionPromptContext {
  /** 合集名称 */
  title: string;
  /** 合集总集数 */
  total: number;
  /** 本次合并覆盖的集数 */
  covered: number;
}

/** 逐块摘要的提示词。 */
export function buildChunkPrompt(params: {
  title: string;
  description?: string;
  duration: number;
  chunkText: string;
  chunkIndex: number;
  chunkTotal: number;
  isFirst: boolean;
  previousTail?: string;
  /** 该时间范围内的弹幕热点，辅助模型定位名场面 */
  hotMoments?: string;
  language: string;
  /** 合集合并模式下的额外上下文 */
  collection?: CollectionPromptContext;
}): string {
  const {
    title,
    description,
    duration,
    chunkText,
    chunkIndex,
    chunkTotal,
    isFirst,
    previousTail,
    hotMoments,
    language,
    collection,
  } = params;

  const parts: string[] = [];
  parts.push(`视频标题：${title}`);
  if (collection) {
    parts.push(
      `这是合集《${collection.title}》的合并转录：合集共 ${collection.total} 集，本次合并其中 ${collection.covered} 集，` +
        '各集首尾相接，时间戳是一条连续时间轴。',
    );
    parts.push(
      '字幕中形如「—— 第 N 集：标题 ——」的行是集与集的分界。' +
        '请在每个 segment 的 title 前面标明所属集，例如「第3集 · 开场铺垫」。',
    );
  }
  if (description) {
    parts.push(`视频简介（UP 主提供的背景信息，可用于理解术语与上下文）：`);
    parts.push(description);
  }
  parts.push(`视频总时长：${formatShort(duration)}`);
  parts.push(`当前处理第 ${chunkIndex + 1}/${chunkTotal} 段字幕。`);
  if (!isFirst && previousTail) {
    parts.push(`前一段字幕的结尾内容（仅作上下文参考，不要为其生成分段）：${previousTail}`);
  }
  parts.push('');
  parts.push('本段字幕内容（格式为 [mm:ss] 文本）：');
  parts.push('```');
  parts.push(chunkText);
  parts.push('```');
  if (hotMoments) {
    parts.push('');
    parts.push('以下时间点弹幕密集，通常是名场面或高潮，请确保这些内容被重点覆盖：');
    parts.push(hotMoments);
  }
  parts.push('');
  parts.push('请输出如下 JSON 结构：');
  parts.push(
    JSON.stringify(
      {
        segments: [
          {
            start: '数字（秒）',
            end: '数字（秒）',
            title: '这一部分的标题',
            points: ['要点1', '要点2'],
            summary: '这一部分讲了什么（2-4 句）',
          },
        ],
      },
      null,
      2,
    ),
  );
  parts.push('');
  parts.push('要求：');
  parts.push('- 为本段字幕生成 1-3 个 segments，覆盖本段的全部内容。');
  parts.push('- start/end 取自字幕中出现过的时间戳，start 小于 end。');
  parts.push('- points 为该部分的 2-5 条关键要点，每条一句话。');
  parts.push('- summary 概括该部分内容，不要逐句复述。');
  parts.push(`- 全部文字使用${language === 'zh' ? '中文' : language}。`);
  parts.push('- 只输出 JSON。');

  return parts.join('\n');
}

/** 合并为最终摘要的提示词。 */
export function buildMergePrompt(params: {
  title: string;
  description?: string;
  duration: number;
  chunkSummaries: { index: number; start: number; end: number; data: SummarySegment[] }[];
  language: string;
  hasFullTranscript?: boolean;
  /** 合集合并模式下的额外上下文 */
  collection?: CollectionPromptContext;
}): string {
  const { title, description, duration, chunkSummaries, language, collection } = params;

  const rendered = chunkSummaries
    .map((chunk) => {
      const head = `### 片段 ${chunk.index + 1}（${formatShort(chunk.start)} - ${formatShort(chunk.end)}）`;
      const body = chunk.data
        .map((seg) => {
          const points = seg.points.map((p) => `  - ${p}`).join('\n');
          return `- [${formatShort(seg.start)} - ${formatShort(seg.end)}] ${seg.title}\n${points}\n  概述：${seg.summary}`;
        })
        .join('\n');
      return `${head}\n${body}`;
    })
    .join('\n\n');

  const parts: string[] = [];
  parts.push(`视频标题：${title}`);
  if (collection) {
    parts.push(
      `这是合集《${collection.title}》的合并总结：合集共 ${collection.total} 集，本次覆盖其中 ${collection.covered} 集。`,
    );
  }
  if (description) {
    parts.push(`视频简介：`);
    parts.push(description);
  }
  parts.push(`视频总时长：${formatShort(duration)}`);
  parts.push('');
  parts.push('以下是分段摘要：');
  parts.push('```');
  parts.push(rendered);
  parts.push('```');
  parts.push('');
  parts.push('请输出如下 JSON 结构：');
  parts.push(
    JSON.stringify(
      {
        tldr: '一句话总结（50-120 字）',
        keyPoints: ['全局关键要点 1', '全局关键要点 2'],
        outline: [{ start: '数字（秒）', title: '章节标题' }],
        segments: [
          {
            start: '数字（秒）',
            end: '数字（秒）',
            title: '章节标题',
            points: ['要点1'],
            summary: '这一章节的概述',
          },
        ],
        insights: ['值得注意的细节、数据或观点'],
      },
      null,
      2,
    ),
  );
  parts.push('');
  parts.push('要求：');
  if (collection) {
    parts.push(
      '- tldr 概括整个合集讲的主题脉络，而不是只讲最后一集。',
    );
    parts.push(
      '- keyPoints 要能体现跨集的共性与演进（观点怎么变化、方法怎么递进），避免只是逐集罗列。',
    );
    parts.push('- segments 的 title 前标明所属集，例如「第3集 · 现场实操」。');
    parts.push('- 时间戳沿用输入中的值，不要自行换算。');
  } else {
    parts.push('- tldr 用一两句话概括整个视频的核心内容。');
  }
  parts.push('- keyPoints 给出 5-8 条覆盖全片的关键要点，避免与 segments 重复啰嗦。');
  parts.push('- outline 是章节索引，时间递增。');
  parts.push('- segments 保留分段摘要并做适度合并与润色，时间戳必须与输入一致。');
  parts.push('- insights 列出 2-5 条特别值得注意的信息（数据、结论、争议点、建议等）。');
  parts.push(`- 全部文字使用${language === 'zh' ? '中文' : language}。`);
  parts.push('- 只输出 JSON。');

  return parts.join('\n');
}

/** 把字幕片段转成紧凑的上下文文本（用于给模型的少量原文引用）。 */
export function renderShortContext(segments: TranscriptSegment[], max = 12): string {
  return segments
    .slice(0, max)
    .map((s) => `[${formatShort(s.start)}] ${s.text}`)
    .join('\n');
}
