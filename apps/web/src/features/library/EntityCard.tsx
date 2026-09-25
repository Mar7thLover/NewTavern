import { assetUrl } from '../../lib/api';

export interface EntityCardProps {
  name: string;
  /** 角色卡 / 世界书 / 预设；写进 data-kind 给主题用 */
  kind: string;
  /** 有头像时铺满上部，否则显示名字首字 */
  avatarAssetId?: string | null;
  /** 名字上方的一行小字（如「世界书」「预设」）；角色卡不给 */
  kicker?: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * 卡面：1px 线的 3:4 卡片，中间是 28/300 的名字首字（或头像），下方是名字；悬停时线变墨色。
 * 对话页开始界面与工作台首页共用。DOM 结构（button > span 画面 + span 文字）是六个世界
 * 主题的挂点（`[data-part='character-card'] > span:first-child > span` 等），放进网格时
 * 外面要包一层 `li`（暖房按 `li:nth-child` 轮换底色）。
 */
export function EntityCard({
  name,
  kind,
  avatarAssetId,
  kicker,
  disabled,
  onClick,
}: EntityCardProps) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  return (
    <button
      type="button"
      data-part="character-card"
      data-kind={kind}
      disabled={disabled}
      onClick={onClick}
      className="rounded-card edge-rule surface-reading focus-ring flex aspect-[3/4] w-full cursor-pointer flex-col overflow-hidden border text-left transition-colors hover:border-ink disabled:opacity-50"
    >
      <span className="flex min-h-0 flex-1 items-center justify-center">
        {avatarAssetId ? (
          <img
            src={assetUrl(avatarAssetId)}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <span
            aria-hidden
            data-part="character-card-initial"
            className="font-display text-[28px] leading-none font-light text-ink-story select-none"
          >
            {initial}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col px-3 pb-3">
        {kicker && (
          <span
            data-part="start-card-kicker"
            className="truncate text-[11px] tracking-wide text-ink-2"
          >
            {kicker}
          </span>
        )}
        <span data-part="character-card-name" className="truncate text-sm font-medium text-ink">
          {name}
        </span>
      </span>
    </button>
  );
}
