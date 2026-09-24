import { Fragment, Slice, type Node as PmNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * AI 在编辑器里的两块临时区域（M7 契约 §5.3），都不进文档内容（用装饰画，不用 mark）：
 *
 * - **待定区**（pending）：续写流式插入光标处的那一段。插入时区间向右长；结束后等用户
 *   「保留」（清掉标记）/「撤销」（一个事务删掉整段，跨段落的拆分也一并合回去）/「重来」。
 * - **目标区**（target）：重写 / 扩写 / 压缩 / 自定义时被选中的原文。结果在对照视图里，
 *   「替换」才写进来；等待期间用户照常编辑别处，区间随事务映射。
 *
 * 全部是 ProseMirror 纯状态函数，不依赖 DOM，单测直接对 `EditorState` 跑。
 */

export interface AiRange {
  from: number;
  to: number;
}

export interface AiPendingRange extends AiRange {
  /** 还在流式写入：区间末端向右吸附新插入的字 */
  streaming: boolean;
  /** 收到了换行但还没有落地（等下一段文字来了再拆段：连续换行合并，结尾换行丢弃） */
  newline: boolean;
}

export interface AiPluginState {
  pending: AiPendingRange | null;
  target: AiRange | null;
}

type AiMeta =
  | { type: 'start'; pos: number }
  | { type: 'newline'; value: boolean }
  | { type: 'finish' }
  | { type: 'clear' }
  | { type: 'target'; from: number; to: number }
  | { type: 'clearTarget' };

export const aiPluginKey = new PluginKey<AiPluginState>('writing-ai');

const EMPTY: AiPluginState = { pending: null, target: null };

function mapPending(pending: AiPendingRange, tr: Transaction): AiPendingRange | null {
  // 流式中：起点不跟着插入移动（-1），终点吞下新插入（1）；
  // 结束后反过来：紧贴两端打的字不算 AI 的
  const from = tr.mapping.map(pending.from, pending.streaming ? -1 : 1);
  const to = tr.mapping.map(pending.to, pending.streaming ? 1 : -1);
  if (to < from) return null;
  return { ...pending, from, to };
}

function mapTarget(target: AiRange, tr: Transaction): AiRange | null {
  const from = tr.mapping.map(target.from, 1);
  const to = tr.mapping.map(target.to, -1);
  return to < from ? null : { from, to };
}

export function aiPendingPlugin(): Plugin<AiPluginState> {
  return new Plugin<AiPluginState>({
    key: aiPluginKey,
    state: {
      init: () => EMPTY,
      apply(tr, value) {
        let next: AiPluginState = value;
        if (tr.docChanged) {
          next = {
            pending: value.pending ? mapPending(value.pending, tr) : null,
            target: value.target ? mapTarget(value.target, tr) : null,
          };
        }
        const meta = tr.getMeta(aiPluginKey) as AiMeta | undefined;
        if (!meta) return next;
        switch (meta.type) {
          case 'start':
            return {
              ...next,
              pending: { from: meta.pos, to: meta.pos, streaming: true, newline: false },
            };
          case 'newline':
            return next.pending
              ? { ...next, pending: { ...next.pending, newline: meta.value } }
              : next;
          case 'finish': {
            if (!next.pending) return next;
            // 什么也没写出来：直接收掉
            if (next.pending.to <= next.pending.from) return { ...next, pending: null };
            return { ...next, pending: { ...next.pending, streaming: false, newline: false } };
          }
          case 'clear':
            return { ...next, pending: null };
          case 'target':
            return { ...next, target: { from: meta.from, to: meta.to } };
          case 'clearTarget':
            return { ...next, target: null };
          default:
            return next;
        }
      },
    },
    props: {
      decorations(state) {
        const value = aiPluginKey.getState(state);
        if (!value) return null;
        const decorations: Decoration[] = [];
        if (value.pending && value.pending.to > value.pending.from) {
          decorations.push(
            Decoration.inline(value.pending.from, value.pending.to, {
              'data-part': 'writing-ai-pending',
              'data-streaming': String(value.pending.streaming),
              class: 'writing-ai-pending',
            }),
          );
        }
        if (value.target && value.target.to > value.target.from) {
          decorations.push(
            Decoration.inline(value.target.from, value.target.to, {
              'data-part': 'writing-ai-target',
              class: 'writing-ai-target',
            }),
          );
        }
        return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null;
      },
    },
  });
}

export function getAiState(state: EditorState): AiPluginState {
  return aiPluginKey.getState(state) ?? EMPTY;
}

/* ------------------------------------------------------------------ */
/* 待定区                                                                */
/* ------------------------------------------------------------------ */

/**
 * 续写落笔的位置：选区末端；选区不在文字段落里（选中了分隔线之类）时退到全文最后一段的末尾。
 */
export function insertionPos(state: EditorState): number {
  const { selection, doc } = state;
  let first = -1;
  let last = -1;
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (first < 0) first = pos + 1;
      last = pos + 1 + node.content.size;
    }
    return !node.isTextblock;
  });
  // 光标停在全文开头（刚打开、还没点进正文）时，续写接在全文末尾，而不是插到第一个字前面
  if (selection.empty && selection.from <= first && doc.textContent.trim() !== '') return last;
  if (selection.$to.parent.isTextblock) return selection.to;
  return last;
}

