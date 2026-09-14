import { motion } from 'framer-motion';
import { Check, Copy, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Markdown } from './Markdown';
import { ReasoningBlock } from './ReasoningBlock';
import { SwipeBar } from './SwipeBar';
import { formatClock, siblingInfo } from './shared';
import type { DisplayRegexFn } from './useDisplayRegex';
import type { StreamBuffer } from '../../app/store/chat';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button } from '../../components/ui/button';
import { IconButton } from '../../components/ui/icon-button';
import { nodeText, useDeleteNode, usePatchNode, type MessageNode } from '../../lib/api';
import { cn, copyText } from '../../lib/utils';
import { Avatar, errorMessage } from '../library/shared';

const LONG_PRESS_MS = 450;

export interface MessageItemProps {
  chatId: string;
  node: MessageNode;
  /** 该聊天的全部节点，用于算兄弟与分叉 */
  nodes: readonly MessageNode[];
  displayName: string;
  avatarAssetId: string | null;
  /** 正在生成（禁用会改变树的操作） */
  busy: boolean;
  /** 本条正在流式输出时的缓冲 */
  stream: StreamBuffer | undefined;
  /** 距 head 的距离（0 = 最新），显示侧正则的 min/maxDepth 用 */
  depth: number;
  /** 显示侧正则；编辑框与复制仍用原文 */
  applyDisplayRegex: DisplayRegexFn;
  onSwitchSibling: (siblingId: string) => void;
  onRegenerate: (node: MessageNode) => void;
}

export function MessageItem({
  chatId,
  node,
  nodes,
  displayName,
  avatarAssetId,
  busy,
  stream,
  depth,
  applyDisplayRegex,
  onSwitchSibling,
  onRegenerate,
}: MessageItemProps) {
  const { t, i18n } = useTranslation();
  const patchNode = usePatchNode();
  const deleteNode = useDeleteNode();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);

  const isUser = node.role === 'user';
  const streaming = stream !== undefined;
  const text = streaming ? stream.text : nodeText(node);
  const reasoning = streaming ? stream.reasoning : (node.reasoning?.text ?? '');
  const { siblings, index, branched } = siblingInfo(nodes, node);
  // 渲染用文本：套显示侧正则。流式过程中每帧都要算，用 useMemo 挡一下。
  const displayText = useMemo(
    () => applyDisplayRegex(text, node.role, depth),
    [applyDisplayRegex, text, node.role, depth],
  );

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const startEdit = () => {
    setDraft(nodeText(node));
    setEditing(true);
  };

  const saveEdit = () => {
    patchNode.mutate(
      { chatId, nodeId: node.id, text: draft },
      { onSuccess: () => setEditing(false) },
    );
  };

  const clearPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const actionsVisible = touchOpen || editing;

  return (
    <motion.article
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={cn('group/msg', node.isHidden && 'opacity-50')}
      onTouchStart={() => {
        clearPress();
        pressTimer.current = window.setTimeout(() => setTouchOpen(true), LONG_PRESS_MS);
      }}
      onTouchEnd={clearPress}
      onTouchMove={clearPress}
      onTouchCancel={clearPress}
    >
      <div className={cn('flex min-w-0 gap-3', isUser && 'rounded-xl bg-card px-4 py-3')}>
        <Avatar
          name={displayName}
          assetId={avatarAssetId}
          className="size-9 rounded-full"
          textClassName="text-sm"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{displayName}</span>
            <time
              dateTime={node.createdAt}
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
            >
              {formatClock(node.createdAt, i18n.language)}
            </time>
          </div>

          <div className="mt-1.5 max-w-[72ch] min-w-0 text-[15px] leading-[1.75] break-words">
            {reasoning !== '' && (
              <ReasoningBlock reasoning={reasoning} streaming={streaming} hasText={text !== ''} />
            )}

            {editing ? (
              <EditBox
                value={draft}
                pending={patchNode.isPending}
                error={errorMessage(patchNode.error)}
                onChange={setDraft}
                onSave={saveEdit}
                onCancel={() => {
                  patchNode.reset();
                  setEditing(false);
                }}
              />
            ) : text === '' && !streaming ? (
              // 生成被中止 / 未产出文本：弱提示 + 就地重新生成
              <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground/70">
                <span className="italic">{t('chat.message.empty')}</span>
                {!isUser && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRegenerate(node)}
                    className="cursor-pointer text-primary underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
                  >
                    {t('chat.message.regenerate')}
                  </button>
                )}
              </p>
            ) : (
              <Markdown streaming={streaming}>{displayText === '' ? ' ' : displayText}</Markdown>
            )}
          </div>
        </div>
      </div>

      {/* 操作条放在卡片外，用左内边距对齐正文列，避免撑高用户消息卡 */}
      {!editing && (
        <div
          className={cn(
            'mt-0.5 flex h-7 min-w-0 items-center gap-0.5 transition-opacity duration-150',
            'group-hover/msg:opacity-100 focus-within:opacity-100',
            isUser ? 'ps-16' : 'ps-12',
            actionsVisible ? 'opacity-100' : 'opacity-0',
          )}
        >
          {!isUser && siblings.length > 0 && (
            <SwipeBar
              index={index}
              total={siblings.length}
              branched={branched}
              busy={busy}
              onPrev={() => {
                const target = siblings[index - 1];
                if (target) onSwitchSibling(target.id);
              }}
              onNext={() => {
                const target = siblings[index + 1];
                if (target) onSwitchSibling(target.id);
              }}
              onRegenerate={() => onRegenerate(node)}
            />
          )}
          {!isUser && siblings.length > 0 && (
            <span className="mx-1 h-4 w-px bg-border/70" aria-hidden />
          )}
          <IconButton
            label={copied ? t('chat.message.copied') : t('chat.message.copy')}
            size="xs"
            onClick={() => void copyText(text).then((ok) => setCopied(ok))}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </IconButton>
          <IconButton label={t('common.edit')} size="xs" disabled={streaming} onClick={startEdit}>
            <Pencil aria-hidden />
          </IconButton>
          <IconButton
            label={t('common.delete')}
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              deleteNode.reset();
              setConfirming(true);
            }}
          >
            <Trash2 aria-hidden />
          </IconButton>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        destructive
        title={t('chat.message.deleteTitle')}
        description={t('chat.message.deleteMessage')}
        confirmLabel={t('common.delete')}
        pending={deleteNode.isPending}
        error={errorMessage(deleteNode.error)}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          deleteNode.mutate({ chatId, nodeId: node.id }, { onSuccess: () => setConfirming(false) })
        }
      />
    </motion.article>
  );
}

/** 就地编辑：自适应高度、Ctrl/⌘+Enter 保存、Esc 取消 */
function EditBox({
  value,
  pending,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  pending: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  return (
    <div className="space-y-2">
      <textarea
        ref={ref}
        autoFocus
        value={value}
        disabled={pending}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave();
          }
        }}
        className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-[15px] leading-[1.75] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={pending}>
          {pending ? t('common.processing') : t('common.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {t('common.cancel')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('chat.message.editHint')}</span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
