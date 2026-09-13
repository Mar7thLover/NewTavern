import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '../../lib/utils';

/* ------------------------------------------------------------------ */
/* 引号着色（rehype 插件）                                              */
/* ------------------------------------------------------------------ */

/** hast 节点的最小子集；避免为了类型引入 unified/hast 的间接依赖 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** 代码里的引号不着色 */
const SKIP_TAGS = new Set(['code', 'pre']);

/** 成对的中英文引号，不跨行 */
const QUOTE_RE = /“[^”\n]*”|「[^」\n]*」|"[^"\n]*"/g;

function splitQuoted(value: string): HastNode[] | null {
  QUOTE_RE.lastIndex = 0;
  const out: HastNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTE_RE.exec(value)) !== null) {
    if (match.index > last) out.push({ type: 'text', value: value.slice(last, match.index) });
    out.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['text-primary'] },
      children: [{ type: 'text', value: match[0] }],
    });
    last = match.index + match[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function highlightQuotes(node: HastNode): void {
  if (!node.children) return;
  if (node.tagName !== undefined && SKIP_TAGS.has(node.tagName)) return;
  const next: HastNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const parts = splitQuoted(child.value);
      if (parts) {
        next.push(...parts);
        changed = true;
        continue;
      }
    } else {
      highlightQuotes(child);
    }
    next.push(child);
  }
  if (changed) node.children = next;
}

/** 把引号内的文本包进 `<span class="text-primary">`；代码块内跳过 */
function rehypeQuoteHighlight() {
  return (tree: HastNode) => {
    highlightQuotes(tree);
  };
}

/* ------------------------------------------------------------------ */
/* 元素样式                                                             */
/* ------------------------------------------------------------------ */

const BLOCK_SPACING = 'my-[0.75em] first:mt-0 last:mb-0';

const components: Components = {
  p: ({ node: _node, className, ...props }) => (
    <p className={cn(BLOCK_SPACING, className)} {...props} />
  ),
  em: ({ node: _node, className, ...props }) => (
    <em className={cn('text-muted-foreground italic', className)} {...props} />
  ),
  strong: ({ node: _node, className, ...props }) => (
    <strong className={cn('font-semibold', className)} {...props} />
  ),
  a: ({ node: _node, className, ...props }) => (
    <a
      target="_blank"
      rel="noreferrer noopener"
      className={cn('text-primary underline underline-offset-2', className)}
      {...props}
    />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul className={cn(BLOCK_SPACING, 'list-disc space-y-1 ps-5', className)} {...props} />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol className={cn(BLOCK_SPACING, 'list-decimal space-y-1 ps-5', className)} {...props} />
  ),
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      className={cn(
        BLOCK_SPACING,
        'border-s-2 border-border ps-3 text-muted-foreground',
        className,
      )}
      {...props}
    />
  ),
  h1: ({ node: _node, className, ...props }) => (
    <h2
      className={cn('mt-[1em] mb-[0.5em] text-lg font-semibold first:mt-0', className)}
      {...props}
    />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h3
      className={cn('mt-[1em] mb-[0.5em] text-base font-semibold first:mt-0', className)}
      {...props}
    />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h4
      className={cn('mt-[1em] mb-[0.5em] text-[15px] font-semibold first:mt-0', className)}
      {...props}
    />
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr className={cn('my-[1.2em] border-border', className)} {...props} />
  ),
  pre: ({ node: _node, className, ...props }) => (
    <pre
      className={cn(
        BLOCK_SPACING,
        'overflow-x-auto rounded-lg border border-border bg-muted/60 p-3 text-[13px] leading-[1.6] [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit',
        className,
      )}
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      className={cn(
        'rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground',
        className,
      )}
      {...props}
    />
  ),
  table: ({ node: _node, className, ...props }) => (
    <div className={cn(BLOCK_SPACING, 'overflow-x-auto')}>
      <table className={cn('w-full border-collapse text-[14px]', className)} {...props} />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      className={cn('border border-border bg-muted/50 px-2 py-1 text-start font-medium', className)}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td className={cn('border border-border px-2 py-1 align-top', className)} {...props} />
  ),
  img: ({ node: _node, className, ...props }) => (
    <img
      loading="lazy"
      className={cn(BLOCK_SPACING, 'max-h-96 rounded-lg border border-border', className)}
      {...props}
    />
  ),
};

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- rehype 插件签名依赖 unified 的间接类型 */
const rehypePlugins = [rehypeQuoteHighlight as any];
const remarkPlugins = [remarkGfm];

export interface MarkdownProps {
  children: string;
  /** 流式中：在最后一个块级元素末尾显示光标 */
  streaming?: boolean;
  className?: string;
}

/** 消息正文渲染。原生 HTML 默认被 react-markdown 转义（前端卡在 M5 另行开放）。 */
export const Markdown = memo(function Markdown({ children, streaming, className }: MarkdownProps) {
  return (
    <div className={cn('break-words', streaming && 'md-streaming', className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
