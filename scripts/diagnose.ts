/**
 * 诊断：读取本机已保存的登录态，实测各条摘要路径是否可用。
 * 只输出结论，不输出 cookie 内容。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BilibiliClient } from '../src/core/bilibili/client.js';

const cfgPath = join(process.env.APPDATA || '', 'BiliSummary', 'config.json');

async function main() {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const client = new BilibiliClient({ cookie: cfg.cookie });

  console.log('=== 登录态 ===');
  const login = await client.checkLogin();
  console.log(`  ok=${login.ok}  ${login.message}`);

  const target = process.argv[2] || 'BV1nNJ96MEpA';
  const { bvid } = await client.resolve(target);
  const video = await client.getVideoInfo(bvid);
  console.log(`\n=== 视频 ${bvid} ===`);
  console.log(`  ${video.title}`);
  console.log(`  分P数: ${video.parts.length}`);

  // 逐个分P 测试
  const partArg = Number(process.argv[3] || '13');
  const part = video.parts.find((p) => p.page === partArg) || video.parts[0];
  console.log(`  测试 P${part.page} (cid=${part.cid}) ${part.title}`);

  console.log('\n=== 路径 1: 官方字幕 ===');
  try {
    const sub = await client.getSubtitles(bvid, part.cid, video.aid);
    if (sub?.segments.length) {
      console.log(`  ✓ 有字幕 ${sub.segments.length} 条 (${sub.language})`);
      console.log(`    例: [${sub.segments[0]!.start.toFixed(1)}] ${sub.segments[0]!.text}`);
    } else {
      console.log('  ✗ 该分P没有字幕');
    }
  } catch (err) {
    console.log(`  ✗ 失败: ${(err as Error).message}`);
  }

  console.log('\n=== 路径 2: B站官方AI总结 ===');
  try {
    const c = await client.getBuiltinSummary(bvid, part.cid, video.owner.mid);
    if (c) {
      console.log(`  ✓ 有官方总结, ${c.outline.length} 个章节`);
      console.log(`    ${c.summary.slice(0, 120)}`);
      for (const o of c.outline.slice(0, 3)) {
        console.log(`      [${o.start}-${o.end}] ${o.title}`);
      }
    } else {
      console.log('  ✗ 该分P没有官方AI总结');
    }
  } catch (err) {
    console.log(`  ✗ 失败: ${(err as Error).message}`);
  }

  console.log('\n=== 路径 3: 整片其它分P 的官方总结命中率 ===');
  let hit = 0;
  const sample = video.parts.slice(0, 5);
  for (const p of sample) {
    try {
      const c = await client.getBuiltinSummary(bvid, p.cid, video.owner.mid);
      const ok = !!c;
      if (ok) hit++;
      console.log(`  P${p.page}: ${ok ? '有' : '无'}`);
    } catch (err) {
      console.log(`  P${p.page}: 失败 - ${(err as Error).message}`);
    }
  }
  console.log(`  命中率: ${hit}/${sample.length}`);

  console.log('\n=== 路径 4: 音频直链（ASR 前置）===');
  try {
    const urls = await client.getAudioUrls(bvid, part.cid, video.aid);
    console.log(`  拿到 ${urls.length} 个候选地址`);
    try {
      const buf = await client.downloadBinary(urls[0]!, `https://www.bilibili.com/video/${bvid}/`);
      console.log(`  ✓ 下载成功 ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
      console.log(`  ✗ 下载失败: ${(err as Error).message}`);
    }
  } catch (err) {
    console.log(`  ✗ 失败: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error('诊断异常:', err);
  process.exit(1);
});
