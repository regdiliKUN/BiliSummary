/**
 * 用应用真实的安装器装好 whisper.cpp，并写好配置。
 * 装完应用里就能直接用，不���再手动填路径。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installWhisper } from '../src/core/asr/whisperInstall.js';

const appData = process.env.APPDATA || '';
const cfgPath = join(appData, 'BiliSummary', 'config.json');
const installDir = join(appData, 'BiliSummary', 'asr');
const model = (process.argv[2] || 'small') as 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo';

async function main() {
  console.log(`安装目录: ${installDir}`);
  console.log(`模型    : ${model}\n`);

  const result = await installWhisper({
    installDir,
    model,
    onProgress: (p) => {
      process.stdout.write(`\r  [${String(p.percent).padStart(3)}%] ${p.message.padEnd(70)}`);
    },
  });
  console.log('\n');

  if (!result.ok) {
    console.error('安装失败:', result.message);
    process.exit(1);
  }
  console.log('安装成功');
  console.log('  可执行文件:', result.binaryPath);
  console.log('  模型文件  :', result.modelPath);

  // 写回配置
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.llmProvider = 'ollama';
  cfg.ollama = {
    ...cfg.ollama,
    baseUrl: cfg.ollama?.baseUrl || 'http://127.0.0.1:11434',
    model: '', // 留空 -> 自动挑选
    disableThinking: true,
  };
  cfg.asrProvider = 'whisper-cpp';
  cfg.whisperCpp = {
    ...cfg.whisperCpp,
    binaryPath: result.binaryPath,
    modelPath: result.modelPath,
    language: 'zh',
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  console.log('\n配置已更新:');
  console.log('  摘要模型 = ollama（自动选本机模型）');
  console.log('  语音识别 = whisper-cpp（本地）');
}

main().catch((err) => {
  console.error('失败:', err);
  process.exit(1);
});
