import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/button';
import { Input, Select, Textarea } from '../../components/ui/field';
import {
  PERSONA_DESCRIPTION_POSITIONS,
  assetUrl,
  useCreatePersona,
  useDeletePersonaAvatar,
  useLorebooks,
  useUpdatePersona,
  useUploadPersonaAvatar,
  type Persona,
  type PersonaDescriptionPosition,
  type PersonaRole,
} from '../../lib/api';
import { useSignature } from '../../themes/signature';
import { errorMessage } from './shared';

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 10000;
const ROLES: PersonaRole[] = ['system', 'user', 'assistant'];

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

/** 新建 / 编辑用户档案。头像改动先留在表单里，保存时再上传或移除。 */
export function PersonaFormModal({
  persona,
  onClose,
}: {
  persona: Persona | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const { AvatarFrame } = useSignature();
  const lorebooks = useLorebooks();
  const createPersona = useCreatePersona();
  const updatePersona = useUpdatePersona();
  const uploadAvatar = useUploadPersonaAvatar();
  const deleteAvatar = useDeletePersonaAvatar();

  const [name, setName] = useState(persona?.name ?? '');
  const [title, setTitle] = useState(persona?.title ?? '');
  const [description, setDescription] = useState(persona?.description ?? '');
  const [position, setPosition] = useState<PersonaDescriptionPosition>(
    persona?.descriptionPosition ?? 'in_prompt',
  );
  const [depth, setDepth] = useState(String(persona?.depth ?? 2));
  const [role, setRole] = useState<PersonaRole>(persona?.role ?? 'system');
  const [lorebookId, setLorebookId] = useState(persona?.lorebookId ?? '');
  const [nameError, setNameError] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!avatarFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  const mutations = [createPersona, updatePersona, uploadAvatar, deleteAvatar];
  const pending = mutations.some((mutation) => mutation.isPending);
  const serverError = errorMessage(mutations.find((mutation) => mutation.error)?.error);

  const currentAssetId = avatarRemoved ? null : (persona?.avatarAssetId ?? null);
  const shownSrc = previewUrl ?? (currentAssetId ? assetUrl(currentAssetId) : null);
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!AVATAR_TYPES.includes(file.type)) {
      setAvatarError(t('library.personas.avatarBadType'));
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError(t('library.personas.avatarTooLarge'));
      return;
    }
    setAvatarError(null);
    setAvatarFile(file);
    setAvatarRemoved(false);
  };

  const removeAvatar = () => {
    setAvatarFile(null);
    setAvatarRemoved(true);
    setAvatarError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(true);
      return;
    }
    const parsedDepth = Number.parseInt(depth, 10);
    const input = {
      name: trimmed,
      title,
      description,
      descriptionPosition: position,
      depth: Number.isFinite(parsedDepth) ? Math.min(Math.max(parsedDepth, 0), MAX_DEPTH) : 2,
      role,
      lorebookId: lorebookId || null,
    };
    try {
      const saved = persona
        ? await updatePersona.mutateAsync({ id: persona.id, ...input })
        : await createPersona.mutateAsync(input);
      if (avatarFile) {
        await uploadAvatar.mutateAsync({ id: saved.id, file: avatarFile });
      } else if (avatarRemoved && persona?.avatarAssetId) {
        await deleteAvatar.mutateAsync(saved.id);
      }
      onClose();
    } catch {
      // 错误由 mutation.error 显示
    }
  };

  const books = lorebooks.data ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      dismissible={!pending}
      title={persona ? t('library.personas.editTitle') : t('library.personas.createTitle')}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={pending}>
            {pending ? t('common.processing') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        data-part="persona-form"
        onSubmit={(event) => void handleSubmit(event)}
        className="grid gap-5 sm:grid-cols-[7.5rem_minmax(0,1fr)]"
        noValidate
      >
        <div data-part="persona-avatar-field" className="flex flex-col items-center gap-2">
          <AvatarFrame role="user" className="flex size-24 items-center justify-center">
            {shownSrc ? (
              <img src={shownSrc} alt={name} className="size-full object-cover" />
            ) : (
              <span aria-hidden className="text-3xl font-medium select-none">
                {initial}
              </span>
            )}
          </AvatarFrame>
          <input
            ref={fileRef}
            type="file"
            accept={AVATAR_TYPES.join(',')}
            className="hidden"
            aria-label={t('library.personas.avatarUpload')}
            onChange={(event) => {
              pickFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <div className="flex flex-wrap justify-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => fileRef.current?.click()}
            >
              {shownSrc ? t('library.personas.avatarChange') : t('library.personas.avatarUpload')}
            </Button>
            {shownSrc && (
              <Button variant="ghost" size="sm" disabled={pending} onClick={removeAvatar}>
                {t('library.personas.avatarRemove')}
              </Button>
            )}
          </div>
          <p className="text-center text-xs text-ink-3">{t('library.personas.avatarHint')}</p>
          {avatarError && (
            <p role="alert" className="text-center text-xs text-danger">
              {avatarError}
            </p>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor={`${formId}-name`} className="block text-sm font-medium">
                {t('library.personas.name')}
              </label>
              <Input
                id={`${formId}-name`}
                value={name}
                autoFocus
                maxLength={200}
                disabled={pending}
                placeholder={t('library.personas.namePlaceholder')}
                aria-invalid={nameError}
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError) setNameError(false);
                }}
              />
              {nameError && (
                <p className="text-xs text-danger">{t('library.personas.nameRequired')}</p>
              )}
            </div>
            <Field label={t('library.personas.title')} htmlFor={`${formId}-title`}>
              <Input
                id={`${formId}-title`}
                value={title}
                maxLength={200}
                disabled={pending}
                placeholder={t('library.personas.titlePlaceholder')}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
          </div>

          <Field label={t('library.personas.description')} htmlFor={`${formId}-description`}>
            <Textarea
              id={`${formId}-description`}
              value={description}
              rows={8}
              disabled={pending}
              placeholder={t('library.personas.descriptionPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-32"
            />
          </Field>

          <Field label={t('library.personas.position')} htmlFor={`${formId}-position`}>
            <Select
              id={`${formId}-position`}
              value={position}
              disabled={pending}
              onChange={(event) => setPosition(event.target.value as PersonaDescriptionPosition)}
            >
              {PERSONA_DESCRIPTION_POSITIONS.map((item) => (
                <option key={item} value={item}>
                  {t(`library.personas.positions.${item}`)}
                </option>
              ))}
            </Select>
          </Field>

          {position === 'at_depth' && (
            <div data-part="persona-depth-fields" className="grid grid-cols-2 gap-4">
              <Field
                label={t('library.personas.depth')}
                htmlFor={`${formId}-depth`}
                hint={t('library.personas.depthHint')}
              >
                <Input
                  id={`${formId}-depth`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_DEPTH}
                  step={1}
                  value={depth}
                  disabled={pending}
                  onChange={(event) => setDepth(event.target.value)}
                />
              </Field>
              <Field label={t('library.personas.role')} htmlFor={`${formId}-role`}>
                <Select
                  id={`${formId}-role`}
                  value={role}
                  disabled={pending}
                  onChange={(event) => setRole(event.target.value as PersonaRole)}
                >
                  {ROLES.map((item) => (
                    <option key={item} value={item}>
                      {t(`library.personas.roles.${item}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          <Field
            label={t('library.personas.lorebook')}
            htmlFor={`${formId}-lorebook`}
            hint={t('library.personas.lorebookHint')}
          >
            <Select
              id={`${formId}-lorebook`}
              value={lorebookId}
              disabled={pending || lorebooks.isPending}
              onChange={(event) => setLorebookId(event.target.value)}
            >
              <option value="">{t('library.personas.lorebookNone')}</option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.name}
                </option>
              ))}
              {/* 绑定的书不在列表里（比如还在加载）时也保留选中值 */}
              {lorebookId && !books.some((book) => book.id === lorebookId) && (
                <option value={lorebookId}>{lorebookId}</option>
              )}
            </Select>
          </Field>

          {serverError && (
            <p role="alert" className="text-sm text-danger">
              {serverError}
            </p>
          )}
        </div>
      </form>
    </Modal>
  );
}
