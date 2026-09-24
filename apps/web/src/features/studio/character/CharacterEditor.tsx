import { ArrowDown, ArrowUp, BookOpen, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../components/ui/button';
import { FieldLabel, Input, Select } from '../../../components/ui/field';
import { IconButton } from '../../../components/ui/icon-button';
import { Segmented } from '../../../components/ui/segmented';
import { useLorebooks } from '../../../lib/api';
import type { StudioCharacterDetail } from '../../../lib/api-studio';
import { useDraftUpdater } from '../../library/preset-editor/shared';
import { SpriteManager } from '../../sprites/SpriteManager';
import { setAtImmutable } from '../draft/patch';
import type { CharacterDraft } from '../types';
import { AvatarField } from './AvatarField';
import { EditorSection, LongTextField } from './fields';
import { readCardScripts } from './scripts';
import { ScriptsSection } from './ScriptsSection';

/*
 * 角色卡编辑器（M6 §4.2，受控）：草稿 = 完整 CCv3 data，由工作台持有；保存 / 还原在工作台页头。
 * 所有改动都是「浅拷贝改一处」，没碰到的字段（包括未知字段与 extensions 里别家的键）原样带回服务端。
 * 头像与立绘不在 data 里，改完直接生效；内嵌世界书在世界书编辑器里改。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

const DEPTH_ROLES = ['system', 'user', 'assistant'] as const;
const DEFAULT_DEPTH = 4;

export interface CharacterEditorProps {
  characterId: string;
  /** 服务端当前行：头像、内嵌书 id */
  detail: StudioCharacterDetail | undefined;
  value: CharacterDraft;
  baseline: CharacterDraft;
  onChange: (next: CharacterDraft) => void;
  /** 头像等不进草稿的改动：服务端返回的新行 */
  onDetail: (detail: StudioCharacterDetail) => void;
  /** 打开内嵌世界书 */
  onOpenBook: (bookId: string) => void;
}

