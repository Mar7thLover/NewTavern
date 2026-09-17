import { Hono } from 'hono';

import type { Db } from '../db/client.js';
import { exportStChat } from '../services/chat-transfer.js';
import { sendDownload } from './download.js';

/**
 * 聊天导出为 SillyTavern jsonl（契约 M4 §2.2）。在 `app.ts` 里第二次挂到 `/chats` 下。
 * 响应头：`X-NT-Dropped-Branches`（没导出的分支数）、`X-NT-Skipped-Attachments`（没写进文件的附件数）。
 */
export function createChatTransferRoutes(db: Db) {
  return new Hono().get('/:id/export', (c) => {
    const file = exportStChat(db, c.req.param('id'));
    if (!file) return c.json({ error: 'not_found' }, 404);
    c.header('X-NT-Dropped-Branches', String(file.droppedBranches));
    c.header('X-NT-Skipped-Attachments', String(file.skippedAttachments));
    c.header('Access-Control-Expose-Headers', 'X-NT-Dropped-Branches, X-NT-Skipped-Attachments');
    return sendDownload(c, file);
  });
}
