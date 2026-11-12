import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePersistentState } from './storage';
import { getTheme, setTheme as showTheme } from './themes';

interface Appearance {
  glow: boolean;
  motion: boolean;
}

interface AppearanceValue extends Appearance {
  setGlow: (on: boolean) => void;
  setMotion: (on: boolean) => void;
  /** Motion allowed by both the setting and the OS (prefers-reduced-motion) */
  animate: boolean;
  /** Folder of the theme, in src/themes (lib/themes.ts keeps it, apart from glow and motion) */
  theme: string;
  setTheme: (theme: string) => void;
}

const AppearanceContext = createContext<AppearanceValue | null>(null);

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = usePersistentState<Appearance>('synthway.appearance.v1', () => ({
    glow: true,
    motion: true,
  }));
  const reducedMotion = usePrefersReducedMotion();
  const [theme, setThemeState] = useState(getTheme);

  // theme.css reads these attributes
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.glow = appearance.glow ? 'on' : 'off';
    root.dataset.motion = appearance.motion ? 'on' : 'off';
  }, [appearance]);

  const value = useMemo<AppearanceValue>(
    () => ({
      ...appearance,
      animate: appearance.motion && !reducedMotion,
      setGlow: (glow) => setAppearance((current) => ({ ...current, glow })),
      setMotion: (motion) => setAppearance((current) => ({ ...current, motion })),
      theme,
      setTheme: (next) => {
        showTheme(next);
        setThemeState(getTheme());
      },
    }),
    [appearance, reducedMotion, setAppearance, theme],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceValue {
  const value = useContext(AppearanceContext);
  if (!value) {
    throw new Error('useAppearance must be used inside <AppearanceProvider>');
  }
  return value;
}
