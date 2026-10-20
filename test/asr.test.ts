import { describe, expect, it } from 'vitest';
import { fixAsarPath, resolveFfmpegPath } from '../src/core/asr/audio.js';
import { parseWhisperJson } from '../src/core/asr/whisperCpp.js';
import { existsSync } from 'node:fs';

describe('asar 路径修正', () => {
  it('把 app.asar 换成 app.asar.unpacked', () => {
    expect(
      fixAsarPath('C:\\app\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe'),
    ).toBe('C:\\app\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe');
  });

  it('支持正斜杠', () => {
    expect(fixAsarPath('/opt/app/app.asar/node_modules/x/y')).toBe(
      '/opt/app/app.asar.unpacked/node_modules/x/y',
    );
  });

  it('非 asar 路径保持不变', () => {
    const p = 'C:\\tools\\ffmpeg.exe';
    expect(fixAsarPath(p)).toBe(p);
  });
});

describe('ffmpeg 查找', () => {
  it('能解析出一个可用的 ffmpeg', async () => {
    const p = await resolveFfmpegPath();
    // 环境里可能没有 ffmpeg，有则必须真实存在
    if (p) {
      expect(existsSync(p)).toBe(true);
    } else {
      expect(p).toBeNull();
    }
  });

  it('显式指定的有效路径会被优先采用', async () => {
    const p = await resolveFfmpegPath(process.execPath);
    expect(p).toBe(process.execPath);
  });

  it('无效的指定路径会被跳过', async () => {
    const p = await resolveFfmpegPath('Z:\\definitely\\not\\here\\ffmpeg.exe');
    expect(p).not.toBe('Z:\\definitely\\not\\here\\ffmpeg.exe');
  });
});

describe('whisper.cpp 输出解析', () => {
  it('解析 offsets 格式', () => {
    const segs = parseWhisperJson({
      transcription: [
        { offsets: { from: 0, to: 2500 }, text: ' 第一句 ' },
        { offsets: { from: 2500, to: 5000 }, text: '第二句' },
      ],
    });
    expect(segs).toHaveLength(2);
    expect(segs[0]!.start).toBe(0);
    expect(segs[0]!.end).toBe(2.5);
    expect(segs[0]!.text).toBe('第一句');
    expect(segs[1]!.start).toBe(2.5);
  });

  it('解析 timestamps 字符串格式', () => {
    const segs = parseWhisperJson({
      transcription: [{ timestamps: { from: '00:00:01,000', to: '00:00:03,500' }, text: 'x' }],
    });
    expect(segs[0]!.start).toBe(1);
    expect(segs[0]!.end).toBe(3.5);
  });

  it('忽略空文本条目', () => {
    const segs = parseWhisperJson({
      transcription: [{ offsets: { from: 0, to: 100 }, text: '   ' }],
    });
    expect(segs).toHaveLength(0);
  });

  it('对空输入返回空数组', () => {
    expect(parseWhisperJson({})).toEqual([]);
    expect(parseWhisperJson(null)).toEqual([]);
  });
});
