/**
 * 端到端演练：用真实的 B 站接口 + 假模型跑完整流程，输出 Markdown。
 *
 * 用途：验证「取信息 → 取字幕 → 分块 → 摘要 → 渲染」这条链路是否打通，
 * 不消耗任何模型额度。
 *
 * 用法：npm run e2e -- <BV号>
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runJob } from '../src/core/pipeline/job.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { ChatRequest, ChatResponse, LlmProvider, Transcript } from '../src/core/types.js';

const args = process.argv.slice(2);
const useSynthetic = args.includes('--synthetic');
const target = args.find((a) => !a.startsWith('--')) || 'BV1uv411q7Mv';
/** 假模型：按提示词类型返回结构化 JSON。 */
const stubProvider: LlmProvider = {
  kind: 'openai',
  name: 'stub-model',
  bind() {},
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const prompt = req.messages[1]?.content ?? '';
    if (prompt.includes('全局关键要点')) {
      return {
        content: JSON.stringify({
          tldr: '【演练模式】这是由假模型生成的一句话总结，用于验证整条链路。',
          keyPoints: ['链路验证要点一', '链路验证要点二'],
          outline: [{ start: 0, title: '演练章节' }],
          segments: [
            { start: 0, end: 100, title: '演练章节', points: ['细节一'], summary: '演练概述' },
          ],
          insights: ['这是一个演练洞察'],
        }),
      };
    }
    return {
      content: JSON.stringify({
        segments: [
          {
            start: 0,
            end: 100,
            title: '演练分段',
            points: ['演练要点'],
            summary: '这是演练用的分段摘要。',
          },
        ],
      }),
    };
  },
  async healthCheck() {
    return { ok: true, message: 'stub' };
  },
};

async function main() {
  const config = { ...DEFAULT_CONFIG, cookie: process.env.BILI_COOKIE || '' };

  // 没有登录 / 视频没字幕时，用一份合成字幕验证后续链路

  const run = (transcript?: Transcript) =>
    runJob({
      request: { url: target },
      config,
      provider: stubProvider,
      transcript,
      onProgress: (p) => console.log(`  [${String(p.percent).padStart(3)}%] ${p.message}`),
    });

  let result;
  try {
    result = await run();
  } catch (err) {
    if (!useSynthetic) throw err;
    console.log(`\n真实字幕不可用（${(err as Error).message}），改用合成字幕继续验证链路。\n`);
    result = await run(makeSyntheticTranscript());
  }

  console.log('\n========== 结果 ==========');
  console.log('视频:', result.video.title);
  console.log('字幕来源:', result.transcript.source);
  console.log('字幕条数:', result.transcript.segments.length);
  console.log('弹幕条数:', result.danmaku.length);
  console.log('摘要分段:', result.summary.segments.length);
  console.log('要点数:', result.summary.keyPoints.length);

  const outPath = join(process.cwd(), 'dist', 'e2e-sample.md');
  writeFileSync(outPath, result.markdown, 'utf8');
  console.log('\nMarkdown 已写入:', outPath);
  console.log('---- 前 40 行 ----');
  console.log(result.markdown.split('\n').slice(0, 40).join('\n'));
}

/** 造一份带时间戳的合成字幕。 */
function makeSyntheticTranscript(): Transcript {
  const lines = [
    '大家好，今天我们来聊聊这个话题的背景。',
    '首先需要说明的是，这件事情其实由来已久。',
    '接下来我会从三个角度来分析它的影响。',
    '第一个角度是成本，第二个角度是效率，第三个角度是风险。',
    '成本方面，前期投入比较大，但长期来看是划算的。',
    '效率方面，工具链的成熟让整个流程缩短了一半时间。',
    '风险方面，需要注意合规问题以及数据安全。',
    '总的来说，这个方案值得尝试，但也要量力而行。',
    '以上就是本期的全部内容，我们下期再见。',
  ];
  const segments = lines.map((text, i) => ({
    start: i * 12,
    end: i * 12 + 10,
    text,
  }));
  return { source: 'subtitle', language: 'zh-CN', segments };
}

main().catch((err) => {
  console.error('\n演练失败:', err);
  process.exit(1);
});
