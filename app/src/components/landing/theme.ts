export const THEME_KEY = "tesoro-landing-theme";
export type Theme = "dark" | "light";

/** The stored choice, else the system preference. Mirrors the pre-paint script in ThemeBoot. */
export function resolveTheme(): Theme {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {}
  if (stored === "light" || stored === "dark") return stored;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
