import { Check, Copy } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/ui/button';
import { copyText } from '../../lib/utils';

/** JSON 词法：键名用墨色、字符串用次要墨色、数字与字面量用强调色（不引入第二种色） */
const TOKEN_RE = /("(?:\\.|[^"\\])*"\s*:?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)/g;

function highlight(json: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of json.matchAll(TOKEN_RE)) {
    const index = match.index ?? last;
    if (index > last) nodes.push(json.slice(last, index));
    const raw = match[0] ?? '';
    const asString = match[1];
    const asNumber = match[2];
    const asLiteral = match[3];
    if (asString !== undefined) {
      const isKey = asString.trimEnd().endsWith(':');
      nodes.push(
        <span key={key++} className={isKey ? 'font-medium text-ink' : 'text-ink-2'}>
          {raw}
        </span>,
      );
    } else if (asNumber !== undefined) {
      nodes.push(
        <span key={key++} className="text-accent tabular-nums">
          {raw}
        </span>,
      );
    } else if (asLiteral !== undefined) {
      nodes.push(
        <span key={key++} className="text-accent">
          {raw}
        </span>,
      );
    }
    last = index + raw.length;
  }
  if (last < json.length) nodes.push(json.slice(last));
  return nodes;
}

/** 原始请求：只读 JSON 视图，语法高亮 + 复制 */
export function RequestView({ request }: { request: unknown }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => {
    try {
      return JSON.stringify(request, null, 2);
    } catch {
      return String(request);
    }
  }, [request]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (request === undefined || request === null) {
    return <p className="p-4 text-sm text-ink-2">{t('inspector.request.empty')}</p>;
  }

  return (
    <div className="space-y-2 p-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => void copyText(json).then(setCopied)}>
          {copied ? (
            <Check aria-hidden className="size-3.5" />
          ) : (
            <Copy aria-hidden className="size-3.5" />
          )}
          {copied ? t('common.copied') : t('inspector.request.copy')}
        </Button>
      </div>
      <pre className="rounded-card edge-rule bg-control overflow-x-auto border p-3 font-mono text-[11px] leading-relaxed">
        <code>{highlight(json)}</code>
      </pre>
    </div>
  );
}
