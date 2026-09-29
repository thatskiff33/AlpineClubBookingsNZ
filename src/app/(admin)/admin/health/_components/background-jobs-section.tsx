"use client";

import { Clock } from "lucide-react";
import {
  StatusBadge,
  CronError,
  CronResultSummary,
  formatDate,
  formatOptionalDate,
} from "./shared";
import { useClubTime } from "@/components/club-time-provider";
import type { HealthData } from "./types";

export function BackgroundJobsSection({
  cronJobs,
  cronHealth,
}: {
  cronJobs: HealthData["cronJobs"];
  cronHealth: HealthData["cronHealth"];
}) {
  // Cron run stamps are real INSTANTS, shown in the club's persisted zone
  // (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
        <Clock className="h-5 w-5" />
        Cron Jobs
      </h2>
      {cronHealth?.timezoneRestartRequired ? (
        <div className="mb-3 rounded-lg border border-warning-6 bg-warning-2 p-4 text-sm">
          <p className="font-semibold">
            These jobs are still running on the old time zone
          </p>
          <p className="mt-1 text-muted-foreground">
            The club time zone was changed to{" "}
            <span className="font-medium">{cronHealth.configuredTimezone}</span>
            , but the scheduled jobs below were set up when the application last
            started and are still firing on{" "}
            <span className="font-medium">{cronHealth.runningTimezone}</span>.
            Every &ldquo;expected&rdquo; time on this page is the time they fire
            today. Restart the application to move them onto{" "}
            {cronHealth.configuredTimezone}.
          </p>
        </div>
      ) : null}
      {(cronHealth
        ? cronHealth.jobs.length === 0
        : Object.keys(cronJobs).length === 0) ? (
        <div className="bg-card border rounded-lg p-4 text-muted-foreground">
          No cron job runs recorded yet.
        </div>
      ) : (
        <div className="space-y-4">
          {cronHealth?.jobs.map((job) => {
            const runs = cronJobs[job.jobName] ?? [];

            return (
              <div key={job.jobName} className="bg-card border rounded-lg">
                <div className="p-4 border-b bg-muted">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium text-foreground">{job.label}</h3>
                        <span className="font-mono text-xs text-muted-foreground">
                          {job.jobName}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">{job.summary}</p>
                    </div>
                    <StatusBadge status={job.status} />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Schedule</p>
                      <p className="font-mono text-muted-foreground break-words">
                        {job.schedule}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Expected</p>
                      <p className="text-muted-foreground">{job.expectedLocalTime}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Timezone</p>
                      <p className="text-muted-foreground">{job.timezone}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Stale threshold</p>
                      <p className="text-muted-foreground">
                        {job.staleThreshold ?? "Not tracked"}
                      </p>
                    </div>
                  </div>
                  {(job.disabledReason || job.note) && (
                    <div className="mt-3 text-sm text-muted-foreground space-y-1">
                      {job.disabledReason && <p>{job.disabledReason}</p>}
                      {job.note && <p>{job.note}</p>}
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 text-xs text-muted-foreground">
                    <p>Latest run: {formatOptionalDate(clubTime, job.latestRunAt)}</p>
                    <p>Latest success: {formatOptionalDate(clubTime, job.latestSuccessAt)}</p>
                    <p>Latest failure: {formatOptionalDate(clubTime, job.latestFailureAt)}</p>
                  </div>
                </div>
                <div className="divide-y">
                  {!job.recordsRuns ? (
                    <div className="p-3 text-sm text-muted-foreground">
                      CronJobRun history is not recorded for this scheduled job.
                    </div>
                  ) : runs.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground">
                      No cron runs recorded yet.
                    </div>
                  ) : (
                    runs.map((run) => (
                      <div key={run.id} className="p-3 flex items-center justify-between text-sm">
                        <div className="flex items-center gap-3">
                          <StatusBadge status={run.status} />
                          <span className="text-muted-foreground">{formatDate(clubTime, run.startedAt)}</span>
                        </div>
                        <div className="flex items-center gap-4 text-muted-foreground">
                          {run.durationMs != null && <span>{run.durationMs}ms</span>}
                          {run.error && <CronError error={run.error} />}
                          {run.resultSummary && <CronResultSummary summary={run.resultSummary} />}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          }) ??
            Object.entries(cronJobs).map(([jobName, runs]) => (
              <div key={jobName} className="bg-card border rounded-lg">
                <div className="p-4 border-b bg-muted">
                  <h3 className="font-medium text-foreground">{jobName}</h3>
                </div>
                <div className="divide-y">
                  {runs.map((run) => (
                    <div key={run.id} className="p-3 flex items-center justify-between text-sm">
                      <div className="flex items-center gap-3">
                        <StatusBadge status={run.status} />
                        <span className="text-muted-foreground">{formatDate(clubTime, run.startedAt)}</span>
                      </div>
                      <div className="flex items-center gap-4 text-muted-foreground">
                        {run.durationMs != null && <span>{run.durationMs}ms</span>}
                        {run.error && <CronError error={run.error} />}
                        {run.resultSummary && <CronResultSummary summary={run.resultSummary} />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
