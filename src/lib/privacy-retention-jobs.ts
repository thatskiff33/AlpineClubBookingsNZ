import "server-only";
import type { PrismaClient } from "@prisma/client";
import type { CronJobRunStatus, RecordCronJobRunInput } from "@/lib/cron-job-run";
import { runRecordedCronTask } from "@/lib/cron-recorded-task";
import logger from "@/lib/logger";
import { FORMER_MEMBER_ANONYMISATION_JOB_NAME } from "@/lib/privacy-retention-shared";
import { prisma } from "@/lib/prisma";
import { getPrivacyRetentionSettings, PRIVACY_RETENTION_SETTINGS_ID } from "@/lib/privacy-retention-settings";
import { privacyRetentionSelection, selectFormerMemberBatch, RETENTION_BATCH_SIZE } from "@/lib/privacy-retention-selection";
import { anonymiseFormerMember } from "@/lib/privacy-retention-anonymise";

const CLAIM_LIFETIME_MS = 60 * 60 * 1000;
type JobOptions = { now?: Date; db?: PrismaClient };
export type PrivacyRetentionResult = {
  skipped?: "disabled" | "busy";
  deletedEmailLogs: number; deletedApplications: number; anonymised: number; blocked: number;
  /** Members whose transaction threw: counted in `blocked` too, but they fail the run (#4920). */
  failed: number;
};
const empty = (): PrivacyRetentionResult => ({ deletedEmailLogs: 0, deletedApplications: 0, anonymised: 0, blocked: 0, failed: 0 });

/**
 * A member whose transaction threw is held back like a blocked one, but unlike a
 * member with open money it is a fault nobody would otherwise see. The run is
 * recorded FAILURE with this message (admin cron health reads it) and reported
 * once per run, never per member. Counts only: no member data.
 */
export function privacyRetentionFailureMessage(result: PrivacyRetentionResult): string | null {
  return result.failed
    ? `${result.failed} former member(s) could not be anonymised because their transaction failed; the logs name each member id.`
    : null;
}
export function privacyRetentionRunStatus(result: PrivacyRetentionResult): CronJobRunStatus {
  if (result.skipped) return "SKIPPED";
  return privacyRetentionFailureMessage(result) ? "FAILURE" : "SUCCESS";
}

async function runClaimed(
  kind: "prune" | "anonymise", { now = new Date(), db = prisma }: JobOptions,
): Promise<PrivacyRetentionResult> {
  const result = empty();
  const settings = await getPrivacyRetentionSettings(db);
  const enabledField = kind === "prune" ? "pruneLogsAndApplicationsEnabled" : "anonymiseMembersEnabled";
  const claimField = kind === "prune" ? "pruneStartedAt" : "anonymiseStartedAt";
  if (!settings[enabledField]) return { ...result, skipped: "disabled" };
  const claimed = await db.privacyRetentionSettings.updateMany({
    where: {
      id: PRIVACY_RETENTION_SETTINGS_ID, [enabledField]: true,
      OR: [{ [claimField]: null }, { [claimField]: { lt: new Date(now.getTime() - CLAIM_LIFETIME_MS) } }],
    }, data: { [claimField]: now },
  });
  if (claimed.count !== 1) return { ...result, skipped: "busy" };
  try {
    const selection = await privacyRetentionSelection(settings, now);
    if (kind === "prune") {
      // Each bounded delete rechecks the selection: a concurrent application
      // review cannot turn a selected rejection into an approved row we delete.
      for (const target of ["emailLogs", "rejectedApplications"] as const) {
        for (;;) {
          const count = await db.$transaction(async tx => {
            if (!(await getPrivacyRetentionSettings(tx))[enabledField]) return 0;
            if (target === "emailLogs") {
              const rows = await tx.emailLog.findMany({ where: selection.emailLogs, select: { id: true }, orderBy: { id: "asc" }, take: RETENTION_BATCH_SIZE });
              return (await tx.emailLog.deleteMany({ where: { AND: [selection.emailLogs, { id: { in: rows.map(row => row.id) } }] } })).count;
            }
            const rows = await tx.memberApplication.findMany({ where: selection.rejectedApplications, select: { id: true }, orderBy: { id: "asc" }, take: RETENTION_BATCH_SIZE });
            return (await tx.memberApplication.deleteMany({ where: { AND: [selection.rejectedApplications, { id: { in: rows.map(row => row.id) } }] } })).count;
          });
          if (target === "emailLogs") result.deletedEmailLogs += count;
          else result.deletedApplications += count;
          if (count < RETENTION_BATCH_SIZE) break;
        }
      }
    } else {
      let afterId: string | undefined;
      for (;;) {
        const batch = await selectFormerMemberBatch(db, selection.formerMembers, afterId);
        for (const row of batch) {
          if (row.reasons.length) { result.blocked++; continue; }
          try {
            // INV-LOCK-005: default READ COMMITTED sees commits made while awaiting locks.
            const done = await db.$transaction(async tx => {
              if (!(await getPrivacyRetentionSettings(tx)).anonymiseMembersEnabled) return false;
              return anonymiseFormerMember(tx, row.id, selection.formerMembers, now);
            }, { timeout: 15_000 });
            if (done) result.anonymised++; else result.blocked++;
          } catch (err) {
            logger.error({ err, memberId: row.id, job: FORMER_MEMBER_ANONYMISATION_JOB_NAME }, "Former-member anonymisation failed; member blocked for this run");
            result.blocked++;
            result.failed++;
          }
        }
        const last = batch.at(-1);
        if (!last || batch.length < RETENTION_BATCH_SIZE) break;
        afterId = last.id;
      }
    }
    return result;
  } finally {
    // A stale worker cannot release its successor's lease.
    await db.privacyRetentionSettings.updateMany({
      where: { id: PRIVACY_RETENTION_SETTINGS_ID, [claimField]: now }, data: { [claimField]: null },
    });
  }
}

export function runPersonalDataPruneJob(options: JobOptions = {}) {
  return runClaimed("prune", options);
}
export function runFormerMemberAnonymisationJob(options: JobOptions = {}) {
  return runClaimed("anonymise", options);
}

/**
 * The nightly cron step for one retention job: records its CronJobRun row and
 * throws on failure so the caller's step reports it to Sentry. A run whose
 * members failed (#4920) is recorded FAILURE with the count-only message and
 * reported once, after every member has been tried.
 */
export async function runRecordedPrivacyRetentionJob(
  jobName: string, work: () => Promise<PrivacyRetentionResult>,
  recordCronRun?: (input: RecordCronJobRunInput) => Promise<void> | void,
): Promise<void> {
  const outcome = await runRecordedCronTask({
    jobName, work, recordCronRun,
    statusFor: privacyRetentionRunStatus, errorFor: privacyRetentionFailureMessage,
  });
  if (!outcome.ok) throw outcome.error;
  const memberFailures = privacyRetentionFailureMessage(outcome.result);
  if (memberFailures) throw new Error(memberFailures);
}
