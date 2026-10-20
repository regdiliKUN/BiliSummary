import { describe, expect, it } from 'vitest';
import {
  isEmbeddingModel,
  parseModelSize,
  pickOllamaModel,
} from '../src/core/modelpicker.js';

describe('嵌入模型识别', () => {
  it('识别常见的嵌入模型', () => {
    expect(isEmbeddingModel('all-minilm:latest')).toBe(true);
    expect(isEmbeddingModel('bge-m3:latest')).toBe(true);
    expect(isEmbeddingModel('nomic-embed-text')).toBe(true);
  });

  it('不误判对话模型', () => {
    expect(isEmbeddingModel('qwen3:8b')).toBe(false);
    expect(isEmbeddingModel('qwen3.8b:27b')).toBe(false);
    expect(isEmbeddingModel('llama3.1:8b')).toBe(false);
  });
});

describe('模型体积解析', () => {
  it('解析冒号后的体积标签', () => {
    expect(parseModelSize('qwen3:8b')).toBe(8);
    expect(parseModelSize('qwen3.8b:27b')).toBe(27);
    expect(parseModelSize('llama3.1:70b')).toBe(70);
    expect(parseModelSize('qwen2.5:0.5b')).toBe(0.5);
  });

  it('没有标签时尝试整体', () => {
    expect(parseModelSize('gemma3-4b')).toBe(4);
  });

  it('解析不出来返回 undefined', () => {
    expect(parseModelSize('some-model')).toBeUndefined();
  });
});

describe('模型挑选', () => {
  it('排除嵌入模型', () => {
    const picked = pickOllamaModel(['all-minilm:latest', 'bge-m3:latest', 'qwen3:8b']);
    expect(picked).toBe('qwen3:8b');
  });

  it('全是嵌入模型时返回 undefined', () => {
    expect(pickOllamaModel(['all-minilm:latest', 'bge-m3:latest'])).toBeUndefined();
  });

  it('空列表返回 undefined', () => {
    expect(pickOllamaModel([])).toBeUndefined();
  });

  it('在 8B 与 27B 之间选更快的 8B', () => {
    expect(pickOllamaModel(['qwen3:8b', 'qwen3.8b:27b'])).toBe('qwen3:8b');
  });

  it('优先选 qwen（中文表现更好）', () => {
    expect(pickOllamaModel(['llama3.1:8b', 'qwen3:8b'])).toBe('qwen3:8b');
  });

  it('只有超大模型时也能选一个', () => {
    expect(pickOllamaModel(['qwen3.8b:27b'])).toBe('qwen3.8b:27b');
  });

  it('过小的模型排在合适体积之后', () => {
    expect(pickOllamaModel(['qwen2.5:0.5b', 'qwen3:8b'])).toBe('qwen3:8b');
  });
});
