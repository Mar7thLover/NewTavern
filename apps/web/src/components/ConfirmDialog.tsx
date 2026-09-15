import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Modal } from './Modal';
import { Button } from './ui/button';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  /** 危险操作（删除）用红色确认按钮 */
  destructive?: boolean;
  /** 进行中：禁用按钮、禁止关闭 */
  pending?: boolean;
  /** 失败信息（通常是服务端 message） */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  pending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      dismissible={!pending}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
            disabled={pending}
            autoFocus
          >
            {pending ? t('common.processing') : (confirmLabel ?? t('common.confirm'))}
          </Button>
        </>
      }
    >
      {description && <div className="text-sm text-ink-2">{description}</div>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