export function CharacterEditor({
  characterId,
  detail,
  value,
  baseline,
  onChange,
  onDetail,
  onOpenBook,
}: CharacterEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const update = useDraftUpdater(value, onChange);
  const setField = (key: string, next: unknown) => update((data) => ({ ...data, [key]: next }));
  const setPath = (tokens: string[], next: unknown) =>
    update((data) => setAtImmutable(data, tokens, next));

  const name = str(value.name);
  const nameMissing = name.trim() === '';
  const greetings = Array.isArray(value.alternate_greetings)
    ? value.alternate_greetings.map(str)
    : [];
  const extensions = isRecord(value.extensions) ? value.extensions : {};
  const depthPrompt = isRecord(extensions.depth_prompt) ? extensions.depth_prompt : {};
  const scriptCount = useMemo(() => readCardScripts(value).length, [value]);

  const setGreetings = (next: string[]) => setField('alternate_greetings', next);
  const setDepth = (key: 'prompt' | 'depth' | 'role', next: unknown) =>
    update((data) => {
      const ext = isRecord(data.extensions) ? data.extensions : {};
      const current = isRecord(ext.depth_prompt)
        ? ext.depth_prompt
        : { prompt: '', depth: DEFAULT_DEPTH, role: 'system' };
      return { ...data, extensions: { ...ext, depth_prompt: { ...current, [key]: next } } };
    });

  return (
    <div className="@container">
      <EditorSection title={t('studio.character.sections.basic')}>
        <AvatarField characterId={characterId} detail={detail} name={name} onDetail={onDetail} />
        <div>
          <FieldLabel htmlFor={`${id}-name`}>{t('studio.character.fields.name')}</FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            aria-invalid={nameMissing}
            onChange={(event) => setField('name', event.target.value)}
          />
          {nameMissing && (
            <p role="alert" className="mt-1 text-[11px] text-danger">
              {t('studio.character.nameRequired')}
            </p>
          )}
        </div>
        <div className="grid gap-4 @md:grid-cols-2">
          <div>
            <FieldLabel htmlFor={`${id}-creator`}>
              {t('studio.character.fields.creator')}
            </FieldLabel>
            <Input
              id={`${id}-creator`}
              value={str(value.creator)}
              onChange={(event) => setField('creator', event.target.value)}
            />
          </div>
          <div>
            <FieldLabel htmlFor={`${id}-version`}>
              {t('studio.character.fields.character_version')}
            </FieldLabel>
            <Input
              id={`${id}-version`}
              value={str(value.character_version)}
              onChange={(event) => setField('character_version', event.target.value)}
            />
          </div>
        </div>
        <TagsField
          label={t('studio.character.fields.tags')}
          tags={Array.isArray(value.tags) ? value.tags.map(str).filter(Boolean) : []}
          onChange={(tags) => setField('tags', tags)}
        />
      </EditorSection>

      <EditorSection title={t('studio.character.sections.persona')}>
        <LongTextField
          label={t('studio.character.fields.description')}
          value={str(value.description)}
          onChange={(next) => setField('description', next)}
          minRows={6}
        />
        <LongTextField
          label={t('studio.character.fields.personality')}
          value={str(value.personality)}
          onChange={(next) => setField('personality', next)}
        />
        <LongTextField
          label={t('studio.character.fields.scenario')}
          value={str(value.scenario)}
          onChange={(next) => setField('scenario', next)}
        />
      </EditorSection>

      <EditorSection
        title={t('studio.character.sections.greetings')}
        note={t('studio.character.greetingCount', { n: 1 + greetings.length })}
      >
        <LongTextField
          label={t('studio.character.fields.first_mes')}
          value={str(value.first_mes)}
          onChange={(next) => setField('first_mes', next)}
          minRows={5}
        />
        {greetings.map((greeting, index) => (
          <LongTextField
            key={index}
            label={`${t('studio.character.fields.alternate_greetings')} #${index + 1}`}
            value={greeting}
            onChange={(next) => setGreetings(greetings.map((g, i) => (i === index ? next : g)))}
            actions={
              <span className="mb-1 flex gap-0.5">
                <IconButton
                  label={t('studio.moveUp')}
                  size="xs"
                  disabled={index === 0}
                  onClick={() => {
                    const next = [...greetings];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    setGreetings(next);
                  }}
                >
                  <ArrowUp aria-hidden />
                </IconButton>
                <IconButton
                  label={t('studio.moveDown')}
                  size="xs"
                  disabled={index === greetings.length - 1}
                  onClick={() => {
                    const next = [...greetings];
                    [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
                    setGreetings(next);
                  }}
                >
                  <ArrowDown aria-hidden />
                </IconButton>
                <IconButton
                  label={t('common.delete')}
                  size="xs"
                  variant="destructive"
                  onClick={() => setGreetings(greetings.filter((_, i) => i !== index))}
                >
                  <Trash2 aria-hidden />
                </IconButton>
              </span>
            }
          />
        ))}
        <Button variant="ghost" size="sm" onClick={() => setGreetings([...greetings, ''])}>
          <Plus className="size-3.5" aria-hidden />
          {t('studio.character.addGreeting')}
        </Button>
      </EditorSection>

      <EditorSection title={t('studio.character.sections.examples')}>
        <LongTextField
          label={t('studio.character.fields.mes_example')}
          hint={t('studio.character.mesExampleHint', { char: '{{char}}', user: '{{user}}' })}
          value={str(value.mes_example)}
          onChange={(next) => setField('mes_example', next)}
          minRows={5}
        />
      </EditorSection>

      <EditorSection title={t('studio.character.sections.prompts')}>
        <LongTextField
          label={t('studio.character.fields.system_prompt')}
          hint={t('studio.character.systemPromptHint', { original: '{{original}}' })}
          value={str(value.system_prompt)}
          onChange={(next) => setField('system_prompt', next)}
        />
        <LongTextField
          label={t('studio.character.fields.post_history_instructions')}
          value={str(value.post_history_instructions)}
          onChange={(next) => setField('post_history_instructions', next)}
        />
        <LongTextField
          label={t('studio.character.fields.depth_prompt')}
          hint={t('studio.character.depthPromptHint')}
          value={str(depthPrompt.prompt)}
          onChange={(next) => setDepth('prompt', next)}
        />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor={`${id}-depth`}>{t('studio.character.depth.depth')}</FieldLabel>
            <Input
              id={`${id}-depth`}
              type="number"
              min={0}
              max={999}
              value={typeof depthPrompt.depth === 'number' ? depthPrompt.depth : DEFAULT_DEPTH}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                if (Number.isInteger(next) && next >= 0) setDepth('depth', next);
              }}
            />
          </div>
          <div>
            <FieldLabel htmlFor={`${id}-depth-role`}>{t('studio.character.depth.role')}</FieldLabel>
            <Select
              id={`${id}-depth-role`}
              value={
                DEPTH_ROLES.includes(depthPrompt.role as never) ? str(depthPrompt.role) : 'system'
              }
              onChange={(event) => setDepth('role', event.target.value)}
            >
              {DEPTH_ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(`studio.roles.${role}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </EditorSection>

      <EditorSection title={t('studio.character.sections.notes')} collapsible>
        <CreatorNotes value={value} setField={setField} setPath={setPath} />
      </EditorSection>

      <EditorSection title={t('studio.character.sections.book')}>
        <EmbeddedBook
          bookId={detail?.bookId ?? null}
          draftBook={value.character_book}
          baselineBook={baseline.character_book}
          onOpenBook={onOpenBook}
        />
      </EditorSection>

      <EditorSection
        title={t('studio.character.sections.scripts')}
        collapsible
        defaultOpen={scriptCount > 0}
        note={scriptCount > 0 ? String(scriptCount) : undefined}
      >
        <ScriptsSection value={value} update={update} />
      </EditorSection>

      <EditorSection title={t('studio.character.sections.sprites')} collapsible defaultOpen={false}>
        <SpriteManager characterId={characterId} />
      </EditorSection>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** 标签：逗号分隔（中英文逗号都认），失焦时规整 */
function TagsField({
  label,
  tags,
  onChange,
}: {
  label: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const id = useId();
  const joined = tags.join(', ');
  const [text, setText] = useState(joined);
  // 外部改了（AI、恢复版本）才同步回输入框
  useEffect(() => {
    setText((current) => (parseTags(current).join(', ') === joined ? current : joined));
  }, [joined]);
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const next = parseTags(event.target.value);
          if (next.join(', ') !== joined) onChange(next);
        }}
        onBlur={() => setText(joined)}
      />
    </div>
  );
}

function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

/** 创作者笔记：默认 + `creator_notes_multilingual` 按语言页签 */
function CreatorNotes({
  value,
  setField,
  setPath,
}: {
  value: CharacterDraft;
  setField: (key: string, next: unknown) => void;
  setPath: (tokens: string[], next: unknown) => void;
}) {
  const { t } = useTranslation();
  const multilingual = isRecord(value.creator_notes_multilingual)
    ? value.creator_notes_multilingual
    : {};
  const languages = Object.keys(multilingual);
  const [tab, setTab] = useState<string>('');
  const [adding, setAdding] = useState('');
  const active = tab !== '' && languages.includes(tab) ? tab : '';

  const addLanguage = () => {
    const code = adding.trim();
    if (!code || languages.includes(code)) return;
    setField('creator_notes_multilingual', { ...multilingual, [code]: '' });
    setTab(code);
    setAdding('');
  };

  return (
    <div className="space-y-3">
      <Segmented
        size="sm"
        value={active}
        onChange={setTab}
        items={[
          { value: '', label: t('studio.character.notesDefault') },
          ...languages.map((code) => ({ value: code, label: code })),
        ]}
      />
      {active === '' ? (
        <LongTextField
          label={t('studio.character.fields.creator_notes')}
          hint={t('studio.character.creatorNotesHint')}
          value={str(value.creator_notes)}
          onChange={(next) => setField('creator_notes', next)}
        />
      ) : (
        <LongTextField
          label={`${t('studio.character.fields.creator_notes')}（${active}）`}
          value={str(multilingual[active])}
          onChange={(next) => setPath(['creator_notes_multilingual', active], next)}
          actions={
            <IconButton
              label={t('studio.character.removeLanguage')}
              size="xs"
              variant="destructive"
              className="mb-1"
              onClick={() => {
                const { [active]: _removed, ...rest } = multilingual;
                setField('creator_notes_multilingual', rest);
                setTab('');
              }}
            >
              <X aria-hidden />
            </IconButton>
          }
        />
      )}
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          className="max-w-40"
          value={adding}
          placeholder={t('studio.character.languagePlaceholder')}
          aria-label={t('studio.character.addLanguage')}
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addLanguage();
            }
          }}
        />
        <Button variant="ghost" size="sm" disabled={adding.trim() === ''} onClick={addLanguage}>
          <Plus className="size-3.5" aria-hidden />
          {t('studio.character.addLanguage')}
        </Button>
      </div>
    </div>
  );
}

/** 内嵌世界书：已抽成独立世界书时给入口；草稿里新写的（AI 生成）保存后才会抽出来 */
function EmbeddedBook({
  bookId,
  draftBook,
  baselineBook,
  onOpenBook,
}: {
  bookId: string | null;
  draftBook: unknown;
  baselineBook: unknown;
  onOpenBook: (bookId: string) => void;
}) {
  const { t } = useTranslation();
  const books = useLorebooks();
  if (bookId) {
    const book = books.data?.find((item) => item.id === bookId);
    return (
      <div className="flex flex-wrap items-center gap-3">
        <BookOpen aria-hidden className="size-4 text-ink-3" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{book?.name ?? t('common.loading')}</div>
          {book && (
            <div className="text-[11px] text-ink-3">
              {t('studio.character.bookEntries', { n: book.entryCount })}
            </div>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => onOpenBook(bookId)}>
          {t('studio.character.openBook')}
        </Button>
      </div>
    );
  }
  const entries =
    isRecord(draftBook) && Array.isArray(draftBook.entries) ? draftBook.entries.length : 0;
  if (isRecord(draftBook) && draftBook !== baselineBook) {
    return (
      <p className="text-xs leading-relaxed text-ink-2">
        {t('studio.character.bookPending', { n: entries })}
      </p>
    );
  }
  return <p className="text-xs text-ink-3">{t('studio.character.bookNone')}</p>;
}
