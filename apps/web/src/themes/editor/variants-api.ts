import { useEffect } from 'react';

import { useSetSetting, useSetting } from '../../lib/api';
import { syncVariantStyles } from '../apply';
import { registerVariants, THEMES } from '../registry';
import { parseVariantList, type ThemeVariant } from '../variants';

/** settings KV：全部变体（M4（二）§C.2）；读出来逐项校验，坏的丢掉 */
export const THEME_VARIANTS_KEY = 'themeVariants';

const normalize = (value: unknown): ThemeVariant[] => parseVariantList(value, THEMES);

export const useThemeVariants = () => useSetting(THEME_VARIANTS_KEY, normalize);
export const useSaveThemeVariants = () => useSetSetting(THEME_VARIANTS_KEY, normalize);

/**
 * 应用外壳里调用一次：把 settings 里的变体注册进 registry 并写好样式表。
 * 返回列表本身，给 applyTheme 的 effect 作依赖（变体改了要重新套一次）。
 */
export function useRegisterThemeVariants(): readonly ThemeVariant[] | undefined {
  const variants = useThemeVariants();
  useEffect(() => {
    registerVariants(variants.data ?? []);
    syncVariantStyles();
  }, [variants.data]);
  return variants.data;
}
