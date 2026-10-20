/**
 * 验证 ASR 前置链路：下载 B 站音频 -> ffmpeg 转 16kHz 单声道 wav。
 * 不调用任何转写服务。
 */
import { stat } from 'node:fs/promises';
import { BilibiliClient } from '../src/core/bilibili/client.js';
import { prepareAudio, resolveFfmpegPath } from '../src/core/asr/audio.js';

const target = process.argv[2] || 'BV1uv411q7Mv';

async function main() {
  const client = new BilibiliClient({ cookie: process.env.BILI_COOKIE || '' });
  const { bvid } = await client.resolve(target);
  const video = await client.getVideoInfo(bvid);
  console.log('视频:', video.title, '| 时长', video.duration, 's');

  const ffmpeg = await resolveFfmpegPath();
  console.log('ffmpeg:', ffmpeg ?? '(未找到)');
  if (!ffmpeg) {
    console.error('未找到 ffmpeg，ASR 不可用');
    process.exit(1);
  }

  const t0 = Date.now();
  const ws = await prepareAudio(client, bvid, video.cid, video.aid, ffmpeg);
  try {
    const raw = await stat(ws.rawPath);
    const wav = await stat(ws.wavPath);
    console.log(`音频下载: ${(raw.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`wav 转换: ${(wav.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`耗时: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    // 校验 wav 头：RIFF + WAVE
    const { readFile } = await import('node:fs/promises');
    const head = await readFile(ws.wavPath);
    const riff = head.subarray(0, 4).toString('ascii');
    const wave = head.subarray(8, 12).toString('ascii');
    console.log(`文件头: ${riff}/${wave} ${riff === 'RIFF' && wave === 'WAVE' ? '(有效 wav)' : '(异常!)'}`);
  } finally {
    await ws.cleanup();
  }
  console.log('临时文件已清理');
}

main().catch((err) => {
  console.error('失败:', err);
  process.exit(1);
});
