import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/booking-request", () => ({
  purgeExpiredBookingRequests: vi.fn(),
}));

vi.mock("@/lib/club-post-retention", () => ({
  runClubPostCleanup: vi.fn(),
}));

// Same reason as the retention stub above: unmocked this would reach the real
// sharer, which reads posts through prisma and would then try to call the
// central server.
vi.mock("@/lib/club-post-sharing", () => ({
  retryPendingShares: vi.fn(),
}));

vi.mock("@/lib/club-post-mirror", () => ({
  runMirrorSync: vi.fn(),
}));

vi.mock("@/lib/cron-additional-payment-reminders", () => ({
  sendAdditionalPaymentReminders: vi.fn(),
}));

vi.mock("@/lib/cron-confirm-pending", () => ({
  confirmPendingBookings: vi.fn(),
}));

vi.mock("@/lib/cron-group-settlement-reaper", () => ({
  reapStaleGroupSettlements: vi.fn(),
}));

vi.mock("@/lib/cron-job-run", () => ({
  recordCronJobRunSafe: vi.fn(),
}));

vi.mock("@/lib/cron-policy-exception-hold-reaper", () => ({
  reapExpiredPolicyExceptionHolds: vi.fn(),
}));

vi.mock("@/lib/cron-pre-arrival-reminders", () => ({
  sendPreArrivalReminders: vi.fn(),
}));

vi.mock("@/lib/placeholder-guest-name-reminders", () => ({
  sendPlaceholderGuestNameReminders: vi.fn(),
}));

vi.mock("@/lib/cron-quote-expiry-reminders", () => ({
  sendQuoteExpiryReminders: vi.fn(),
}));

