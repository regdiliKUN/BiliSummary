/** 临时诊断：抓取指定视频的元信息、字幕与官方总结。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BilibiliClient } from '../src/core/bilibili/client.js';

const cfgPath = join(process.env.APPDATA || '', 'BiliSummary', 'config.json');
const target = process.argv[2] || 'BV1vKng6rE3q';

async function main() {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const client = new BilibiliClient({ cookie: cfg.cookie });

  console.log('=== 登录 ===');
  console.log(await client.checkLogin());

  const { bvid } = await client.resolve(target);
  const video = await client.getVideoInfo(bvid);
  console.log('\n=== 视频 ===');
  console.log(JSON.stringify({
    bvid: video.bvid,
    aid: video.aid,
    title: video.title,
    desc: video.desc,
    duration: video.duration,
    owner: video.owner,
    parts: video.parts,
  }, null, 2));

  for (const part of video.parts.slice(0, 10)) {
    console.log(`\n=== P${part.page} cid=${part.cid} ${part.title} (${part.duration}s) ===`);
    try {
      const sub = await client.getSubtitles(bvid, part.cid, video.aid);
      if (sub?.segments.length) {
        console.log(`字幕: ${sub.segments.length} 条 / ${sub.language ?? '?'} / ${sub.source}`);
        console.log(sub.segments.slice(0, 5).map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n'));
      } else {
        console.log('字幕: 无');
      }
    } catch (e) {
      console.log('字幕失败:', (e as Error).message);
    }
    try {
      const c = await client.getBuiltinSummary(bvid, part.cid, video.owner.mid);
      console.log(c ? `官方总结: ${c.outline.length} 章 / ${c.summary.slice(0, 100)}` : '官方总结: 无');
    } catch (e) {
      console.log('官方总结失败:', (e as Error).message);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
