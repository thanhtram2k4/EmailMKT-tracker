/** Theme preference: "system" follows prefers-color-scheme; the others force a theme. */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = "emt-theme";

export function parseTheme(v: string | undefined): Theme {
  return (THEMES as readonly string[]).includes(v ?? "") ? (v as Theme) : "system";
}
