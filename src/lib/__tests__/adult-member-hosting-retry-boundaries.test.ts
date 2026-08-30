import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";

import { stripComments } from "./support/strip-comments";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
} from "@/lib/adult-member-hosting-queue-participants";

function readRepoCode(relativePath: string): string {
  return stripComments(readFileSync(path.resolve(process.cwd(), relativePath), "utf8"));
}

function sourceFilesNaming(identifier: string): string[] {
  const root = path.resolve(process.cwd(), "src");
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(fullPath);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        if (readRepoCode(path.relative(process.cwd(), fullPath)).includes(identifier)) {
          found.push(path.relative(process.cwd(), fullPath).split(path.sep).join("/"));
        }
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("adult-member hosting participant retry responses (#2597)", () => {
  it("uses the fixed safe 409 body and cannot be overridden by recovery metadata", async () => {
    const response = hostingCoverageParticipantRetryResponse(
      { cause: { code: HOSTING_COVERAGE_RETRY_CODE } },
      {
        error: "unsafe override",
        code: "unsafe_override",
        paymentReceived: true,
      },
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      paymentReceived: true,
    });
  });

  it("does not downgrade an unrelated error that merely has the same message", () => {
    expect(
      hostingCoverageParticipantRetryResponse(
        new Error(HOSTING_COVERAGE_RETRY_MESSAGE),
      ),
    ).toBeNull();
  });

  it("pins every explicit interactive response boundary tree-wide", () => {
    expect(sourceFilesNaming("hostingCoverageParticipantRetryResponse")).toEqual([
      "src/app/api/admin/booking-exception-requests/[id]/route.ts",
      "src/app/api/admin/booking-requests/[id]/approve/route.ts",
      "src/app/api/admin/booking-requests/[id]/decline/route.ts",
      "src/app/api/admin/booking-requests/[id]/hold/route.ts",
      "src/app/api/admin/booking-requests/[id]/release-hold/route.ts",
      "src/app/api/admin/booking-requests/[id]/send-quote/route.ts",
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
      "src/app/api/admin/bookings/[id]/force-confirm/route.ts",
      "src/app/api/admin/bookings/[id]/mark-paid/route.ts",
      "src/app/api/admin/bookings/[id]/review/route.ts",
      "src/app/api/admin/deletion-requests/[id]/route.ts",
      "src/app/api/admin/member-lifecycle-action-requests/[requestId]/route.ts",
      "src/app/api/admin/members/[id]/xero-link/route.ts",
      "src/app/api/admin/members/[id]/xero-push/route.ts",
      "src/app/api/admin/members/[id]/xero-unlink/route.ts",
      "src/app/api/admin/members/bulk-update/route.ts",
      "src/app/api/admin/membership-cancellation-requests/[requestId]/participants/[participantId]/route.ts",
      "src/app/api/admin/subscriptions/[id]/manual-payment/route.ts",
      "src/app/api/admin/xero/force-sync/route.ts",
      "src/app/api/admin/xero/import-member-contact/route.ts",
      "src/app/api/booking-requests/respond/[token]/route.ts",
      "src/app/api/bookings/[id]/cancel/route.ts",
      "src/app/api/bookings/[id]/confirm-draft/route.ts",
      "src/app/api/bookings/[id]/confirm-payment/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/consent/route.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/app/api/bookings/[id]/guests/route.ts",
      "src/app/api/bookings/[id]/modify-dates/route.ts",
      "src/app/api/bookings/[id]/modify/route.ts",
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
      "src/app/api/bookings/route.ts",
      "src/app/api/group-bookings/[code]/settle/route.ts",
      "src/app/api/group-bookings/join/verify/[token]/route.ts",
      "src/app/api/payments/charge-saved-method/route.ts",
      "src/app/api/payments/create-payment-intent/route.ts",
      "src/lib/adult-member-hosting-retry-response.ts",
    ]);
  });

  it("maps only the quote POST and preserves automated retry boundaries", () => {
    const quoteRoute = readRepoCode(
      "src/app/api/booking-requests/respond/[token]/route.ts",
    );
    const postStart = quoteRoute.indexOf("export async function POST(");
    expect(quoteRoute.slice(0, postStart)).not.toContain(
      "hostingCoverageParticipantRetryResponse(",
    );
    expect(quoteRoute.slice(postStart)).toContain(
      "hostingCoverageParticipantRetryResponse(err)",
    );

    for (const automated of [
      "src/lib/cron-confirm-pending.ts",
      "src/lib/cron-group-settlement-reaper.ts",
      "src/lib/stripe-webhook-service.ts",
      "src/lib/xero-inbound/invoice-paid-effects.ts",
      "src/lib/xero-operation-outbox.ts",
    ]) {
      expect(readRepoCode(automated), automated).not.toContain(
        "hostingCoverageParticipantRetryResponse(",
      );
    }
  });

  it("preserves truthful partial-completion and captured-money recovery flags", () => {
    const expected: Record<string, readonly string[]> = {
      "src/app/api/admin/bookings/[id]/review/route.ts": [
        "reviewRecorded: true",
        "cancellationPending: true",
      ],
      "src/app/api/admin/booking-requests/[id]/decline/route.ts": [
        "requestDeclined: true",
        "holdReleasePending: err.holdReleasePending",
        "holdReleaseStatusUnconfirmed: err.holdReleaseStatusUnconfirmed",
      ],
      "src/app/api/admin/deletion-requests/[id]/route.ts": [
        "deletionCleanupRecovery({",
        'cancellationFact.state === "PENDING" ? booking.id : null',
        'cancellationFact.state === "STATUS_UNCONFIRMED"',
        "remainingCleanupPending: true",
        "memberAnonymised: false",
        "memberDataAnonymised: false",
        "approvalReceiptSent: false",
      ],
      "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts": [
        "paymentReceived: true",
        "finalisationPending: true",
      ],
      "src/app/api/bookings/[id]/confirm-payment/route.ts": [
        "paymentReceived: true",
        "finalisationPending: true",
      ],
      "src/app/api/payments/charge-saved-method/route.ts": [
        "paymentReceived: true",
        "finalisationPending: true",
        "isAuthorizedCron && hostingParticipantRetry",
      ],
      "src/app/api/payments/create-payment-intent/route.ts": [
        "receivedPaymentIntentId = existingIntent.id",
        "paymentReceived: true",
        "finalisationPending: true",
      ],
      // #2623 T4/T8: phase one consumed the offer, so a phase-two refusal must
      // say so — the flags ride the frozen retry body when the compensating
      // release worked, and the awaiting-operator body when it could not run.
      "src/app/api/bookings/[id]/waitlist-confirm/route.ts": [
        "WAITLIST_OFFER_RELEASED_FLAGS",
        "WAITLIST_OFFER_CONSUMED_STATUS_MOVED_FLAGS",
        "WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY",
        "WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION",
      ],
    };
    for (const [file, fragments] of Object.entries(expected)) {
      const source = readRepoCode(file);
      for (const fragment of fragments) expect(source, file).toContain(fragment);
    }
    expect(
      readRepoCode("src/app/api/payments/create-payment-intent/route.ts"),
    ).not.toMatch(
      /hostingCoverageParticipantRetryResponse\(\s*error,[\s\S]{0,180}paymentIntentId:/,
    );
    expect(
      readRepoCode("src/app/api/payments/charge-saved-method/route.ts"),
    ).not.toMatch(
      /hostingCoverageParticipantRetryResponse\(\s*error,[\s\S]{0,180}paymentIntentId:/,
    );
  });

  it("pins the service-return boundaries that do not use NextResponse directly", () => {
    const memberDetail = readRepoCode("src/lib/admin-member-detail-service.ts");
    expect(memberDetail).toMatch(
      /isHostingCoverageParticipantRetry\(error\)[\s\S]*?jsonResult\(HOSTING_COVERAGE_RETRY_BODY,\s*\{ status: 409 \}\)/,
    );

    for (const file of ["src/lib/waitlist.ts", "src/lib/waitlist-cross-lodge.ts"]) {
      const source = readRepoCode(file);
      expect(source, file).toMatch(
        /isHostingCoverageParticipantRetry\(err\)[\s\S]*?HOSTING_COVERAGE_RETRY_MESSAGE[\s\S]*?HOSTING_COVERAGE_RETRY_CODE/,
      );
    }

    const groupBooking = readRepoCode("src/lib/group-booking.ts");
    expect(groupBooking).toMatch(
      /isHostingCoverageParticipantRetry\(err\)[\s\S]*?new GroupBookingError\(HOSTING_COVERAGE_RETRY_MESSAGE, 409,[\s\S]*?HOSTING_COVERAGE_RETRY_CODE/,
    );

    const switchToInternetBanking = readRepoCode(
      "src/app/api/payments/switch-to-internet-banking/route.ts",
    );
    expect(switchToInternetBanking).toMatch(
      /isHostingCoverageParticipantRetry\(err\)[\s\S]*?type: "hostingCoverageRetry"/,
    );

    const xeroMembership = readRepoCode("src/lib/xero-membership-sync.ts");
    expect(xeroMembership).toMatch(
      /recordLinkedContactSubscriptionSyncError\(errors, seasonYear, error\)[\s\S]*?isHostingCoverageParticipantRetry\(error\)[\s\S]*?throw error/,
    );
  });
});
