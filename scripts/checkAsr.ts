/**
 * 端到端验证 ASR 链路：下载音频 -> ffmpeg 转 wav -> whisper.cpp 转写。
 * 用已保存的登录态，不消耗任何云端额度。
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { BilibiliClient } from '../src/core/bilibili/client.js';
import { prepareAudio, resolveFfmpegPath } from '../src/core/asr/audio.js';
import { WhisperCppProvider } from '../src/core/asr/whisperCpp.js';

const cfgPath = join(process.env.APPDATA || '', 'BiliSummary', 'config.json');
const WHISPER_DIR = join(process.env.TEMP || '', 'whisper-test');

async function main() {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const client = new BilibiliClient({ cookie: cfg.cookie });

  const bvid = process.argv[2] || 'BV1nNJ96MEpA';
  const page = Number(process.argv[3] || '13');
  const { bvid: bv } = await client.resolve(bvid);
  const video = await client.getVideoInfo(bv);
  const part = video.parts.find((p) => p.page === page) || video.parts[0];
  console.log(`视频: ${video.title}`);
  console.log(`分P: P${part.page} ${part.title} (${part.duration}s)`);

  console.log('\n[1] 下载音频 + 转码');
  const ffmpeg = await resolveFfmpegPath();
  const t0 = Date.now();
  const ws = await prepareAudio(client, bv, part.cid, video.aid, ffmpeg);
  console.log(`    完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`    wav: ${ws.wavPath}`);

  try {
    console.log('\n[2] whisper.cpp 转写');
    const provider = new WhisperCppProvider({
      binaryPath: join(WHISPER_DIR, 'Release', 'whisper-cli.exe'),
      modelPath: join(WHISPER_DIR, 'ggml-base.bin'),
      language: 'zh',
      ffmpegPath: '',
    });

    const t1 = Date.now();
    const result = await provider.transcribe(ws.wavPath);
    const secs = (Date.now() - t1) / 1000;

    console.log(`    完成，耗时 ${secs.toFixed(1)}s，共 ${result.segments.length} 段`);
    console.log(`    音频 ${part.duration}s，转写用时 ${secs.toFixed(1)}s (${(part.duration / secs).toFixed(1)}x 实时)`);
    console.log('\n    前 12 段:');
    for (const s of result.segments.slice(0, 12)) {
      console.log(`      [${s.start.toFixed(1)}] ${s.text}`);
    }
  } finally {
    await ws.cleanup();
  }
}

main().catch((err) => {
  console.error('ASR 验证失败:', err);
  process.exit(1);
});
