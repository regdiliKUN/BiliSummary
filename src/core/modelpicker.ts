/**
 * 从本机已安装的模型里挑一个适合做摘要的。
 *
 * 需要排除嵌入模型（all-minilm / bge-* 等，它们不能聊天），
 * 并在体积与中文能力之间取平衡。
 */

/** 判断是否为嵌入/检索类模型（不能用来做对话摘要）。 */
export function isEmbeddingModel(name: string): boolean {
  return /embed|bge-|minilm|nomic-embed|e5-|gte-|jina-embed|paraphrase/i.test(name);
}

/** 解析模型体积（十亿参数），解析不出来返回 undefined。 */
export function parseModelSize(name: string): number | undefined {
  // 取最后一段标签，形如 "qwen3:8b" / "qwen3.8b:27b" / "llama3.1:8b"
  const tag = name.includes(':') ? name.split(':').pop()! : name;
  const m = tag.match(/(\d+(?:\.\d+)?)\s*b/i);
  if (!m) return undefined;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** 中文/通用能力优先级（越大越优先）。 */
function familyScore(name: string): number {
  const n = name.toLowerCase();
  if (n.includes('qwen')) return 100; // 中文表现最好
  if (n.includes('glm')) return 90;
  if (n.includes('deepseek')) return 85;
  if (n.includes('yi') || n.includes('internlm')) return 70;
  if (n.includes('llama')) return 60;
  if (n.includes('mistral') || n.includes('mixtral')) return 55;
  if (n.includes('gemma')) return 50;
  if (n.includes('phi')) return 30;
  return 40;
}

/**
 * 选出最适合做摘要的模型。
 *
 * 策略：先排除嵌入模型；同等家族下优先 3B~14B（速度与效果平衡）；
 * 没有明确偏好时取分数最高者。
 */
export function pickOllamaModel(models: string[]): string | undefined {
  const candidates = models.filter((m) => m && !isEmbeddingModel(m));
  if (!candidates.length) return undefined;

  let best: string | undefined;
  let bestScore = -Infinity;

  for (const name of candidates) {
    const size = parseModelSize(name);
    const family = familyScore(name);

    // 体积打分：3B~14B 最理想
    let sizeScore = 0;
    if (size !== undefined) {
      if (size >= 2 && size <= 14) sizeScore = 40;
      else if (size > 14 && size <= 32) sizeScore = 25;
      else if (size > 0.5 && size < 2) sizeScore = 20;
      else if (size > 32) sizeScore = 10;
      else sizeScore = 5; // 太小
    } else {
      sizeScore = 20;
    }

    // 同名不同版本时，偏好较新的大版本
    const versionBonus = /:latest$/i.test(name) ? 1 : 0;

    const score = family + sizeScore + versionBonus;
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }

  return best;
}
