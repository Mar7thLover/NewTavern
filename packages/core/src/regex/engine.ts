/**
 * ST 正则脚本引擎（M3）。行为对齐 SillyTavern 1.18：
 * - `public/scripts/extensions/regex/engine.js`：`getRegexedString` / `runRegexScript` /
 *   `filterString` / `sanitizeRegexMacro`
 * - `public/scripts/utils.js`：`regexFromString` / `escapeRegex`
 *
 * 与 ST 的行为差异集中在 `direction`（见 `directionAllows`），其余逐行照搬。
 * 纯 TS，不依赖 DOM / Node。
 */

/** 脚本作用位置，与 ST `regex_placement` 一致（0 MD_DISPLAY 已废弃、4 sendAs 已移除） */
export const REGEX_PLACEMENT = {
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
} as const;

/** find 正则里的宏替换方式，与 ST `substitute_find_regex` 一致 */
export const SUBSTITUTE_FIND_REGEX = {
  NONE: 0,
  RAW: 1,
  ESCAPED: 2,
} as const;

export interface RegexScript {
  id: string;
  name: string;
  /** `/pattern/flags` 或裸 pattern（ST `regexFromString` 语义） */
  findRegex: string;
  /** 支持 `{{match}}`、`$1`…`$n`、`$<name>`、宏 */
  replaceString: string;
  trimStrings: string[];
  /** 1 USER_INPUT, 2 AI_OUTPUT, 3 SLASH_COMMAND, 5 WORLD_INFO, 6 REASONING */
  placement: number[];
  disabled: boolean;
  /** 仅显示侧 */
  markdownOnly: boolean;
  /** 仅提示词侧 */
  promptOnly: boolean;
  runOnEdit: boolean;
  /** 0 NONE / 1 RAW / 2 ESCAPED */
  substituteRegex: 0 | 1 | 2;
  minDepth?: number | null;
  maxDepth?: number | null;
  /**
   * 脚本来源：`global` 是用户自己的，其余三种是角色卡 / 预设 / 世界书自带的
   * （导入时抽进正则库，见 M3 契约 §3.2 修正）。引擎本身不按 scope 做任何区分，
   * 它只影响列表里的分组与启用开关。
   */
  scope: 'global' | 'character' | 'preset' | 'book';
}

export interface RegexRunContext {
  /** 当前文本的位置类别，见 REGEX_PLACEMENT */
  placement: number;
  /**
   * `'prompt'` = 组装侧（ST isPrompt）、`'display'` = 渲染侧（ST isMarkdown）、
   * `'stored'` = 收发消息时改写存档（ST 两个开关都为 false 的那一路）。
   */
  direction: 'prompt' | 'display' | 'stored';
  /** 历史消息深度（0 = 最新）；不给则跳过 min/maxDepth 过滤 */
  depth?: number;
  isEdit?: boolean;
  /**
   * 宏替换。`postProcess` 对应 ST `substituteParamsExtended` 的第三参数：
   * 只作用于**每个宏的展开结果**（ESCAPED 模式靠它转义，而不是转义整条正则）。
   */
  substitute: (text: string, postProcess?: (value: string) => string) => string;
  /** 正则无效 / 执行抛错时的回调；不给则静默跳过 */
  onError?: (script: RegexScript, error: unknown) => void;
}

/** ST `escapeRegex`：转义正则元字符 */
export function escapeRegex(input: string): string {
  return input.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * ST `sanitizeRegexMacro`：ESCAPED 模式下对宏结果做的转义
 * （控制字符转成转义序列，正则元字符前加反斜杠）。
 */
export function sanitizeRegexMacro(input: string): string {
  if (!input || typeof input !== 'string') return input;
  return input.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
    switch (s) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\v':
        return '\\v';
      case '\f':
        return '\\f';
      case '\0':
        return '\\0';
      default:
        return '\\' + s;
    }
  });
}

/**
 * ST `regexFromString`：把 `/pattern/flags` 或裸 pattern 变成 RegExp。
 * 无效输入返回 null（**不抛**）。
 */
export function regexFromString(input: string): RegExp | null {
  try {
    const m = /(\/?)(.+)\1([a-z]*)/i.exec(input);
    // ST 这里会在 m 为 null 时抛 TypeError 并被 catch 掉，等价于返回空
    if (!m) return null;

    const flags = m[3] ?? '';
    // 非法 / 重复的 flag：ST 退回把整个输入当 pattern
    if (flags && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(flags)) {
      return new RegExp(input);
    }

    return new RegExp(m[2] ?? '', flags);
  } catch {
    return null;
  }
}

/** ST `filterString`：从捕获组里删掉 trimStrings（每条先过宏替换） */
function filterString(raw: string, trimStrings: readonly string[], ctx: RegexRunContext): string {
  let out = raw;
  for (const trimString of trimStrings) {
    const subTrimString = ctx.substitute(trimString);
    if (!subTrimString) continue;
    out = out.replaceAll(subTrimString, '');
  }
  return out;
}

