import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BilibiliClient } from '../src/core/bilibili/client.js';

async function main() {
  const cfg = JSON.parse(readFileSync(join(process.env.APPDATA || '', 'BiliSummary', 'config.json'), 'utf8'));
  const client = new BilibiliClient({ cookie: cfg.cookie });
  const { bvid } = await client.resolve(process.argv[2] || 'BV1vKng6rE3q');
  const video = await client.getVideoInfo(bvid);
  const c = await client.getBuiltinSummary(bvid, video.cid, video.owner.mid);
  console.log(JSON.stringify(c, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
