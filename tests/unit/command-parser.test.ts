/**
 * parseCommand 单元测试 —— 解析器的边界穷举。
 *
 * 解析器是纯函数（字符串进、结构出），是命令层最值得测密的组件：
 * 它的每个边界错误都会在 REPL 里表现为「命令没反应」这类难查的体验问题。
 */

import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/commands/parser.ts';

describe('parseCommand：非命令输入', () => {
  it('普通文本不是命令', () => {
    expect(parseCommand('你好，帮我算一下 1+1')).toBeUndefined();
  });

  it('空字符串与纯空白不是命令', () => {
    expect(parseCommand('')).toBeUndefined();
    expect(parseCommand('   ')).toBeUndefined();
  });

  it('默认前缀下，其他前缀字符不是命令', () => {
    expect(parseCommand('!status')).toBeUndefined();
    expect(parseCommand('# help')).toBeUndefined();
  });
});

describe('parseCommand：命令形态', () => {
  it('无参命令', () => {
    expect(parseCommand('/status')).toEqual({ name: 'status', args: [], rawArgs: '' });
  });

  it('带参命令按空白切分', () => {
    expect(parseCommand('/history 3')).toEqual({
      name: 'history',
      args: ['3'],
      rawArgs: '3',
    });
  });

  it('多余空白折叠、尾部裁剪（rawArgs 保留内部空白）', () => {
    const parsed = parseCommand('/skill  math-report  21 * 2   ');
    expect(parsed).toEqual({
      name: 'skill',
      args: ['math-report', '21', '*', '2'],
      rawArgs: 'math-report  21 * 2',
    });
  });

  it('全角空格（中文输入法）也作为分隔符', () => {
    expect(parseCommand('/skill math-report\u300021')).toEqual({
      name: 'skill',
      args: ['math-report', '21'],
      // rawArgs 保留内部原样（全角空格仍是全角）——只有两端被 trim
      rawArgs: 'math-report\u300021',
    });
  });

  it('命令名归一为小写（大小写不敏感）', () => {
    expect(parseCommand('/STATUS')?.name).toBe('status');
    expect(parseCommand('/Help')?.name).toBe('help');
  });

  it('容忍前导空白', () => {
    expect(parseCommand('   /help')?.name).toBe('help');
  });

  it('单独斜杠解析为空名命令（交由 router 做未知命令提示）', () => {
    expect(parseCommand('/')).toEqual({ name: '', args: [], rawArgs: '' });
  });

  it('斜杠后紧跟空白时名称为空', () => {
    expect(parseCommand('/ status')?.name).toBe('');
  });
});

describe('parseCommand：自定义前缀', () => {
  it('传入前缀时按该前缀解析', () => {
    expect(parseCommand('!status', '!')?.name).toBe('status');
  });

  it('传入前缀后，默认斜杠不再被识别', () => {
    expect(parseCommand('/status', '!')).toBeUndefined();
  });
});
