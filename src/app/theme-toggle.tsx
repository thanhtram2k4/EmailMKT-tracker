"use client";
import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { THEME_COOKIE, THEMES, type Theme } from "./theme";

const LABEL: Record<Theme, string> = { system: "Theo hệ thống", light: "Sáng", dark: "Tối" };
const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

/** Cycles system → light → dark. Stored in a cookie so the server renders the same theme. */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  const Icon = ICON[theme];
  return (
    <button
      type="button"
      className="btn ghost icon-btn"
      aria-label={`Giao diện: ${LABEL[theme]}. Chuyển sang: ${LABEL[next]}`}
      title={`Giao diện: ${LABEL[theme]}`}
      data-testid="theme-toggle"
      data-theme-value={theme}
      onClick={() => {
        setTheme(next);
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        if (next === "system") delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = next;
      }}
    >
      <Icon className="icon" aria-hidden />
    </button>
  );
}