/** 在 `pos` 开一个空的待定区（流式开始） */
export function startPending(state: EditorState, pos: number): Transaction {
  const clamped = Math.max(0, Math.min(state.doc.content.size, pos));
  return state.tr
    .setMeta(aiPluginKey, { type: 'start', pos: clamped } satisfies AiMeta)
    .setMeta('addToHistory', false);
}

/**
 * 把一段流式增量写到待定区末尾。换行拆段：连续的换行只拆一次，
 * 段首（空段落里）不拆，最后的换行等后文来了才落地（结尾不留空段）。
 * 没有待定区时返回 null。
 */
export function appendPending(state: EditorState, delta: string): Transaction | null {
  const pending = getAiState(state).pending;
  if (!pending || delta === '') return null;
  const tr = state.tr;
  let pos = pending.to;
  let newline = pending.newline;
  for (const run of delta.replace(/\r\n?/g, '\n').split(/(\n+)/)) {
    if (run === '') continue;
    if (run.startsWith('\n')) {
      newline = true;
      continue;
    }
    if (newline) {
      const $pos = tr.doc.resolve(pos);
      // 光标在空段落开头（或段首）时，换行不再拆出一个空段
      if ($pos.parent.isTextblock && $pos.parentOffset > 0) {
        const before = tr.steps.length;
        tr.split(pos);
        // 只按这一步映射：split 之后 pos 落在新段落开头
        pos = tr.mapping.slice(before).map(pos, 1);
      }
      newline = false;
    }
    tr.insertText(run, pos);
    pos += run.length;
  }
  if (newline !== pending.newline) tr.setMeta(aiPluginKey, { type: 'newline', value: newline });
  tr.setMeta('addToHistory', false);
  return tr;
}

/** 流式结束（完成 / 停止 / 出错）：待定区定住，等用户决定；一个字也没写时直接收掉 */
export function finishPending(state: EditorState): Transaction {
  return state.tr.setMeta(aiPluginKey, { type: 'finish' } satisfies AiMeta);
}

/** 保留：只去掉标记，文字留下 */
export function keepPending(state: EditorState): Transaction {
  return state.tr.setMeta(aiPluginKey, { type: 'clear' } satisfies AiMeta);
}

/** 撤销：一个事务删掉整段待定文字（跨段时拆出来的段落一起合回去） */
export function undoPending(state: EditorState): Transaction {
  const pending = getAiState(state).pending;
  const tr = state.tr;
  if (pending && pending.to > pending.from) tr.delete(pending.from, pending.to);
  return tr.setMeta(aiPluginKey, { type: 'clear' } satisfies AiMeta).setMeta('addToHistory', false);
}

