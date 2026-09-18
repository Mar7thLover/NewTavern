/**
 * MVU（MagVarUpdate）变量框架的内置实现。见 docs/PLAN.md §3.5、docs/M5-CONTRACT.md §2。
 *
 * 分工：
 * - `commands.ts`：从模型输出里抽命令（`_.set/_.add/_.insert/_.remove` 与 `<JSONPatch>`）
 * - `value.ts`：命令里「值」的解析（JSON → YAML → 算术 → 字符串）
 * - `engine.ts`：把命令应用到变量表，算 `display_data` / `delta_data`
 * - `init.ts`：`[InitVar]` 世界书条目 → 变量表初始形态
 * - `path.ts`：lodash 路径子集（`_.get/_.set/_.has/_.unset` + MVU `pathFix`）
 *
 * 与原版 MVU 的差别集中写在 docs/M5-CONTRACT.md 的兼容矩阵里，不在代码里散落。
 */

export * from './commands.js';
export * from './engine.js';
export * from './init.js';
export {
  clone as cloneVariables,
  getPath as getVariablePath,
  hasPath as hasVariablePath,
  pathFix,
  setPath as setVariablePath,
  toPath as toVariablePath,
  unsetPath as unsetVariablePath,
} from './path.js';
export { evaluateArithmetic, parseCommandValue } from './value.js';

/**
 * MVU 对外广播的事件名（原样照抄，**包括 `initiailized` 这个拼写错误**——
 * 社区卡监听的就是这个字符串，改对了反而收不到）。
 */
export const MVU_EVENTS = {
  VARIABLE_INITIALIZED: 'mag_variable_initiailized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  COMMAND_PARSED: 'mag_command_parsed',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
} as const;

export type MvuEventName = (typeof MVU_EVENTS)[keyof typeof MVU_EVENTS];
