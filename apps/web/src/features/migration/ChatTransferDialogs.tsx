import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/button';
import { FieldLabel, Select } from '../../components/ui/field';
import { useCharacters } from '../../lib/api';
import {
  readStChatHeader,
  useImportStChat,
  type ExportStChatResult,
  type ImportStChatResult,
} from '../../lib/api-migration';
import { errorMessage } from '../library/shared';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type HeaderState =
  | { status: 'reading' }
  | { status: 'ready'; characterName: string | null }
  | { status: 'unreadable' };

/**
 * 导入 SillyTavern 聊天记录（M4 §2.4）：选好文件后弹出，按记录里的 character_name 预选角色，
 * 可改成「不绑定角色」。导入成功且没有告警时直接打开对话；有告警先把告警摆出来。
 */
export function ImportChatDialog({
  file,
  onClose,
  onOpenChat,
}: {
  file: File | null;
  onClose: () => void;
  onOpenChat: (chatId: string) => void;
}) {
  const { t } = useTranslation();
  const selectId = useId();
  const characters = useCharacters();
  const importChat = useImportStChat();
  const [header, setHeader] = useState<HeaderState>({ status: 'reading' });
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<ImportStChatResult | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setHeader({ status: 'reading' });
    setTouched(false);
    setResult(null);
    importChat.reset();
    void readStChatHeader(file).then((value) => {
      if (cancelled) return;
      setHeader(
        value ? { status: 'ready', characterName: value.characterName } : { status: 'unreadable' },
      );
    });
    return () => {
      cancelled = true;
    };
    // 只在换文件时重置（importChat.reset 是稳定引用）
  }, [file]);

  const matched = useMemo(() => {
    if (header.status !== 'ready' || !header.characterName) return null;
    const same = (characters.data ?? []).filter((item) => item.name === header.characterName);
    return same.length === 1 ? (same[0] ?? null) : null;
  }, [characters.data, header]);

  // 预选：用户还没动过下拉时跟着匹配结果走
  const selected = touched ? characterId : (matched?.id ?? null);
  const pending = importChat.isPending;

  const submit = () => {
    if (!file) return;
    importChat.mutate(
      { file, characterId: selected },
      {
        onSuccess: (data) => {
          if (data.warnings.length === 0) {
            onOpenChat(data.chat.id);
            onClose();
          } else {
            setResult(data);
          }
        },
      },
    );
  };

  const hint =
    header.status === 'unreadable'
      ? t('chat.transfer.unreadable')
      : header.status === 'ready' && header.characterName
        ? matched
          ? t('chat.transfer.matched', { name: header.characterName })
          : t('chat.transfer.unmatched', { name: header.characterName })
        : null;

  return (
    <Modal
      open={file !== null}
      onClose={onClose}
      dismissible={!pending}
      size="sm"
      title={result ? t('chat.transfer.doneTitle') : t('chat.transfer.importTitle')}
      footer={
        result ? (
          <Button
            size="sm"
            autoFocus
            onClick={() => {
              onOpenChat(result.chat.id);
              onClose();
            }}
          >
            {t('chat.transfer.open')}
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={submit} disabled={pending || header.status === 'reading'}>
              {pending ? t('chat.transfer.importing') : t('chat.transfer.submit')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div data-part="chat-import-result" className="space-y-3 text-sm">
          <p className="text-ink-2">
            {t('chat.transfer.doneSummary', {
              messages: result.messageCount,
              nodes: result.nodeCount,
            })}
          </p>
          <div>
            <p className="mb-1.5 text-ink-2">{t('chat.transfer.warnings')}</p>
            <ul className="edge-rule space-y-1.5 border-s ps-3 text-xs leading-relaxed text-ink-2">
              {result.warnings.map((warning, index) => (
                <li key={index} className="break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div data-part="chat-import-form" className="space-y-4">
          {file && (
            <p className="flex min-w-0 items-baseline gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate" title={file.name}>
                {file.name}
              </span>
              <span className="shrink-0 text-xs text-ink-3 tabular-nums">
                {formatSize(file.size)}
              </span>
            </p>
          )}
          <div>
            <FieldLabel htmlFor={selectId}>{t('chat.transfer.character')}</FieldLabel>
            <Select
              id={selectId}
              value={selected ?? ''}
              disabled={pending}
              onChange={(event) => {
                setTouched(true);
                setCharacterId(event.target.value || null);
              }}
            >
              <option value="">{t('chat.transfer.noCharacter')}</option>
              {(characters.data ?? []).map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </Select>
            {hint && <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{hint}</p>}
          </div>
          {importChat.error && (
            <p role="alert" className="text-sm break-all text-danger">
              {t('chat.transfer.importFailed', { message: errorMessage(importChat.error) })}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** 导出后的提示：有分支没导出 / 附件没写进文件 / 导出失败 */
export function ExportNoticeDialog({
  notice,
  onClose,
}: {
  notice: { result: ExportStChatResult } | { error: unknown } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={notice !== null}
      onClose={onClose}
      size="sm"
      title={notice && 'error' in notice ? t('common.export') : t('chat.transfer.exportedTitle')}
      footer={
        <Button size="sm" autoFocus onClick={onClose}>
          {t('common.dismiss')}
        </Button>
      }
    >
      {notice && 'error' in notice ? (
        <p role="alert" className="text-sm break-all text-danger">
          {t('chat.transfer.exportFailed', { message: errorMessage(notice.error) })}
        </p>
      ) : (
        <div className="space-y-2 text-sm text-ink-2">
          {notice && notice.result.droppedBranches > 0 && (
            <p>{t('chat.transfer.droppedBranches', { count: notice.result.droppedBranches })}</p>
          )}
          {notice && notice.result.skippedAttachments > 0 && (
            <p>
              {t('chat.transfer.skippedAttachments', { count: notice.result.skippedAttachments })}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
