import { htmlScopeId } from '@newtavern/core';
import { motion } from 'framer-motion';
import { Check, Copy, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Markdown } from './Markdown';
import { ReasoningBlock } from './ReasoningBlock';
import { SwipeBar } from './SwipeBar';
import { formatClock, siblingInfo } from './shared';
import type { DisplayRegexFn } from './useDisplayRegex';
import { useRichText } from './useRichText';
import type { StreamBuffer } from '../../app/store/chat';
import {
  AttachmentDocumentList,
  AttachmentEditList,
  AttachmentImageGrid,
} from '../../components/AttachmentMedia';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { openLightbox } from '../../components/Lightbox';
import { Button } from '../../components/ui/button';
import { IconButton } from '../../components/ui/icon-button';
import {
  nodeMedia,
  nodeText,
  useDeleteNode,
  usePatchNode,
  type DocumentPart,
  type ImagePart,
  type MediaPart,
  type MessageNode,
} from '../../lib/api';
import { cn, copyText } from '../../lib/utils';
import { slotSeconds } from '../../themes/apply';
import { MessageOrnamentLayer, useSignature } from '../../themes/signature';
import { Avatar, errorMessage } from '../library/shared';

const LONG_PRESS_MS = 450;

/** 正文按 parts 顺序切成的块：相邻的文本合并，相邻的图片成一个网格，相邻的文档成一排小片 */
type BodySegment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'images'; key: string; images: ImagePart[]; offset: number }
  | { kind: 'documents'; key: string; documents: DocumentPart[] };

function toSegments(parts: MessageNode['parts']): BodySegment[] {
  const segments: BodySegment[] = [];
  let imageCount = 0;
  parts.forEach((part, index) => {
    const last = segments[segments.length - 1];
    if (part.type === 'text') {
      if (last?.kind === 'text') last.text += part.text;
      else segments.push({ kind: 'text', key: `t${index}`, text: part.text });
    } else if (part.type === 'image') {
      if (last?.kind === 'images') last.images.push(part);
      else segments.push({ kind: 'images', key: `i${index}`, images: [part], offset: imageCount });
      imageCount++;
    } else if (part.type === 'document') {
      if (last?.kind === 'documents') last.documents.push(part);
      else segments.push({ kind: 'documents', key: `d${index}`, documents: [part] });
    }
  });
  return segments;
}

