"use client";

import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";

import { SENTRY_REPLAY_POLICY_CHANGED, SENTRY_REPLAY_POLICY_PATH } from "@/lib/privacy-retention-replay";

/** Replay has no integration or buffer until the club explicitly enables it. */
export function SentryReplayPolicy({ enabled: supplied }: { enabled?: boolean }) {
  const [resolved, setResolved] = useState(false);
  // Read at runtime, rather than capturing the club setting in a static page.
  useEffect(() => {
    if (supplied !== undefined) return;
    let alive = true;
    let generation = 0;
    const refresh = async () => {
      const requestGeneration = ++generation;
      let enabled = false;
      try {
        const response = await fetch(SENTRY_REPLAY_POLICY_PATH, { cache: "no-store" });
        enabled = response.ok && (await response.json())?.enabled === true;
      } catch { /* Unavailable policy means off, including for existing recorders. */ }
      if (alive && generation === requestGeneration) setResolved(enabled);
    };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    void refresh();
    // Root layouts survive navigation. Recheck open tabs as well as newly loaded
    // pages, and apply this tab's settings save without waiting for the timer.
    const timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", refresh);
    window.addEventListener(SENTRY_REPLAY_POLICY_CHANGED, refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(SENTRY_REPLAY_POLICY_CHANGED, refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [supplied]);
  const enabled = supplied ?? resolved;
  useEffect(() => {
    if (!enabled || !process.env.NEXT_PUBLIC_SENTRY_DSN) {
      void Sentry.getReplay()?.stop();
      return;
    }
    if (!Sentry.getReplay()) {
      Sentry.addIntegration(Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }));
    }
    Sentry.getReplay()?.start();
    return () => { void Sentry.getReplay()?.stop(); };
  }, [enabled]);
  return null;
}
