import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
// Be Vietnam Pro, self-hosted (no request to Google Fonts). Each weight file covers the
// vietnamese + latin subsets via unicode-range, so browsers only download what a page uses.
import "@fontsource/be-vietnam-pro/400.css";
import "@fontsource/be-vietnam-pro/500.css";
import "@fontsource/be-vietnam-pro/600.css";
import "@fontsource/be-vietnam-pro/700.css";
import "./globals.css";
import { THEME_COOKIE, parseTheme } from "./theme";

export const metadata: Metadata = {
  title: "Email MKT Tracker",
  description: "Internal email marketing tool",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The theme is rendered on the server from a cookie, so there is no flash of the wrong theme.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="vi" data-theme={theme === "system" ? undefined : theme}>
      <body>{children}</body>
    </html>
  );
}
