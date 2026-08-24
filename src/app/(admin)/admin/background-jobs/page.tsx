"use client";

import { BackLink } from "@/components/admin/back-link";
import { RefreshCw } from "lucide-react";
import { useClubTime } from "@/components/club-time-provider";
import { useHealthData } from "../health/_components/use-health-data";
import { BackgroundJobsSection } from "../health/_components/background-jobs-section";

export default function BackgroundJobsPage() {
  // `lastRefresh` is a real INSTANT — the moment the health payload was
  // fetched — so it is shown in the club's persisted zone, not the viewer's
  // (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  const { data, loading, error, lastRefresh, refresh } = useHealthData();

  return (
    <div className="p-6 space-y-6">
      <div>
        <BackLink href="/admin/health" label="System Health" />
        <div className="flex items-center justify-between mt-2">
          <h1 className="text-2xl font-bold text-foreground">Background Jobs</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              Last refresh: {clubTime.instantTime(lastRefresh)}
            </span>
            <button
              onClick={refresh}
              // KNOWN FLAT HOVER (#2144 owner decision): `--muted` and
              // `--accent` share a value in app scope, so `bg-muted
              // hover:bg-accent` currently shows no visible hover step here
              // (and at the other converted `bg-muted hover:bg-accent` button
              // sites). Deliberately left for #2181's structural token split
              // rather than a per-site bandaid.
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-muted hover:bg-accent rounded-md transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Scheduled cron job health, run history, and failures.
        </p>
      </div>

      {loading && !data ? (
        <div className="animate-pulse space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-32 bg-muted rounded-lg" />
          ))}
        </div>
      ) : error && !data ? (
        <div className="bg-danger-3 border border-danger-6 rounded-lg p-4 text-danger-11">
          Failed to load health data: {error}
        </div>
      ) : data ? (
        <BackgroundJobsSection cronJobs={data.cronJobs} cronHealth={data.cronHealth} />
      ) : null}
    </div>
  );
}