export interface MessageItemProps {
  chatId: string;
  node: MessageNode;
  /** 在 root→head 路径里的下标（从 0 起） */
  index: number;
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
  index: pathIndex,
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
  const { StreamingCursor } = useSignature();
  const patchNode = usePatchNode();
  const deleteNode = useDeleteNode();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  /** 编辑态里保留下来的附件（移除的就不在里面了） */
  const [draftMedia, setDraftMedia] = useState<MediaPart[]>([]);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);

  const isUser = node.role === 'user';
  const streaming = stream !== undefined;
  const text = streaming ? stream.text : nodeText(node);
  const reasoning = streaming ? stream.reasoning : (node.reasoning?.text ?? '');
  const { siblings, index, branched } = siblingInfo(nodes, node);

  // 正文块：流式中是「全部文本 + 已收到的图片」，结束后按节点 parts 的最终顺序
  const streamImages = stream?.images;
  const segments = useMemo<BodySegment[]>(() => {
    if (!streaming) return toSegments(node.parts);
    const live: BodySegment[] = [{ kind: 'text', key: 'stream', text }];
    if (streamImages && streamImages.length > 0) {
      live.push({ kind: 'images', key: 'stream-images', images: streamImages, offset: 0 });
    }
    return live;
  }, [streaming, node.parts, text, streamImages]);
  const images = useMemo(
    () => segments.flatMap((segment) => (segment.kind === 'images' ? segment.images : [])),
    [segments],
  );
  const hasMedia = segments.some((segment) => segment.kind !== 'text');
  const lastTextKey = segments.findLast((segment) => segment.kind === 'text')?.key;

  // 渲染用文本：先套显示侧正则，再做正文美化。流式过程中每帧都要算，用 useMemo 挡一下。
  const rich = useRichText();
  const richTransform = rich.transform;
  const displayTexts = useMemo(
    () =>
      segments.map((segment) =>
        segment.kind === 'text'
          ? richTransform(applyDisplayRegex(segment.text, node.role, depth))
          : '',
      ),
    [applyDisplayRegex, richTransform, segments, node.role, depth],
  );
  /** 卡自带 `<style>` 的作用域名：一条消息一个，两条消息的 CSS 不会互相打架 */
  const scopeId = useMemo(() => htmlScopeId(node.id), [node.id]);

  const openImage = (imageIndex: number) =>
    openLightbox(
      images.map((image) => ({
        assetId: image.assetId,
        mime: image.mime,
        ...(image.name ? { name: image.name } : {}),
      })),
      imageIndex,
    );

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const startEdit = () => {
    setDraft(nodeText(node));
    setDraftMedia(nodeMedia(node));
    setEditing(true);
  };

  const saveEdit = () => {
    const before = nodeMedia(node).map((part) => part.assetId);
    const after = draftMedia.map((part) => part.assetId);
    const mediaChanged = before.length !== after.length || before.some((id, i) => id !== after[i]);
    patchNode.mutate(
      { chatId, nodeId: node.id, text: draft, ...(mediaChanged ? { attachments: after } : {}) },
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
      // 出现只做透明度：位移由主题自己在 CSS 里加（素：无滑入）
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: slotSeconds('--dur-panel') }}
      data-part="message"
      data-role={node.role}
      data-index={pathIndex}
      data-streaming={streaming}
      // relative：装饰层（MessageOrnament）以消息为定位参照
      className={cn('group/msg relative', node.isHidden && 'opacity-50')}
      onTouchStart={() => {
        clearPress();
        pressTimer.current = window.setTimeout(() => setTouchOpen(true), LONG_PRESS_MS);
      }}
      onTouchEnd={clearPress}
      onTouchMove={clearPress}
      onTouchCancel={clearPress}
    >
      <MessageOrnamentLayer role={node.role} id={node.id} index={pathIndex} />

      <div data-part="message-row" className="flex min-w-0 gap-3">
        <Avatar
          name={displayName}
          assetId={avatarAssetId}
          role={isUser ? 'user' : node.role === 'system' ? 'system' : 'character'}
          className="size-9"
          textClassName="text-sm"
        />
        <div data-part="message-main" className="min-w-0 flex-1">
          {/* 名字 13px 墨色 + 时间戳 11px tabular 灰，中间 8px，左对齐 */}
          <div data-part="message-header" className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{displayName}</span>
            <time
              dateTime={node.createdAt}
              className="shrink-0 text-[11px] text-ink-3 tabular-nums"
            >
              {formatClock(node.createdAt, i18n.language)}
            </time>
          </div>

          <div className="mt-1.5 max-w-[var(--story-measure)] min-w-0">
            {reasoning !== '' && (
              <ReasoningBlock reasoning={reasoning} streaming={streaming} hasText={text !== ''} />
            )}

            {/* 故事正文容器：叙述用 --ink-story，对白由 Markdown 着成 --ink-quote，靠明度区分 */}
            <div
              data-part="message-body"
              className="font-story text-story leading-story min-w-0 break-words text-ink-story"
            >
              {editing ? (
                <EditBox
                  value={draft}
                  media={draftMedia}
                  onRemoveMedia={(mediaIndex) =>
                    setDraftMedia((current) => current.filter((_, i) => i !== mediaIndex))
                  }
                  pending={patchNode.isPending}
                  error={errorMessage(patchNode.error)}
                  onChange={setDraft}
                  onSave={saveEdit}
                  onCancel={() => {
                    patchNode.reset();
                    setEditing(false);
                  }}
                />
              ) : text === '' && !hasMedia && !streaming ? (
                // 生成被中止 / 未产出文本：弱提示 + 就地重新生成
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
                  <span className="italic">{t('chat.message.empty')}</span>
                  {!isUser && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onRegenerate(node)}
                      className="cursor-pointer text-accent underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
                    >
                      {t('chat.message.regenerate')}
                    </button>
                  )}
                </p>
              ) : (
                segments.map((segment, segmentIndex) => {
                  if (segment.kind === 'text') {
                    const display = displayTexts[segmentIndex] ?? '';
                    const isStreamTarget = streaming && segment.key === lastTextKey;
                    // 只有附件的消息（纯图片）里，空的文本块不占位
                    if (display.trim() === '' && !isStreamTarget && hasMedia) return null;
                    return (
                      <div key={segment.key} className="mt-3 first:mt-0">
                        <Markdown
                          streaming={isStreamTarget}
                          cursor={<StreamingCursor kind="text" />}
                          html={rich.html}
                          scopeId={scopeId}
                        >
                          {display === '' ? ' ' : display}
                        </Markdown>
                      </div>
                    );
                  }
                  if (segment.kind === 'images') {
                    return (
                      <AttachmentImageGrid
                        key={segment.key}
                        images={segment.images}
                        onOpen={(imageIndex) => openImage(segment.offset + imageIndex)}
                        className="mt-3 first:mt-0"
                      />
                    );
                  }
                  return (
                    <AttachmentDocumentList
                      key={segment.key}
                      documents={segment.documents}
                      className="mt-3 first:mt-0"
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 操作条放在卡片外，用左内边距对齐正文列，避免撑高用户消息卡 */}
      {!editing && (
        <div
          data-part="message-actions"
          data-visible={actionsVisible}
          className={cn(
            'mt-0.5 flex h-7 min-w-0 items-center gap-0.5 transition-opacity',
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
            <span className="edge-rule mx-1.5 h-4 border-s" aria-hidden />
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
  media,
  onRemoveMedia,
  pending,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  /** 这条消息的附件：编辑时可移除，保存时一并提交 */
  media: MediaPart[];
  onRemoveMedia: (index: number) => void;
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
        className="field font-story text-story leading-story w-full resize-none px-3 py-2"
      />
      <AttachmentEditList media={media} onRemove={onRemoveMedia} />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={pending}>
          {pending ? t('common.processing') : t('common.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {t('common.cancel')}
        </Button>
        <span className="text-xs text-ink-2">{t('chat.message.editHint')}</span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
