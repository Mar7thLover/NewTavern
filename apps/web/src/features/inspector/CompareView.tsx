import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CompareMessage, CompareResult } from './types';
import { useCompareStRequest, type CompareInput } from './useInspect';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/field';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../library/shared';

export interface CompareViewProps {
  target: Omit<CompareInput, 'stRequest'>;
}

/** 「与 ST 请求比对」：粘贴 ST 请求体 → POST /api/inspect/compare → 首个差异并排展示 */
export function CompareView({ target }: CompareViewProps) {
  const { t } = useTranslation();
  const compare = useCompareStRequest();
  const [raw, setRaw] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  const run = () => {
    setParseError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setParseError(t('inspector.compare.invalidJson'));
      return;
    }
    compare.mutate({ ...target, stRequest: parsed });
  };

  // 端点尚未实现时服务端 404，给一句明确说明而不是干巴巴的错误码
  const notImplemented = compare.error instanceof ApiError && compare.error.status === 404;

  return (
    <div className="space-y-3 p-3">
      <p className="text-xs leading-relaxed text-ink-2">{t('inspector.compare.hint')}</p>
      <Textarea
        rows={6}
        value={raw}
        spellCheck={false}
        placeholder={t('inspector.compare.placeholder')}
        onChange={(event) => setRaw(event.target.value)}
        className="font-mono text-[11px]"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={run} disabled={raw.trim() === '' || compare.isPending}>
          {compare.isPending ? t('common.processing') : t('inspector.compare.run')}
        </Button>
        {parseError && <span className="text-xs text-danger">{parseError}</span>}
      </div>

      {compare.error && (
        <p role="alert" className="text-xs text-danger">
          {notImplemented ? t('inspector.compare.unavailable') : errorMessage(compare.error)}
        </p>
      )}

      {compare.data && <CompareResultView result={compare.data} />}
    </div>
  );
}

function CompareResultView({ result }: { result: CompareResult }) {
  const { t } = useTranslation();
  if (result.same) {
    return (
      <p className="edge-rule border-t px-0.5 py-2 text-xs text-ink-2">
        {t('inspector.compare.same')}
      </p>
    );
  }

  const index = result.firstDiffIndex;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-danger">{t('inspector.compare.diffAt', { index })}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <CompareSide title={t('inspector.compare.ours')} message={result.ours[index]} />
        <CompareSide title={t('inspector.compare.theirs')} message={result.theirs[index]} />
      </div>
      {result.hints.length > 0 && (
        <div className="edge-rule border-t px-0.5 py-2">
          <div className="text-[11px] font-medium text-ink-2">{t('inspector.compare.hints')}</div>
          <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs text-ink-2">
            {result.hints.map((hint, i) => (
              <li key={i}>{hint}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CompareSide({ title, message }: { title: string; message: CompareMessage | undefined }) {
  const { t } = useTranslation();
  const content =
    typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content);
  return (
    <div className="rounded-card edge-rule min-w-0 border p-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink-2">
        <span className="font-medium">{title}</span>
        {message && <span>{message.role}</span>}
      </div>
      <pre className="mt-1.5 max-h-64 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {message ? content : t('inspector.compare.missing')}
      </pre>
    </div>
  );
}