vi.mock("@/lib/school-attendee-confirmation", () => ({
  sendSchoolAttendeeConfirmationPrompts: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import { runGeneralCronCycle } from "@/lib/general-cron-runner";
import { resetObservabilityBridgeForTests } from "@/lib/observability-bridge";

describe("general cron runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetObservabilityBridgeForTests();
  });

  it("records every job in the shared general cron cycle", async () => {
    const recordCronRun = vi.fn();
    const result = await runGeneralCronCycle({
      recordCronRun,
      tasks: {
        // #2576: the same-owner coverage drain, stubbed here and in the failure
        // cycle below for the same reason every other task is — the runner's job
        // is to record an outcome per job, not to reach a database.
        drainHostingCoverageReevaluations: vi.fn(async () => ({
          claimed: 0,
          processed: 0,
          incidentsOpened: 0,
          incidentsUpdated: 0,
          incidentsResolved: 0,
          notified: 0,
          failed: 0,
        })),
        // #2999. Stubbed like every other job here: unstubbed it would call the
        // real cleanup, which reads settings through prisma -- so the suite
        // would pass wherever a database happened to be running and fail in CI.
        runClubPostCleanup: vi.fn(async () => ({
          skipped: "disabled" as const,
          deleted: 0,
        })),
        retryPendingShares: vi.fn(async () => ({
          attempted: 0,
          shared: 0,
          failed: 0,
          withdrawalsAttempted: 0,
          withdrawalsConfirmed: 0,
          withdrawalsFailed: 0,
        })),
        runMirrorSync: vi.fn(async () => ({
          skipped: "not-configured" as const,
          upserted: 0,
          removed: 0,
          pages: 0,
        })),
        sendAdditionalPaymentReminders: vi.fn(async () => ({
          reminderDays: 3,
          finalReminderDaysBeforeCheckIn: 2,
          chaseStartsAt: new Date("2026-08-01T00:00:00.000Z"),
          initialSentBookingIds: ["booking-9"],
          finalSentBookingIds: [],
          skippedBookingIds: [],
          suppressedBookingIds: [],
          failedBookingIds: [],
        })),
        confirmPendingBookings: vi.fn(async () => ({
          confirmedBookingIds: ["booking-1"],
          bumpedBookingIds: [],
          partialBumpedBookingIds: [],
          failedBookingIds: [],
          cancelledBookingIds: [],
        })),
        reapStaleGroupSettlements: vi.fn(async () => ({
          scanned: 1,
          reaped: 1,
          releasedChildBookings: 2,
          expiredSettlements: 0,
          cancelledChildBookings: 0,
          scannedInterruptedCancels: 0,
          resumedInterruptedCancels: 0,
        })),
        // #2553: the abandoned policy-exception capacity-hold reaper.
        reapExpiredPolicyExceptionHolds: vi.fn(async () => ({
          scanned: 2,
          expired: 1,
          releasedNights: 3,
          failed: 0,
          unresolvable: 0,
        })),
        sendPreArrivalReminders: vi.fn(async () => ({
          reminderDays: 3,
          windowStart: "2026-06-28",
          windowEndExclusive: "2026-07-02",
          sentBookingIds: ["booking-1"],
          skippedBookingIds: [],
          failedBookingIds: [],
        })),
        purgeExpiredBookingRequests: vi.fn(async () => ({
          declinedPurged: 1,
          neverVerifiedPurged: 2,
          // #2263 / OD-B: member-withdrawn (CANCELLED) requests now purge on
          // the same 90-day clock.
          memberWithdrawnPurged: 0,
        })),
        sendQuoteExpiryReminders: vi.fn(async () => ({
          remindedCount: 1,
          failedCount: 0,
          releasedHoldCount: 0,
        })),
        sendSchoolAttendeeConfirmationPrompts: vi.fn(async () => ({
          scanned: 0,
          sent: 0,
          failed: 0,
        })),
        // #2550: the whole-lodge placeholder guest-name chase.
        sendPlaceholderGuestNameReminders: vi.fn(async () => ({
          scanned: 2,
          sent: 1,
          skipped: 1,
          failed: 0,
        })),
      },
    });

    expect(result.confirmPending?.confirmedBookingIds).toEqual(["booking-1"]);
    expect(result.additionalPaymentReminders?.initialSentBookingIds).toEqual([
      "booking-9",
    ]);
    expect(result.preArrivalReminders?.sentBookingIds).toEqual(["booking-1"]);
    expect(result.bookingRequestPurge).toEqual({
      declinedPurged: 1,
      neverVerifiedPurged: 2,
      // #2263 / OD-B: member-withdrawn (CANCELLED) requests purge on the same
      // 90-day clock, so the cycle result carries their count too.
      memberWithdrawnPurged: 0,
    });
    expect(result.quoteExpiryReminders).toEqual({
      remindedCount: 1,
      failedCount: 0,
      releasedHoldCount: 0,
    });
    expect(result.groupSettlementReap).toEqual({
      scanned: 1,
      reaped: 1,
      releasedChildBookings: 2,
      expiredSettlements: 0,
      cancelledChildBookings: 0,
      scannedInterruptedCancels: 0,
      resumedInterruptedCancels: 0,
    });
    expect(result.policyExceptionHoldReap).toEqual({
      scanned: 2,
      expired: 1,
      releasedNights: 3,
      failed: 0,
      unresolvable: 0,
    });
    expect(result.schoolAttendeeConfirmations).toEqual({
      scanned: 0,
      sent: 0,
      failed: 0,
    });
    expect(result.placeholderGuestNameReminders).toEqual({
      scanned: 2,
      sent: 1,
      skipped: 1,
      failed: 0,
    });
    // One per job in GENERAL_CRON_JOB_NAMES. Two lanes each added a job in the
    // same window (#2550's placeholder guest-name reminders and #2553's hold
    // reaper), and this literal is where a merge that keeps both branches' job
    // registrations but only one branch's count shows up.
    expect(recordCronRun).toHaveBeenCalledTimes(13);
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "club-post-retention",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "additional-payment-reminders",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "group-settlement-reaper",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "confirm-pending",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "policy-exception-hold-reaper",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "pre-arrival-reminders",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "purge-booking-requests",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "quote-expiry-reminders",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "school-attendee-confirmations",
        status: "SUCCESS",
      })
    );
    // #2550
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "placeholder-guest-name-reminders",
        status: "SUCCESS",
      })
    );
    // #2576
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "hosting-coverage-reevaluation",
        status: "SUCCESS",
      })
    );
  });

  it("continues through independent jobs and reports failures after recording each outcome", async () => {
    const recordCronRun = vi.fn();
    const sendPreArrivalReminders = vi.fn(async () => ({
      reminderDays: 3,
      windowStart: "2026-06-28",
      windowEndExclusive: "2026-07-02",
      sentBookingIds: [],
      skippedBookingIds: [],
      failedBookingIds: [],
    }));
    const purgeExpiredBookingRequests = vi.fn(async () => ({
      declinedPurged: 0,
      memberWithdrawnPurged: 0,
      neverVerifiedPurged: 0,
    }));
    const sendQuoteExpiryReminders = vi.fn(async () => ({
      remindedCount: 0,
      failedCount: 0,
      releasedHoldCount: 0,
    }));
    const reapStaleGroupSettlements = vi.fn(async () => ({
      scanned: 0,
      reaped: 0,
      releasedChildBookings: 0,
      expiredSettlements: 0,
      cancelledChildBookings: 0,
      scannedInterruptedCancels: 0,
      resumedInterruptedCancels: 0,
    }));
    const sendSchoolAttendeeConfirmationPrompts = vi.fn(async () => ({
      scanned: 0,
      sent: 0,
      failed: 0,
    }));
    const sendPlaceholderGuestNameReminders = vi.fn(async () => ({
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    }));
    const sendAdditionalPaymentReminders = vi.fn(async () => ({
      reminderDays: 3,
      finalReminderDaysBeforeCheckIn: 2,
      chaseStartsAt: new Date("2026-08-01T00:00:00.000Z"),
      initialSentBookingIds: [],
      finalSentBookingIds: [],
      skippedBookingIds: [],
      suppressedBookingIds: [],
      failedBookingIds: [],
    }));

    await expect(
      runGeneralCronCycle({
        recordCronRun,
        tasks: {
          // #2576: the same-owner coverage drain, stubbed here for the same reason
          // every other task is — the runner's job is to record an outcome per
          // job, not to reach a database.
          drainHostingCoverageReevaluations: vi.fn(async () => ({
            claimed: 0,
            processed: 0,
            incidentsOpened: 0,
            incidentsUpdated: 0,
            incidentsResolved: 0,
            notified: 0,
            failed: 0,
          })),
          runClubPostCleanup: vi.fn(async () => ({
            skipped: "disabled" as const,
            deleted: 0,
          })),
          retryPendingShares: vi.fn(async () => ({
            attempted: 0,
            shared: 0,
            failed: 0,
            withdrawalsAttempted: 0,
            withdrawalsConfirmed: 0,
            withdrawalsFailed: 0,
          })),
          runMirrorSync: vi.fn(async () => ({
            skipped: "not-configured" as const,
            upserted: 0,
            removed: 0,
            pages: 0,
          })),
          sendAdditionalPaymentReminders,
          confirmPendingBookings: vi.fn(async () => {
            throw new Error("database unavailable");
          }),
          reapStaleGroupSettlements,
          sendPreArrivalReminders,
          purgeExpiredBookingRequests,
          sendQuoteExpiryReminders,
          sendSchoolAttendeeConfirmationPrompts,
          sendPlaceholderGuestNameReminders,
        },
      })
    ).rejects.toMatchObject({
      failures: [
        { jobName: "confirm-pending", message: "database unavailable" },
      ],
    });

    expect(sendAdditionalPaymentReminders).toHaveBeenCalled();
    expect(reapStaleGroupSettlements).toHaveBeenCalled();
    expect(sendPreArrivalReminders).toHaveBeenCalled();
    expect(purgeExpiredBookingRequests).toHaveBeenCalled();
    expect(sendQuoteExpiryReminders).toHaveBeenCalled();
    expect(sendSchoolAttendeeConfirmationPrompts).toHaveBeenCalled();
    expect(sendPlaceholderGuestNameReminders).toHaveBeenCalled();
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "confirm-pending",
        status: "FAILURE",
        error: "database unavailable",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "quote-expiry-reminders",
        status: "SUCCESS",
      })
    );
    // The failed task bridges to Sentry exactly once (scoped + deduped per job).
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        fingerprint: ["cron", "confirm-pending"],
        tags: expect.objectContaining({ scope: "cron", operation: "confirm-pending" }),
      })
    );
  });
});
