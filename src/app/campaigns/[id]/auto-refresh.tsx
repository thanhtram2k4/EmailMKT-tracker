"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-render the server page every few seconds while a campaign is being processed. */
export function AutoRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return (
    <p className="muted small m0" aria-live="off">
      This page refreshes automatically while the campaign is being processed.
    </p>
  );
}
