import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { MigrationReview } from './MigrationReview';
import { MigrationRun, type RunState } from './MigrationRun';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input } from '../../components/ui/field';
import { ApiError } from '../../lib/api';
import {
  isUserChoice,
  runStMigration,
  useInvalidateAfterMigration,
  useMigrationAccess,
  useScanSt,
  type MigrationSelect,
  type StInventory,
  type StUserChoice,
} from '../../lib/api-migration';
import { cn } from '../../lib/utils';
import { LibraryHeader, QueryStatus, errorMessage } from '../library/shared';

const PATH_STORAGE_KEY = 'newtavern-migration-path';

function readStoredPath(): string {
  try {
    return localStorage.getItem(PATH_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storePath(value: string) {
  try {
    localStorage.setItem(PATH_STORAGE_KEY, value);
  } catch {
    // 隐私模式等：记不住也不影响
  }
}

type Stage =
  | { step: 'source' }
  | { step: 'review'; inventory: StInventory }
  | { step: 'run'; inventory: StInventory; select: MigrationSelect };

const STEPS = ['source', 'review', 'run'] as const;

/** ST 目录迁移向导（M4 契约 §2.4）：选文件夹 → 挑选 → 迁移 */
export function MigrationPage() {
  const { t } = useTranslation();
  const access = useMigrationAccess();

  return (
    <div data-part="migration-page" className="mx-auto max-w-3xl">
      <LibraryHeader title={t('migration.title')} subtitle={t('migration.subtitle')} />
      <QueryStatus
        isPending={access.isPending}
        error={access.error}
        onRetry={() => void access.refetch()}
      />
      {access.data?.access === 'forbidden' && (
        <div
          data-part="migration-forbidden"
          role="alert"
          className="rounded-card edge-rule border px-5 py-6"
        >
          <p className="font-medium">{t('migration.forbiddenTitle')}</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">{access.data.message}</p>
        </div>
      )}
      {access.data?.access === 'local' && <MigrationWizard />}
    </div>
  );
}

function MigrationWizard() {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>({ step: 'source' });
  const [run, setRun] = useState<RunState | null>(null);
  const invalidate = useInvalidateAfterMigration();

  const start = (inventory: StInventory, select: MigrationSelect) => {
    setStage({ step: 'run', inventory, select });
    setRun({ total: null, items: [], done: null, error: null });
    void runStMigration(inventory.root, select, {
      onStart: (total) => setRun((prev) => (prev ? { ...prev, total } : prev)),
      onItem: (item) => setRun((prev) => (prev ? { ...prev, items: [...prev.items, item] } : prev)),
      onDone: (done) => setRun((prev) => (prev ? { ...prev, done } : prev)),
    })
      .catch((error: unknown) => {
        const message =
          error instanceof ApiError && error.status === 0 ? null : errorMessage(error);
        setRun((prev) => (prev ? { ...prev, error: message ?? 'interrupted' } : prev));
      })
      .finally(() => void invalidate());
  };

  const activeIndex = STEPS.indexOf(stage.step);

  return (
    <>
      <ol
        data-part="migration-steps"
        aria-label={t('migration.steps.label')}
        className="mb-8 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      >
        {STEPS.map((step, index) => (
          <li
            key={step}
            data-part="migration-step"
            data-active={index === activeIndex}
            aria-current={index === activeIndex ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1.5',
              index === activeIndex
                ? 'font-medium text-accent'
                : index < activeIndex
                  ? 'text-ink-2'
                  : 'text-ink-3',
            )}
          >
            <span className="tabular-nums">{index + 1}</span>
            <span>{t(`migration.steps.${step}`)}</span>
            {index < STEPS.length - 1 && (
              <span aria-hidden className="ms-1.5 text-ink-3">
                ·
              </span>
            )}
          </li>
        ))}
      </ol>

      {stage.step === 'source' && (
        <SourceStep onInventory={(inventory) => setStage({ step: 'review', inventory })} />
      )}
      {stage.step === 'review' && (
        <MigrationReview
          inventory={stage.inventory}
          onBack={() => setStage({ step: 'source' })}
          onStart={(select) => start(stage.inventory, select)}
        />
      )}
      {stage.step === 'run' && run && (
        <MigrationRun state={run} onAgain={() => setStage({ step: 'source' })} />
      )}
    </>
  );
}

function SourceStep({ onInventory }: { onInventory: (inventory: StInventory) => void }) {
  const { t } = useTranslation();
  const [path, setPath] = useState(readStoredPath);
  const [users, setUsers] = useState<StUserChoice[] | null>(null);
  const scan = useScanSt();

  const runScan = (target: string) => {
    storePath(target);
    scan.mutate(target, {
      onSuccess: (result) => {
        if (isUserChoice(result)) {
          setUsers(result.users);
        } else {
          setUsers(null);
          onInventory(result);
        }
      },
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (path.trim()) runScan(path.trim());
  };

  return (
    <section data-part="migration-source" className="space-y-6">
      <form onSubmit={submit} className="space-y-2">
        <FieldLabel htmlFor="migration-path">{t('migration.source.label')}</FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="migration-path"
            value={path}
            placeholder={t('migration.source.placeholder')}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
            onChange={(event) => {
              setPath(event.target.value);
              setUsers(null);
            }}
          />
          <Button type="submit" className="shrink-0" disabled={scan.isPending || !path.trim()}>
            {scan.isPending ? t('migration.source.scanning') : t('migration.source.scan')}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-ink-2">{t('migration.source.hint')}</p>
        {scan.error && (
          <p role="alert" className="text-sm break-all text-danger">
            {errorMessage(scan.error)}
          </p>
        )}
      </form>

      {users && (
        <div data-part="migration-users" className="space-y-2">
          <p className="text-sm">{t('migration.source.users', { count: users.length })}</p>
          <ul className="edge-rule divide-y divide-edge border-y">
            {users.map((user) => (
              <li key={user.path}>
                <button
                  type="button"
                  disabled={scan.isPending}
                  onClick={() => {
                    setPath(user.path);
                    runScan(user.path);
                  }}
                  className="focus-ring-inset flex w-full cursor-pointer flex-col items-start gap-0.5 px-1 py-2.5 text-left hover:text-accent disabled:cursor-default"
                >
                  <span className="text-sm font-medium">{user.name}</span>
                  <span className="text-xs break-all text-ink-3">{user.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
