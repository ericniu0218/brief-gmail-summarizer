'use client';

import { useCallback, useEffect, useState } from 'react';

const THEME_KEY = 'brief-theme';
const PROMPT_KEY = 'brief-theme-prompted';

/** Applies and remembers the global color theme plus the one-time prompt state. */
function applyTheme(darkMode: boolean) {
  // The root class drives CSS variables, while colorScheme also updates native controls.
  document.documentElement.classList.toggle('dark', darkMode);
  document.documentElement.style.colorScheme = darkMode ? 'dark' : 'light';
}

export function useTheme() {
  const [darkMode, setDarkModeState] = useState(
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('dark'),
  );
  const [showThemePrompt, setShowThemePrompt] = useState(false);

  useEffect(() => {
    // Read browser storage after mount, then show the question only if it has never been
    // answered. Light remains the default when no choice exists.
    let storedTheme: string | null = null;
    let hasAnsweredPrompt = false;
    try {
      storedTheme = window.localStorage.getItem(THEME_KEY);
      hasAnsweredPrompt = window.localStorage.getItem(PROMPT_KEY) === 'true';
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
    const prefersDark = storedTheme === 'dark';
    applyTheme(prefersDark);
    const updateState = window.setTimeout(() => {
      setDarkModeState(prefersDark);
      setShowThemePrompt(!hasAnsweredPrompt);
    }, 0);
    return () => window.clearTimeout(updateState);
  }, []);

  const setDarkMode = useCallback((enabled: boolean) => {
    // A choice applies immediately even when storage is unavailable for this browser.
    setDarkModeState(enabled);
    applyTheme(enabled);
    try {
      window.localStorage.setItem(THEME_KEY, enabled ? 'dark' : 'light');
      window.localStorage.setItem(PROMPT_KEY, 'true');
    } catch {
      // The theme still applies for the current visit when storage is unavailable.
    }
    setShowThemePrompt(false);
  }, []);

  return { darkMode, setDarkMode, showThemePrompt };
}
