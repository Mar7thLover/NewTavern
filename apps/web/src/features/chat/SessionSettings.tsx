import { ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input, Select, Textarea } from '../../components/ui/field';
import { Switch } from '../../components/ui/switch';
import {
  DEFAULT_AUTHORS_NOTE,
  readAuthorsNote,
  useGlobalSystemPrompt,
  usePatchChat,
  useSetChatLorebooks,
  type AuthorsNote,
  type AuthorsNotePosition,
  type ChatDetail,
  type GlobalSystemPromptOverride,
  type GlobalSystemPromptPosition,
  type InjectionRole,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { LorebookPicker } from '../library/LorebookPicker';

/* ------------------------------------------------------------------ */
/* 折叠小节                                                             */
/* ------------------------------------------------------------------ */

export function PanelSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-border bg-card/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            !open && '-rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
        {summary !== undefined && (
          <span className="shrink-0 text-[11px] text-muted-foreground">{summary}</span>
        )}
      </button>
      {open && <div className="space-y-3 border-t border-border px-3 py-3">{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 作者注释                                                             */
/* ------------------------------------------------------------------ */

const AN_POSITIONS: { value: AuthorsNotePosition; labelKey: string }[] = [
  { value: 1, labelKey: 'authorsNote.positions.inChat' },
  { value: 0, labelKey: 'authorsNote.positions.afterMain' },
  { value: 2, labelKey: 'authorsNote.positions.beforeMain' },
];

const ROLE_OPTIONS: { value: InjectionRole; labelKey: string }[] = [
  { value: 0, labelKey: 'authorsNote.roles.system' },
  { value: 1, labelKey: 'authorsNote.roles.user' },
  { value: 2, labelKey: 'authorsNote.roles.assistant' },
];

export function AuthorsNoteSection({ chat }: { chat: ChatDetail }) {
  const { t } = useTranslation();
  const patchChat = usePatchChat();
  // 用 JSON 指纹稳定住 saved 的对象身份，否则每次渲染都会重置草稿
  const savedJson = JSON.stringify(readAuthorsNote(chat));
  const saved = useMemo(() => JSON.parse(savedJson) as AuthorsNote | null, [savedJson]);
  const [draft, setDraft] = useState<AuthorsNote>(saved ?? DEFAULT_AUTHORS_NOTE);

  // 服务端值变化（切换会话 / 别处改动）时重置草稿
  useEffect(() => {
    setDraft(saved ?? DEFAULT_AUTHORS_NOTE);
  }, [saved]);

  /** 文本为空视为「未设置」，写 null 清除 */
  const commit = (next: AuthorsNote) => {
    const payload = next.text.trim() === '' ? null : next;
    patchChat.mutate({ id: chat.id, metadata: { authorsNote: payload } });
  };

  const update = (partial: Partial<AuthorsNote>, save: boolean) => {
    const next = { ...draft, ...partial };
    setDraft(next);
    if (save) commit(next);
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved ?? DEFAULT_AUTHORS_NOTE);
  const savedPosition = AN_POSITIONS.find((item) => item.value === saved?.position);
  const inChat = draft.position === 1;

  return (
    <PanelSection
      title={t('authorsNote.title')}
      summary={savedPosition ? t(savedPosition.labelKey) : t('authorsNote.empty')}
    >
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('authorsNote.hint')}</p>

      <div>
        <FieldLabel htmlFor={`an-text-${chat.id}`}>{t('authorsNote.text')}</FieldLabel>
        <Textarea
          id={`an-text-${chat.id}`}
          rows={3}
          value={draft.text}
          placeholder={t('authorsNote.textPlaceholder')}
          onChange={(event) => update({ text: event.target.value }, false)}
          onBlur={() => dirty && commit(draft)}
          className="text-xs"
        />
      </div>

      <div>
        <FieldLabel>{t('authorsNote.position')}</FieldLabel>
        <Select
          size="sm"
          value={String(draft.position)}
          onChange={(event) =>
            update({ position: Number(event.target.value) as AuthorsNotePosition }, true)
          }
        >
          {AN_POSITIONS.map(({ value, labelKey }) => (
            <option key={value} value={value}>
              {t(labelKey)}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <FieldLabel>{t('authorsNote.depth')}</FieldLabel>
          <Input
            size="sm"
            type="number"
            min={0}
            disabled={!inChat}
            value={draft.depth}
            onChange={(event) => update({ depth: Number(event.target.value) || 0 }, false)}
            onBlur={() => dirty && commit(draft)}
          />
        </div>
        <div>
          <FieldLabel>{t('authorsNote.role')}</FieldLabel>
          <Select
            size="sm"
            disabled={!inChat}
            value={String(draft.role)}
            onChange={(event) =>
              update({ role: Number(event.target.value) as InjectionRole }, true)
            }
          >
            {ROLE_OPTIONS.map(({ value, labelKey }) => (
              <option key={value} value={value}>
                {t(labelKey)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('authorsNote.depthHint')}</p>

      <div>
        <FieldLabel>{t('authorsNote.interval')}</FieldLabel>
        <Input
          size="sm"
          type="number"
          min={1}
          value={draft.interval}
          onChange={(event) => update({ interval: Number(event.target.value) || 1 }, false)}
          onBlur={() => dirty && commit(draft)}
        />
        <p className="mt-1 text-[11px] text-muted-foreground">{t('authorsNote.intervalHint')}</p>
      </div>

      <div className="flex items-center justify-between gap-2">
        {dirty ? <Badge variant="outline">{t('common.unsaved')}</Badge> : <span />}
        <Button
          size="sm"
          variant="ghost"
          disabled={saved === null}
          onClick={() => {
            setDraft(DEFAULT_AUTHORS_NOTE);
            patchChat.mutate({ id: chat.id, metadata: { authorsNote: null } });
          }}
        >
          {t('authorsNote.clear')}
        </Button>
      </div>
    </PanelSection>
  );
}

/* ------------------------------------------------------------------ */
/* 聊天世界书                                                           */
/* ------------------------------------------------------------------ */

export function ChatLorebooksSection({ chat }: { chat: ChatDetail }) {
  const { t } = useTranslation();
  const setLorebooks = useSetChatLorebooks();
  const selected = chat.lorebookIds ?? [];

  return (
    <PanelSection
      title={t('worldInfo.chatBooks')}
      summary={
        selected.length > 0 ? t('worldInfo.selected', { total: selected.length }) : t('common.none')
      }
    >
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t('worldInfo.chatBooksHint')}
      </p>
      <LorebookPicker
        selected={selected}
        disabled={setLorebooks.isPending}
        onChange={(bookIds) => setLorebooks.mutate({ chatId: chat.id, bookIds })}
      />
      {setLorebooks.error && (
        <p role="alert" className="text-[11px] text-destructive">
          {setLorebooks.error instanceof Error
            ? setLorebooks.error.message
            : String(setLorebooks.error)}
        </p>
      )}
    </PanelSection>
  );
}

/* ------------------------------------------------------------------ */
/* 全局系统提示词（按会话覆盖）                                          */
/* ------------------------------------------------------------------ */

const GSP_POSITIONS: GlobalSystemPromptPosition[] = ['before_main', 'after_main'];

export function ChatSystemPromptSection({ chat }: { chat: ChatDetail }) {
  const { t } = useTranslation();
  const patchChat = usePatchChat();
  const global = useGlobalSystemPrompt();
  const overrides = chat.overrides ?? {};
  const override = overrides.globalSystemPrompt ?? null;
  const base = global.data ?? { enabled: false, text: '', position: 'before_main' as const };

  const [text, setText] = useState(override?.text ?? '');
  useEffect(() => setText(override?.text ?? ''), [chat.id, override?.text]);

  const patchOverride = (next: GlobalSystemPromptOverride | null) => {
    patchChat.mutate({ id: chat.id, overrides: { ...overrides, globalSystemPrompt: next } });
  };

  const enabled = override?.enabled ?? base.enabled;
  const position = override?.position ?? base.position;

  return (
    <PanelSection
      title={t('globalSystemPrompt.title')}
      summary={
        override
          ? t('globalSystemPrompt.override')
          : t('globalSystemPrompt.globalState', {
              state: base.enabled
                ? t('globalSystemPrompt.stateOn')
                : t('globalSystemPrompt.stateOff'),
            })
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm">{t('globalSystemPrompt.override')}</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {t('globalSystemPrompt.overrideHint')}
          </p>
        </div>
        <Switch
          checked={override !== null}
          label={t('globalSystemPrompt.override')}
          onChange={(checked) =>
            patchOverride(
              checked ? { enabled: base.enabled, text: base.text, position: base.position } : null,
            )
          }
        />
      </div>

      {override !== null && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{t('globalSystemPrompt.enabled')}</span>
            <Switch
              checked={enabled}
              label={t('globalSystemPrompt.enabled')}
              onChange={(checked) => patchOverride({ ...override, enabled: checked })}
            />
          </div>
          <div>
            <FieldLabel>{t('globalSystemPrompt.text')}</FieldLabel>
            <Textarea
              rows={4}
              value={text}
              placeholder={t('globalSystemPrompt.textPlaceholder')}
              onChange={(event) => setText(event.target.value)}
              onBlur={() => text !== (override.text ?? '') && patchOverride({ ...override, text })}
              className="text-xs"
            />
          </div>
          <div>
            <FieldLabel>{t('globalSystemPrompt.position')}</FieldLabel>
            <Select
              size="sm"
              value={position}
              onChange={(event) =>
                patchOverride({
                  ...override,
                  position: event.target.value as GlobalSystemPromptPosition,
                })
              }
            >
              {GSP_POSITIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`globalSystemPrompt.positions.${value}`)}
                </option>
              ))}
            </Select>
          </div>
        </>
      )}
    </PanelSection>
  );
}
