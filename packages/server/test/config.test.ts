import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.ts';

describe('vault/config.json 读不懂时不崩', () => {
  it('坏 JSON 退回默认值', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseConfig('{ 这不是 json')).toEqual({ cfHandle: '', atHandle: '', port: 7788, xcpcPlayerKey: '' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('字段类型不对也退回，并给出提示', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseConfig('{"port":"七七八八"}')).toEqual({ cfHandle: '', atHandle: '', port: 7788, xcpcPlayerKey: '' });
    spy.mockRestore();
  });

  it('缺字段补默认、多余字段忽略', () => {
    expect(parseConfig('{"cfHandle":"jywlq"}')).toEqual({ cfHandle: 'jywlq', atHandle: '', port: 7788, xcpcPlayerKey: '' });
    expect(parseConfig('{"cfHandle":"a","port":7788,"whatever":1}').port).toBe(7788);
  });

  it('切片 2 新增的 atHandle：缺省补空串，带了就原样读', () => {
    expect(parseConfig('{"cfHandle":"a","atHandle":"chokudai"}')).toEqual({
      cfHandle: 'a',
      atHandle: 'chokudai',
      port: 7788,
      xcpcPlayerKey: '',
    });
    // 老配置文件没有 atHandle 这一行，也必须能读
    expect(parseConfig('{"cfHandle":"a","port":7788}').atHandle).toBe('');
  });

  it('切片 3 新增的 xcpcPlayerKey：老配置缺这一行照样读，带了就原样读', () => {
    expect(parseConfig('{"cfHandle":"a"}').xcpcPlayerKey).toBe('');
    expect(parseConfig('{"xcpcPlayerKey":"李鑫杰@佛山大学"}').xcpcPlayerKey).toBe('李鑫杰@佛山大学');
  });
});
