/**
 * 用本机真实环境跑通完整摘要流程：
 * 真实 B 站接口 + 真实 Ollama + 真实 whisper.cpp。
 *
 * 只在明确指定时才用真实模型（会消耗本地算力）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runJob } from '../src/core/pipeline/job.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { OllamaProvider } from '../src/core/providers/ollama.js';

const cfgPath = join(process.env.APPDATA || '', 'BiliSummary', 'config.json');

async function main() {
  const saved = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const config = { ...DEFAULT_CONFIG, ...saved };

  // 强制走 Ollama + whisper.cpp
  config.llmProvider = 'ollama';
  config.asrProvider = 'whisper-cpp';
  config.ollama = { ...config.ollama, model: '' }; // 留空 -> 自动挑
  if (!config.whisperCpp?.binaryPath) {
    config.whisperCpp = {
      ...config.whisperCpp,
      binaryPath: join(process.env.TEMP || '', 'whisper-test', 'Release', 'whisper-cli.exe'),
      modelPath: join(process.env.TEMP || '', 'whisper-test', 'ggml-base.bin'),
    };
  }

  const target = process.argv[2] || 'BV1nNJ96MEpA';
  const part = Number(process.argv[3] || '13');

  console.log('=== 环境自检 ===');
  const ollama = new OllamaProvider(config.ollama);
  const models = await ollama.listModels();
  console.log(`  Ollama 模型: ${models.join(', ')}`);
  const picked = await ollama.resolveModel();
  console.log(`  自动选用  : ${picked}`);

  console.log('\n=== 完整流程 ===');
  const t0 = Date.now();
  const result = await runJob({
    request: { url: target, part },
    config,
    onProgress: (p) => console.log(`  [${String(p.percent).padStart(3)}%] ${p.message}`),
  });

  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\n========== 摘要 ==========');
  console.log(result.markdown);
}

main().catch((err) => {
  console.error('失败:', err);
  process.exit(1);
});
