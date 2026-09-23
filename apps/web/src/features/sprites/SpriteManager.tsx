import { FileArchive, ImagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DEFAULT_EXPRESSIONS,
  normalizeSpriteLabel,
  spriteUrl,
  useDeleteSprite,
  useImportSpriteZip,
  useSprites,
  useUploadSprite,
  type SpriteImportResult,
} from './api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif';

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 角色立绘管理（M4（二）§B.3）：逐张上传 / 替换 / 删除，或导入 ST 的立绘包（zip，文件名即标签）。
 * 工作台的角色卡编辑器复用它。
 */
export function SpriteManager({ characterId }: { characterId: string }) {
  const { t } = useTranslation();
  const sprites = useSprites(characterId);
  const upload = useUploadSprite(characterId);
  const remove = useDeleteSprite(characterId);
  const importZip = useImportSpriteZip(characterId);
  const [label, setLabel] = useState('');
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [result, setResult] = useState<SpriteImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const listId = useId();

  const list = sprites.data ?? [];
  const normalized = normalizeSpriteLabel(label);
  const missing = DEFAULT_EXPRESSIONS.filter((name) => !list.some((item) => item.label === name));

  const pick = (target: string) => {
    setPendingLabel(target);
    fileInput.current?.click();
  };

  return (
    <div data-part="sprite-manager" className="space-y-3">
      <input
        ref={fileInput}
        type="file"
        accept={IMAGE_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file && pendingLabel) {
            upload.mutate(
              { label: pendingLabel, file },
              { onSuccess: () => setLabel('') },
            );
          }
        }}
      />
      <input
        ref={zipInput}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) importZip.mutate(file, { onSuccess: setResult });
        }}
      />

      {list.length > 0 ? (
        <ul data-part="sprite-list" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {list.map((sprite) => (
            <li key={sprite.label} data-part="sprite-list-item" className="min-w-0">
              <div className="rounded-control edge-rule relative aspect-[3/4] overflow-hidden border">
                <img
                  src={spriteUrl(sprite.assetId)}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  className="absolute inset-0 size-full object-contain object-bottom"
                />
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px]" title={sprite.label}>
                  {sprite.label}
                </span>
                <IconButton
                  size="xs"
                  label={t('sprites.replace', { label: sprite.label })}
                  onClick={() => pick(sprite.label)}
                >
                  <RefreshCw aria-hidden />
                </IconButton>
                <IconButton
                  size="xs"
                  variant="destructive"
                  label={t('sprites.delete', { label: sprite.label })}
                  onClick={() => remove.mutate(sprite.label)}
                >
                  <Trash2 aria-hidden />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        !sprites.isPending && <p className="text-xs text-ink-2">{t('sprites.empty')}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-32">
          <Input
            size="sm"
            list={listId}
            value={label}
            placeholder={t('sprites.labelPlaceholder')}
            aria-label={t('sprites.label')}
            aria-invalid={label.trim() !== '' && normalized === null}
            onChange={(event) => setLabel(event.target.value)}
          />
          <datalist id={listId}>
            {missing.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={normalized === null || upload.isPending}
          onClick={() => normalized && pick(normalized)}
        >
          <ImagePlus aria-hidden className="size-3.5" />
          {t('sprites.add')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={importZip.isPending}
          onClick={() => zipInput.current?.click()}
        >
          <FileArchive aria-hidden className="size-3.5" />
          {importZip.isPending ? t('sprites.importing') : t('sprites.importZip')}
        </Button>
      </div>
      {label.trim() !== '' && normalized === null && (
        <p className="text-[11px] text-danger">{t('sprites.labelInvalid')}</p>
      )}
      <p className="text-[11px] leading-relaxed text-ink-3">{t('sprites.zipHint')}</p>

      {result && (
        <div data-part="sprite-import-result" className="text-[11px] leading-relaxed text-ink-2">
          <p>{t('sprites.importResult', { imported: result.imported.length, skipped: result.skipped.length })}</p>
          {result.skipped.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-ink-3">
              {result.skipped.slice(0, 8).map((item) => (
                <li key={item.file} className="truncate">
                  {item.file}：{item.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {[upload.error, remove.error, importZip.error].map(errorText).filter(Boolean).map((message) => (
        <p key={message} role="alert" className="text-[11px] text-danger">
          {message}
        </p>
      ))}
    </div>
  );
}
