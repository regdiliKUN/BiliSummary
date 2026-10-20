/** 文本处理工具。 */

/** 估算 token 数（中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token 的粗略启发式）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 3.5);
}

/** 估算字符权重，中文权重更高，用于分块预算控制。 */
export function textWeight(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk * 2 + (text.length - cjk);
}

/** 去除空白字符并压缩。 */
export function normalizeText(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * 清洗字幕文本。
 *
 * - 去掉首尾空白
 * - 去掉说话人标签：`[张三]`、`【张三】`、`(张三)`
 * - 去掉行首/行尾的行内标记（破折号、箭头、引号）
 *
 * 纯音效标注（如 `[音乐]`）会被整体去掉，随后由调用方丢弃该条字幕。
 */
export function cleanSubtitleText(text: string): string {
  let t = (text || '').trim();
  // 说话人标签
  t = t.replace(/^[[【(（]\s*[^\]】)）]{1,12}\s*[\]】)）]\s*[:：]?\s*/, '');
  // 行首/行尾标记
  t = t.replace(/^[\s\-–—>»「『]+/, '');
  t = t.replace(/[\s\-–—<«」』]+$/, '');
  return t.trim();
}

/** 从模型输出中提取第一个 JSON 对象/数组（容忍 ```json 包裹与前后废话）。 */
export function extractJson(raw: string): unknown {
  if (!raw) throw new Error('空的模型输出');
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = (fence[1] ?? '').trim();

  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试 */
  }

  const start = text.search(/[[{]/);
  if (start === -1) throw new Error('模型输出中未找到 JSON');

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error('JSON 括号不匹配');
}

/** 安全地把任意值转成字符串列表。 */
export function toStringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v) : String(v)))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\n+/)
      .map((s) => s.replace(/^[-*•\d.、\s]+/, '').trim())
      .filter(Boolean);
  }
  return [];
}

/** 截断到指定长度并追加省略号。 */
export function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** 把长文本按句子边界切分，避免在句子中间截断。 */
export function splitSentences(text: string): string[] {
  return (text || '')
    .split(/(?<=[。！？!?；;\n])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}
