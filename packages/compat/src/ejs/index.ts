/**
 * EJS 提示词模板（ST-Prompt-Template 兼容子集），入口 `@newtavern/compat/ejs`。
 * 只在服务端用：本入口会在加载时准备 QuickJS 的 WASM 模块（顶层 await），
 * 浏览器侧不要 import 它（compat 主入口不导出这里的任何东西）。见 docs/M5-CONTRACT.md 第二部分 §4。
 */
export { compileEjs, CompileCache, EjsSyntaxError, hasEjs } from './compile.js';
export {
  EjsVariableStore,
  findWorldInfoEntry,
  normalizeVarOptions,
  type EjsScope,
  type EjsVarOptions,
  type EjsVars,
  type EjsWiTitle,
} from './host.js';
export { MAX_TEMPLATE_DEPTH, UNIMPLEMENTED_FUNCTIONS, UNIMPLEMENTED_OBJECTS } from './prelude.js';
export {
  createEjsRenderer,
  ejsCompileCache,
  ejsEngineLoadMs,
  type EjsEnv,
  type EjsHost,
  type EjsRenderContext,
  type EjsRenderer,
  type EjsRendererOptions,
} from './renderer.js';
