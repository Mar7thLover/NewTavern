import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  classifyFile,
  MAX_ATTACHMENT_BYTES,
  type AttachmentKind,
} from '../../components/AttachmentFiles';
import { ApiError, uploadAsset, type UploadedAsset } from '../../lib/api';

/* ------------------------------------------------------------------ */
/* 托盘状态                                                             */
/* ------------------------------------------------------------------ */

export type TrayItemStatus = 'uploading' | 'done' | 'error';

/** 本地判定的失败原因；服务端给了文案时用服务端的 */
export type TrayErrorReason = 'unsupported' | 'tooLarge' | 'failed';

export interface TrayItem {
  key: string;
  file: File;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** 图片的本地预览（object URL），上传完成前就能看到 */
  previewUrl: string | null;
  status: TrayItemStatus;
  /** 0–1 */
  progress: number;
  asset: UploadedAsset | null;
  error: { reason: TrayErrorReason; message: string | null } | null;
  /** 413 / 415 这类重试也没用的失败不给重试键 */
  retryable: boolean;
}

export interface AttachmentTray {
  items: TrayItem[];
  add: (files: Iterable<File>) => void;
  remove: (key: string) => void;
  retry: (key: string) => void;
  /** 发送后清空（不撤销已上传的资产：它们已经挂在消息上） */
  clear: () => void;
  uploading: boolean;
  failed: boolean;
  /** 已上传完成的资产 id，按托盘顺序 */
  assetIds: string[];
  /** 同上，带这次上传的文件名（去重命中旧资产时，消息里显示这次的名字） */
  attachments: { id: string; name: string }[];
}

let keySeed = 0;

/**
 * 输入托盘：选中 / 粘贴 / 拖入的文件立刻开始上传，托盘显示进度，失败可重试。
 * `resetKey` 变化（换对话）时清空托盘并中止未完成的上传。
 */
export function useAttachmentTray(resetKey: string): AttachmentTray {
  const [items, setItems] = useState<TrayItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  const patch = useCallback((key: string, update: Partial<TrayItem>) => {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...update } : item)),
    );
  }, []);

  const start = useCallback(
    (key: string, file: File) => {
      controllers.current.get(key)?.abort();
      const controller = new AbortController();
      controllers.current.set(key, controller);
      patch(key, { status: 'uploading', progress: 0, error: null, retryable: true });
      let lastTick = 0;
      uploadAsset(file, {
        signal: controller.signal,
        onProgress: (fraction) => {
          // 进度事件很密，按 ~10 帧/秒更新就够了
          const now = performance.now();
          if (now - lastTick < 100 && fraction < 1) return;
          lastTick = now;
          patch(key, { progress: fraction });
        },
      }).then(
        (asset) => {
          if (controllers.current.get(key) !== controller) return;
          controllers.current.delete(key);
          patch(key, { status: 'done', progress: 1, asset });
        },
        (error: unknown) => {
          if (controller.signal.aborted || controllers.current.get(key) !== controller) return;
          controllers.current.delete(key);
          const status = error instanceof ApiError ? error.status : 0;
          const reason: TrayErrorReason =
            status === 413 ? 'tooLarge' : status === 415 ? 'unsupported' : 'failed';
          const message =
            error instanceof ApiError && error.status > 0 && error.code !== undefined
              ? error.message
              : null;
          patch(key, {
            status: 'error',
            error: { reason, message: reason === 'failed' ? message : null },
            retryable: reason === 'failed',
          });
        },
      );
    },
    [patch],
  );

  const add = useCallback(
    (files: Iterable<File>) => {
      const next: TrayItem[] = [];
      for (const file of files) {
        const kind = classifyFile(file);
        const key = `att-${Date.now().toString(36)}-${(keySeed++).toString(36)}`;
        const base: TrayItem = {
          key,
          file,
          name: file.name || 'image',
          size: file.size,
          kind: kind ?? 'text',
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : null,
          status: 'uploading',
          progress: 0,
          asset: null,
          error: null,
          retryable: false,
        };
        if (kind === null) {
          next.push({
            ...base,
            status: 'error',
            error: { reason: 'unsupported', message: null },
          });
        } else if (file.size > MAX_ATTACHMENT_BYTES) {
          next.push({ ...base, status: 'error', error: { reason: 'tooLarge', message: null } });
        } else {
          next.push(base);
        }
      }
      if (next.length === 0) return;
      setItems((current) => [...current, ...next]);
      for (const item of next) if (item.status === 'uploading') start(item.key, item.file);
    },
    [start],
  );

  const remove = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setItems((current) => {
      const target = current.find((item) => item.key === key);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.key !== key);
    });
  }, []);

  const retry = useCallback(
    (key: string) => {
      const target = itemsRef.current.find((item) => item.key === key);
      if (target && target.retryable) start(key, target.file);
    },
    [start],
  );

  const clear = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    for (const item of itemsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setItems([]);
  }, []);

  // 换对话：清空；卸载：中止上传、释放预览
  useEffect(() => clear, [resetKey, clear]);

  return useMemo(() => {
    const attachments: { id: string; name: string }[] = [];
    let uploading = false;
    let failed = false;
    for (const item of items) {
      if (item.status === 'uploading') uploading = true;
      else if (item.status === 'error') failed = true;
      else if (item.asset)
        attachments.push({ id: item.asset.id, name: item.asset.name || item.name });
    }
    const assetIds = attachments.map((attachment) => attachment.id);
    return { items, add, remove, retry, clear, uploading, failed, assetIds, attachments };
  }, [items, add, remove, retry, clear]);
}
