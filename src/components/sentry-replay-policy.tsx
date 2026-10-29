"use client";

import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";

import { SENTRY_REPLAY_POLICY_PATH } from "@/lib/privacy-retention-replay";

/** Replay has no integration or buffer until the club explicitly enables it. */
export function SentryReplayPolicy({ enabled: supplied }: { enabled?: boolean }) {
  const [resolved, setResolved] = useState(false);
  // Read at runtime, rather than capturing the club setting in a static page.
  useEffect(() => {
    if (supplied !== undefined) return;
    let alive = true;
    fetch(SENTRY_REPLAY_POLICY_PATH, { cache: "no-store" })
      .then(response => response.ok ? response.json() : null)
      .then(value => { if (alive) setResolved(value?.enabled === true); })
      .catch(() => { if (alive) setResolved(false); });
    return () => { alive = false; };
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