/** find 正则的最终字符串：NONE 原样、RAW 过宏、ESCAPED 过宏且转义宏结果 */
function resolveFindRegex(script: RegexScript, ctx: RegexRunContext): string {
  switch (Number(script.substituteRegex)) {
    case SUBSTITUTE_FIND_REGEX.NONE:
      return script.findRegex;
    case SUBSTITUTE_FIND_REGEX.RAW:
      return ctx.substitute(script.findRegex);
    case SUBSTITUTE_FIND_REGEX.ESCAPED:
      return ctx.substitute(script.findRegex, sanitizeRegexMacro);
    default:
      // ST：未知取值告警后按原样使用
      return script.findRegex;
  }
}

/**
 * 跑单条正则脚本（不做 placement / direction / depth 过滤，那是 applyRegexScripts 的事）。
 * 与 ST `runRegexScript` 逐行对应。
 */
export function runRegexScript(script: RegexScript, text: string, ctx: RegexRunContext): string {
  if (!script || script.disabled || !script.findRegex || !text) return text;

  const findRegex = regexFromString(resolveFindRegex(script, ctx));
  if (!findRegex) {
    ctx.onError?.(script, new Error(`无效的正则：${script.findRegex}`));
    return text;
  }

  const trimStrings = script.trimStrings ?? [];
  const replaceString = (script.replaceString ?? '').replace(/{{match}}/gi, '$0');

  try {
    return text.replace(findRegex, (...args: unknown[]) => {
      // ST 用一个会被反复覆写的 `match` 变量承接每个 $n / $<name>
      let match: unknown = args[0];
      const replaceWithGroups = replaceString.replaceAll(
        /\$(\d+)|\$<([^>]+)>/g,
        (_whole, num: string | undefined, groupName: string | undefined) => {
          if (num) {
            match = args[Number(num)];
          } else if (groupName) {
            const groups = args[args.length - 1];
            match =
              groups && typeof groups === 'object'
                ? (groups as Record<string, unknown>)[groupName]
                : false;
          }

          // 没匹配到就是空串（ST 用 falsy 判定，空串捕获组同样得到空串）
          if (!match) return '';

          return filterString(String(match), trimStrings, ctx);
        },
      );

      // ST：整条替换文本最后再过一次宏
      return ctx.substitute(replaceWithGroups);
    });
  } catch (error) {
    ctx.onError?.(script, error);
    return text;
  }
}

/**
 * ST `getRegexedString` 的方向过滤。
 *
 * ST 原文是 `(markdownOnly && isMarkdown) || (promptOnly && isPrompt) ||
 * (!markdownOnly && !promptOnly && !isMarkdown && !isPrompt)`：
 * 「两者」脚本只在收发消息时跑一次并**改写存档**，所以提示词与渲染都不再跑。
 * 新酒馆不改写存档消息（历史保留原文，组装 / 渲染各跑一次），因此这里让「两者」脚本
 * 在三个方向上都生效——最终可见结果与 ST 一致。见契约 §9 修正 RX-1。
 */
function directionAllows(script: RegexScript, direction: RegexRunContext['direction']): boolean {
  if (!script.markdownOnly && !script.promptOnly) return true;
  if (direction === 'display') return !!script.markdownOnly;
  if (direction === 'prompt') return !!script.promptOnly;
  return false;
}

/** ST `getRegexedString` 的 min/maxDepth 判定 */
function depthAllows(script: RegexScript, depth: number | undefined): boolean {
  if (typeof depth !== 'number') return true;

  const { minDepth, maxDepth } = script;
  if (typeof minDepth === 'number' && !isNaN(minDepth) && minDepth >= -1 && depth < minDepth) {
    return false;
  }
  if (typeof maxDepth === 'number' && !isNaN(maxDepth) && maxDepth >= 0 && depth > maxDepth) {
    return false;
  }
  return true;
}

/** 单条脚本是否应该在当前上下文里跑 */
export function shouldRunRegexScript(script: RegexScript, ctx: RegexRunContext): boolean {
  if (script.disabled) return false;
  if (!directionAllows(script, ctx.direction)) return false;
  if (ctx.isEdit && !script.runOnEdit) return false;
  if (!depthAllows(script, ctx.depth)) return false;
  return (script.placement ?? []).includes(ctx.placement);
}

/**
 * 按数组顺序依次应用正则脚本（ST 顺序：全局在前、角色在后，合并顺序由调用方负责）。
 * 无效正则跳过并触发 `ctx.onError`，绝不抛错。
 */
export function applyRegexScripts(
  scripts: readonly RegexScript[],
  text: string,
  ctx: RegexRunContext,
): string {
  if (typeof text !== 'string' || !text) return text;

  let out = text;
  for (const script of scripts) {
    if (!shouldRunRegexScript(script, ctx)) continue;
    out = runRegexScript(script, out, ctx);
  }
  return out;
}
