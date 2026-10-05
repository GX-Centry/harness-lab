/**
 * 命令解析器 —— 纯函数，把用户输入判定为「斜杠命令」或「普通对话」。
 *
 * 拦截发生的位置：REPL 拿到用户输入后、进入 SessionManager.runQuery **之前**
 * （router.ts 消费本模块）。解析器自身零依赖、零副作用——输入字符串出，
 * 结构化结果入，测试可以穷举边界。
 *
 * 语法（刻意保持极小）：
 *   /name            无参命令
 *   /name arg1 arg2  参数按**连续空白**切分（多余空白被折叠）
 *
 * 有意不做的（教学点——「不做」也是设计决定）：
 *   - 引号/转义（`/cmd "a b"`）：这是 REPL 不是 shell。真需要带空格的参数时，
 *     应引入成熟的 tokenizer 或改用键值语法——而不是手写半个 shell 解析器
 *     （半个 shell 才是 bug 温床）。v1 参数都是短标识符（数字、技能名），
 *     空白切分完全够用。
 *   - 命令别名：注册表对「同名多实现」说不；别名需求出现时在注册表加
 *     alias 映射（而不是在解析层做字符串替换）。
 */

/** 解析结果：确认这是一条斜杠命令 */
export interface ParsedCommand {
  /**
   * 命令名（**已归一为小写**——查询注册表时大小写不敏感，用户友好）。
   * 注意：`/` 单独一个字符时 name 为空串——这不是解析错误，
   * 而是「未知命令 ''」由 router 统一处理（保持解析器不做校验）。
   */
  readonly name: string;
  /** 按连续空白切分后的参数列表（无参数时为空数组） */
  readonly args: readonly string[];
  /** 原始参数文本（trim 后，保留内部空白原样）——需要「原样传递」的命令用 */
  readonly rawArgs: string;
}

/** 空白序列（含全角空格——中文输入法常见的坑） */
const WHITESPACE = /[\s\u3000]+/;

/**
 * 解析用户输入。
 *
 * @param input  用户原始输入（可含前后空白——本函数容忍前导空白）
 * @param prefix 命令前缀（默认 '/'；装配时可通过 router 传入其他前缀）
 * @returns 确认是命令 → ParsedCommand；否则 undefined（调用方继续走 LLM）
 */
export function parseCommand(input: string, prefix = '/'): ParsedCommand | undefined {
  const trimmed = input.trimStart();
  if (trimmed === '') return undefined;
  if (!trimmed.startsWith(prefix)) return undefined;

  // 去掉前缀后的主体（不 trimEnd——rawArgs 的尾部空白意义不大，但保留原样最诚实）
  const body = trimmed.slice(prefix.length);

  // name 与 rawArgs 的分界：第一个空白。`/status` / `/history 3` / `/`（空名）
  const match = /^([^\s\u3000]*)[\s\u3000]*([\s\S]*)$/.exec(body);
  // 正则第一组允许空串，exec 必然成功（`^...$` 匹配任意字符串）——但 TS 类型不知道
  if (match === null) return undefined;
  const name = (match[1] ?? '').toLowerCase();
  const rawArgs = (match[2] ?? '').trim();

  const args =
    rawArgs === '' ? [] : rawArgs.split(WHITESPACE).filter((part) => part !== '');

  return { name, args, rawArgs };
}