/** 待定区里的纯文本 */
export function pendingText(state: EditorState): string {
  const pending = getAiState(state).pending;
  if (!pending || pending.to <= pending.from) return '';
  return state.doc.textBetween(pending.from, pending.to, '\n\n', leafText);
}

/* ------------------------------------------------------------------ */
/* 目标区（重写 / 扩写 / 压缩 / 自定义）                                    */
/* ------------------------------------------------------------------ */

export function setTarget(state: EditorState, from: number, to: number): Transaction {
  return state.tr.setMeta(aiPluginKey, { type: 'target', from, to } satisfies AiMeta);
}

export function clearTarget(state: EditorState): Transaction {
  return state.tr.setMeta(aiPluginKey, { type: 'clearTarget' } satisfies AiMeta);
}

/** 用新文本替换目标区（一个事务，可以 Ctrl+Z 撤回）；没有目标区时返回 null */
export function replaceTarget(state: EditorState, text: string): Transaction | null {
  const target = getAiState(state).target;
  if (!target) return null;
  const tr = state.tr;
  const slice = textToSlice(state.schema, text);
  if (slice.size === 0) tr.delete(target.from, target.to);
  else tr.replaceRange(target.from, target.to, slice);
  return tr.setMeta(aiPluginKey, { type: 'clearTarget' } satisfies AiMeta);
}

/* ------------------------------------------------------------------ */
/* 纯文本 ↔ 文档                                                         */
/* ------------------------------------------------------------------ */

/** 段落之间空一行（导出 Markdown 时就是分段）；硬换行是单个换行 */
export const BLOCK_SEPARATOR = '\n\n';

export function leafText(node: PmNode): string {
  if (node.type.name === 'hardBreak') return '\n';
  if (node.type.name === 'horizontalRule') return '* * *';
  return '';
}

/** 文档的纯文本（随保存一并提交给服务端，服务端据此算字数、组装上下文） */
export function docText(doc: PmNode): string {
  return doc.textBetween(0, doc.content.size, BLOCK_SEPARATOR, leafText);
}

/** 光标 / 选区两侧的纯文本（AI 请求用）；偏移是纯文本偏移 */
export function cursorContext(state: EditorState): {
  from: number;
  to: number;
  textBefore: string;
  selectionText: string;
  textAfter: string;
} {
  const { from, to } = state.selection;
  const doc = state.doc;
  return {
    from,
    to,
    textBefore: doc.textBetween(0, from, BLOCK_SEPARATOR, leafText),
    selectionText: doc.textBetween(from, to, BLOCK_SEPARATOR, leafText),
    textAfter: doc.textBetween(to, doc.content.size, BLOCK_SEPARATOR, leafText),
  };
}

/** 把一段纯文本（可能多段）变成可以插进文档的 Slice：一段时是行内文字，多段时两头开口 */
export function textToSlice(schema: Schema, text: string): Slice {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) return Slice.empty;
  if (paragraphs.length === 1)
    return new Slice(Fragment.from(schema.text(paragraphs[0] ?? '')), 0, 0);
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) return new Slice(Fragment.from(schema.text(paragraphs.join(' '))), 0, 0);
  const nodes = paragraphs.map((line) => paragraph.create(null, schema.text(line)));
  return new Slice(Fragment.fromArray(nodes), 1, 1);
}

/** 按换行分段，去掉空段（中文小说常见单换行分段；空行只是分隔） */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .filter((line) => line.trim() !== '');
}

/** 没有 content（服务端建的、导入的）时从纯文本起一份 TipTap JSON */
export function textToDocJson(text: string): Record<string, unknown> {
  const paragraphs = splitParagraphs(text);
  return {
    type: 'doc',
    content:
      paragraphs.length === 0
        ? [{ type: 'paragraph' }]
        : paragraphs.map((line) => ({
            type: 'paragraph',
            content: [{ type: 'text', text: line }],
          })),
  };
}
