/**
 * 诊断命令行：直接调用核心逻辑，排查 B 站接口 / 模型连接问题。
 *
 * 用法：npm run probe -- <BV号或链接>
 */
import { BilibiliClient } from '../src/core/bilibili/client.js';
import { createProvider } from '../src/core/providers/index.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const target = process.argv[2] || 'BV1uv411q7Mv';

async function main() {
  const client = new BilibiliClient({ cookie: process.env.BILI_COOKIE || '' });
  console.log('客户端就绪，hasLogin =', client.hasLogin);

  console.log('\n[1] 解析视频标识');
  const { bvid, aid } = await client.resolve(target);
  console.log('    bvid =', bvid, ' aid =', aid);

  console.log('\n[2] 视频信息');
  const video = await client.getVideoInfo(bvid);
  console.log('    标题:', video.title);
  console.log('    UP主:', video.owner.name, '| 时长:', video.duration, 's');
  console.log('    分P数:', video.parts.length);
  console.log('    播放:', video.stat.view, '| 点赞:', video.stat.like);

  console.log('\n[3] 弹幕');
  try {
    const danmaku = await client.getDanmaku(video.cid, 5);
    console.log('    取到', danmaku.length, '条，示例：');
    for (const d of danmaku.slice(0, 3)) {
      console.log(`      [${d.time.toFixed(1)}] ${d.text}`);
    }
  } catch (err) {
    console.log('    失败:', (err as Error).message);
  }

  console.log('\n[4] 官方字幕');
  try {
    const sub = await client.getSubtitles(bvid, video.cid, aid);
    if (sub) {
      console.log(`    共 ${sub.segments.length} 条，语言 ${sub.language}`);
      for (const s of sub.segments.slice(0, 3)) {
        console.log(`      [${s.start.toFixed(2)}] ${s.text}`);
      }
    } else {
      console.log('    该视频没有可用字幕（未登录时通常取不到）');
    }
  } catch (err) {
    console.log('    失败:', (err as Error).message);
  }

  console.log('\n[5] B站官方AI总结');
  try {
    const conclusion = await client.getBuiltinSummary(bvid, video.cid, video.owner.mid);
    if (conclusion) {
      console.log('    总结:', conclusion.summary.slice(0, 160));
      console.log('    章节数:', conclusion.outline.length);
      for (const o of conclusion.outline.slice(0, 3)) {
        console.log(`      [${o.start}-${o.end}] ${o.title}`);
      }
    } else {
      console.log('    该视频没有官方 AI 总结');
    }
  } catch (err) {
    console.log('    失败:', (err as Error).message);
  }

  console.log('\n[6] 音频直链');
  try {
    const url = await client.getAudioUrl(bvid, video.cid, aid);
    console.log('    ', url.slice(0, 110) + '...');
  } catch (err) {
    console.log('    失败:', (err as Error).message);
  }

  console.log('\n[7] 模型连通性（仅检查，不消耗额度）');
  const provider = createProvider('bilibili', DEFAULT_CONFIG, client);
  const health = await provider.healthCheck();
  console.log(`    [${health.ok ? 'OK' : 'FAIL'}] ${health.message}`);
}

main().catch((err) => {
  console.error('\n诊断失败:', err);
  process.exit(1);
});
