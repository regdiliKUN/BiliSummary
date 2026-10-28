/** 转写指定视频音频并保存带时间戳的文稿。 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BilibiliClient } from '../src/core/bilibili/client.js';
import { prepareAudio, resolveFfmpegPath } from '../src/core/asr/audio.js';
import { WhisperCppProvider } from '../src/core/asr/whisperCpp.js';
import type { AppConfig } from '../src/core/types.js';

const cfgPath = join(process.env.APPDATA || '', 'BiliSummary', 'config.json');
const target = process.argv[2] || 'BV1vKng6rE3q';
const outDir = resolve(process.argv[3] || 'output/transcript');

async function main() {
  const cfg: AppConfig = JSON.parse(await readFile(cfgPath, 'utf8'));
  const client = new BilibiliClient({ cookie: cfg.cookie });
  const { bvid } = await client.resolve(target);
  const video = await client.getVideoInfo(bvid);
  const part = video.parts[0]!;

  console.log(`视频: ${video.title}`);
  console.log(`P${part.page} cid=${part.cid} 时长=${part.duration}s`);
  console.log('下载音频...');
  const ffmpeg = await resolveFfmpegPath(cfg.whisperCpp.ffmpegPath);
  console.log('ffmpeg:', ffmpeg);
  const ws = await prepareAudio(client, bvid, part.cid, video.aid, ffmpeg);
  try {
    const asr = new WhisperCppProvider(cfg.whisperCpp);
    console.log('转写中...');
    const result = await asr.transcribe(ws.wavPath);
    await mkdir(outDir, { recursive: true });

    const jsonPath = join(outDir, `${bvid}.json`);
    const txtPath = join(outDir, `${bvid}.txt`);
    const srtPath = join(outDir, `${bvid}.srt`);
    await writeFile(jsonPath, JSON.stringify({
      video: { bvid, title: video.title, desc: video.desc, duration: video.duration, owner: video.owner },
      model: result.model,
      language: result.language,
      segments: result.segments,
    }, null, 2), 'utf8');
    await writeFile(txtPath, result.segments.map((s) => `[${fmt(s.start)}] ${s.text}`).join('\n'), 'utf8');
    await writeFile(srtPath, result.segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n'), 'utf8');

    console.log(`完成: ${result.segments.length} 段`);
    console.log(txtPath);
  } finally {
    await ws.cleanup();
  }
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function srtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

main().catch((e) => { console.error(e); process.exit(1); });
