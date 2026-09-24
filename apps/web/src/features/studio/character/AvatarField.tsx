import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ImageCropperDialog, type CropResult } from '../../../components/ImageCropper';
import { Button } from '../../../components/ui/button';
import {
  deleteCharacterAvatar,
  uploadCharacterAvatar,
  type StudioCharacterDetail,
} from '../../../lib/api-studio';
import { Avatar, errorMessage } from '../../library/shared';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif';

/**
 * 裁切结果转成 PNG：导出 PNG 以头像为底图，服务端没有图像解码，只有 PNG 头像能当底图
 * （M6 §6 ST 修正 8）。裁切器优先出 WebP，这里再画一遍转 PNG。
 */
export async function cropResultToPng(result: CropResult): Promise<File> {
  if (result.type === 'image/png') {
    return new File([result.blob], 'avatar.png', { type: 'image/png' });
  }
  const bitmap = await createImageBitmap(result.blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas 2d unavailable');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encode failed');
    return new File([blob], 'avatar.png', { type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

/** 头像：显示 + 上传（裁切、转 PNG）/ 移除。头像不在 data 里，改完直接生效，不进草稿 */
export function AvatarField({
  characterId,
  detail,
  name,
  onDetail,
}: {
  characterId: string;
  detail: StudioCharacterDetail | undefined;
  name: string;
  onDetail: (detail: StudioCharacterDetail) => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropSource, setCropSource] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assetId = detail?.avatarAssetId ?? null;

  const run = async (task: () => Promise<StudioCharacterDetail>) => {
    setBusy(true);
    setError(null);
    try {
      onDetail(await task());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <Avatar
        name={name || '?'}
        assetId={assetId}
        className="size-20 shrink-0"
        textClassName="text-2xl"
      />
      <div className="min-w-0 space-y-2">
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) setCropSource(file);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {assetId ? t('studio.character.avatarReplace') : t('studio.character.avatarUpload')}
          </Button>
          {assetId && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => deleteCharacterAvatar(characterId))}
            >
              {t('studio.character.avatarRemove')}
            </Button>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-ink-3">{t('studio.character.avatarHint')}</p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>

      {cropSource && (
        <ImageCropperDialog
          source={cropSource}
          guide="none"
          onCancel={() => setCropSource(null)}
          onReselect={() => fileRef.current?.click()}
          onConfirm={(result) => {
            setCropSource(null);
            void run(async () => uploadCharacterAvatar(characterId, await cropResultToPng(result)));
          }}
        />
      )}
    </div>
  );
}
