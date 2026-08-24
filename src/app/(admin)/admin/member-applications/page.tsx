"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";
import { formatPayloadCalendarDay } from "../_lib/calendar-day";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ApprovalMappingPanel, {
  type ReviewRequestPayload,
} from "./_components/approval-mapping-panel";

type ApplicationStatus =
  | "PENDING_NOMINATORS"
  | "PENDING_ADMIN"
  | "APPROVED"
  | "REJECTED";

type ApplicationRecord = {
  id: string;
  applicantFirstName: string;
  applicantLastName: string;
  applicantEmail: string;
  applicantDateOfBirth: string | null;
  applicantPhone: string | null;
  applicantAddress: {
    streetAddressLine1?: string | null;
    streetAddressLine2?: string | null;
    streetCity?: string | null;
    streetRegion?: string | null;
    streetPostalCode?: string | null;
    streetCountry?: string | null;
  };
  familyMembers: Array<{
    firstName: string;
    lastName: string;
    dateOfBirth: string;
  }>;
  familyMemberCount: number;
  nominator1Email: string;
  nominator2Email: string;
  nominator1Id: string | null;
  nominator2Id: string | null;
  nominator1Name: string | null;
  nominator2Name: string | null;
  nominator1ConfirmedAt: string | null;
  nominator2ConfirmedAt: string | null;
  nominator1TokenExpiresAt: string | null;
  nominator2TokenExpiresAt: string | null;
  nominator1TokenLastSentAt: string | null;
  nominator2TokenLastSentAt: string | null;
  nominator1ReminderCount: number;
  nominator2ReminderCount: number;
  nominatorReminderLimit: number;
  nominator1ReminderExhausted: boolean;
  nominator2ReminderExhausted: boolean;
  status: ApplicationStatus;
  adminNotes: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

type NominatorSlot = "nominator1" | "nominator2";

// #1786: a pending approve/reject waiting on the admin's notify-or-not choice.
// The validated entrance-fee decision and E10 mapping payload are captured here
// so the notify dialog only opens once the approval form is valid, and
// performReview can reuse them verbatim.
type ReviewChoice = {
  applicationId: string;
  decision: "APPROVE" | "REJECT";
  entranceFeeInvoiceDecision: unknown;
  personDecisions: unknown;
  mappingPreviewToken: string | null;
};

type MemberSearchResult = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

const filters: Array<{ label: string; value: string }> = [
  { label: "Pending admin", value: "PENDING_ADMIN" },
  { label: "Waiting on nominators", value: "PENDING_NOMINATORS" },
  { label: "Approved", value: "APPROVED" },
  { label: "Rejected", value: "REJECTED" },
  { label: "All", value: "" },
];

/**
 * Submission, confirmation, review and token-expiry stamps — real INSTANTS,
 * projected through the club's persisted zone (CT-4, #2870; INV-CONFIG-002).
 * Named for what it formats: a family member's DATE OF BIRTH is a calendar
 * date and does NOT come through here.
 */
function formatInstant(clubTime: BoundClubTime, value: string | null) {
  const instant = value === null ? null : parseInstant(value);
  if (instant === null) {
    return "Not yet";
  }
  return clubTime.instantDateTime(instant);
}

/**
 * A family member's DATE OF BIRTH, which the application stores as a plain
 * `yyyy-MM-dd` string (`isoDateSchema` in `nomination.ts`).
 *
 * A CALENDAR DATE, so no zone: 4 May 1990 is 4 May 1990 everywhere. The old
 * code did `formatNZDate(new Date(dob))`, which parsed the bare day as UTC
 * midnight and then projected it through APP_TIME_ZONE — right by accident for
 * a club ahead of UTC, and one day EARLY for any club behind it. A birthday is
 * one of the mandatory regression anchors on #2870 for exactly that reason.
 */
function formatDateOfBirth(value: string) {
  return formatPayloadCalendarDay(value, value);
}

function statusLabel(status: ApplicationStatus) {
  switch (status) {
    case "PENDING_NOMINATORS":
      return "Waiting on nominators";
    case "PENDING_ADMIN":
      return "Pending committee review";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    default:
      return status;
  }
}

function replacementKey(applicationId: string, slot: NominatorSlot) {
  return `${applicationId}:${slot}`;
}

export default function MemberApplicationsPage() {
  const clubTime = useClubTime();
  // Approve/decline/refresh/replace all write membership-area routes; a
  // view-only membership admin browses applications but cannot act (#1997).
  const canEditMembership = useAdminAreaEditAccess("membership");
  const [filter, setFilter] = useState("PENDING_ADMIN");
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [replacementQueries, setReplacementQueries] = useState<Record<string, string>>({});
  const [replacementResults, setReplacementResults] = useState<Record<string, MemberSearchResult[]>>({});
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [searchingReplacementKey, setSearchingReplacementKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // #1786: which action is waiting on the admin's notify-or-not choice, and
  // whether the dialog is open. The choice is kept set while the dialog fades
  // out so its copy never flickers to the other action's wording.
  const [reviewChoice, setReviewChoice] = useState<ReviewChoice | null>(null);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);

  async function loadApplications(nextFilter = filter) {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      if (nextFilter) {
        params.set("status", nextFilter);
      }
      const response = await fetch(`/api/admin/member-applications?${params.toString()}`);
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not load member applications.");
        return;
      }

      setApplications(data.applications || []);
      setPendingCount(data.pendingCount || 0);
      setNotes((prev) => {
        const next = { ...prev };
        for (const application of data.applications || []) {
          if (!(application.id in next)) {
            next[application.id] = application.adminNotes || "";
          }
        }
        return next;
      });
    } catch {
      setError("Could not load member applications.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadApplications(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // #1786/E10: the approval panel validates the joining-fee decision + mapping
  // payload and hands it here; this opens the notify-choice dialog. The
  // applicant approved/rejected email always sends (the applicant email is a
  // required field), so the dialog always shows.
  function requestReview(
    applicationId: string,
    payload: ReviewRequestPayload
  ) {
    setError("");
    setMessage("");
    setReviewChoice({
      applicationId,
      decision: payload.decision,
      entranceFeeInvoiceDecision: payload.entranceFeeInvoiceDecision,
      personDecisions: payload.personDecisions,
      mappingPreviewToken: payload.mappingPreviewToken,
    });
    setReviewDialogOpen(true);
  }

  // #1786: dispatch the pending review with the admin's notify choice. Close the
  // dialog without clearing the choice so its wording holds through the fade-out.
  function confirmReview(notifyMember: boolean) {
    const choice = reviewChoice;
    setReviewDialogOpen(false);
    if (!choice) return;
    void performReview(choice, notifyMember);
  }

  async function performReview(choice: ReviewChoice, notifyMember: boolean) {
    const {
      applicationId,
      decision,
      entranceFeeInvoiceDecision,
      personDecisions,
      mappingPreviewToken,
    } = choice;
    setSubmittingId(applicationId);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/admin/member-applications/${applicationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          adminNotes: notes[applicationId] || "",
          entranceFeeInvoiceDecision,
          notifyMember,
          ...(personDecisions ? { personDecisions } : {}),
          ...(mappingPreviewToken ? { mappingPreviewToken } : {}),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not update the application.");
        return;
      }

      const warnings =
        Array.isArray(data.warnings) && data.warnings.length > 0
          ? ` Warnings: ${data.warnings.join(". ")}`
          : "";
      const suppressed =
        notifyMember === false ? " The applicant was not emailed." : "";
      setMessage(
        (decision === "APPROVE"
          ? `Application approved.${warnings}`
          : "Application rejected.") + suppressed
      );
      await loadApplications(filter);
    } catch {
      setError("Could not update the application.");
    } finally {
      setSubmittingId(null);
    }
  }

  async function refreshNominations(applicationId: string) {
    setSubmittingId(applicationId);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        `/api/admin/member-applications/${applicationId}/nominations/refresh`,
        { method: "POST" }
      );
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not refresh the nomination workflow.");
        return;
      }

      const warnings =
        Array.isArray(data.warnings) && data.warnings.length > 0
          ? ` Warnings: ${data.warnings.join(". ")}`
          : "";
      setMessage(`Nomination workflow refreshed.${warnings}`);
      await loadApplications(filter);
    } catch {
      setError("Could not refresh the nomination workflow.");
    } finally {
      setSubmittingId(null);
    }
  }

  async function searchReplacement(applicationId: string, slot: NominatorSlot) {
    const key = replacementKey(applicationId, slot);
    const query = (replacementQueries[key] || "").trim();

    if (query.length < 2) {
      setError("Enter at least two characters to search for a replacement nominator.");
      return;
    }

    setSearchingReplacementKey(key);
    setError("");

    try {
      const response = await fetch(
        `/api/admin/members?q=${encodeURIComponent(query)}&active=true&pageSize=5`
      );
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not search members.");
        return;
      }

      setReplacementResults((prev) => ({
        ...prev,
        [key]: data.members || [],
      }));
    } catch {
      setError("Could not search members.");
    } finally {
      setSearchingReplacementKey(null);
    }
  }

  async function replaceNominator(
    applicationId: string,
    slot: NominatorSlot,
    member: MemberSearchResult
  ) {
    setSubmittingId(applicationId);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        `/api/admin/member-applications/${applicationId}/nominators/${slot}/replace`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memberId: member.id }),
        }
      );
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not replace the nominator.");
        return;
      }

      const warnings =
        Array.isArray(data.warnings) && data.warnings.length > 0
          ? ` Warnings: ${data.warnings.join(". ")}`
          : "";
      setMessage(
        `Nominator replaced with ${member.firstName} ${member.lastName}.${warnings}`
      );
      setReplacementQueries((prev) => ({
        ...prev,
        [replacementKey(applicationId, slot)]: "",
      }));
      setReplacementResults((prev) => ({
        ...prev,
        [replacementKey(applicationId, slot)]: [],
      }));
      await loadApplications(filter);
    } catch {
      setError("Could not replace the nominator.");
    } finally {
      setSubmittingId(null);
    }
  }

  function renderNominatorCard(application: ApplicationRecord, slot: NominatorSlot) {
    const isFirst = slot === "nominator1";
    const label = isFirst ? "Nominator 1" : "Nominator 2";
    const name = isFirst ? application.nominator1Name : application.nominator2Name;
    const email = isFirst ? application.nominator1Email : application.nominator2Email;
    const confirmedAt = isFirst
      ? application.nominator1ConfirmedAt
      : application.nominator2ConfirmedAt;
    const tokenExpiresAt = isFirst
      ? application.nominator1TokenExpiresAt
      : application.nominator2TokenExpiresAt;
    const tokenLastSentAt = isFirst
      ? application.nominator1TokenLastSentAt
      : application.nominator2TokenLastSentAt;
    const reminderCount = isFirst
      ? application.nominator1ReminderCount
      : application.nominator2ReminderCount;
    const reminderExhausted = isFirst
      ? application.nominator1ReminderExhausted
      : application.nominator2ReminderExhausted;
    const key = replacementKey(application.id, slot);
    const canReplace =
      application.status === "PENDING_NOMINATORS" && confirmedAt === null;

    return (
      <div className="rounded-lg border border-border bg-muted p-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 font-medium text-foreground">
          {name || email}
        </p>
        <p className="text-muted-foreground">{email}</p>
        <p className="mt-2 text-muted-foreground">
          Confirmed: {formatInstant(clubTime, confirmedAt)}
        </p>

        {!confirmedAt && application.status === "PENDING_NOMINATORS" && (
          <div className="mt-3 space-y-2 rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
            <p>Link expires: {formatInstant(clubTime, tokenExpiresAt)}</p>
            <p>Last sent: {formatInstant(clubTime, tokenLastSentAt)}</p>
            <p>
              Automatic reminders: {reminderCount}/{application.nominatorReminderLimit}
              {reminderExhausted ? " exhausted" : ""}
            </p>
          </div>
        )}

        {canReplace && (
          <div className="mt-3 space-y-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                Replacement member
              </span>
              <input
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
                value={replacementQueries[key] || ""}
                onChange={(event) =>
                  setReplacementQueries((prev) => ({
                    ...prev,
                    [key]: event.target.value,
                  }))
                }
                placeholder="Search name or email"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={searchingReplacementKey === key}
              onClick={() => searchReplacement(application.id, slot)}
            >
              {searchingReplacementKey === key ? "Searching..." : "Search members"}
            </Button>

            {(replacementResults[key] || []).length > 0 && (
              <div className="space-y-2">
                {(replacementResults[key] || []).map((member) => (
                  <div
                    key={member.id}
                    className="flex flex-col gap-2 rounded-md border border-border bg-card p-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {member.firstName} {member.lastName}
                      </p>
                      <p className="text-xs text-muted-foreground">{member.email}</p>
                    </div>
                    <ViewOnlyActionButton
                      canEdit={canEditMembership}
                      describeReason={false}
                      type="button"
                      size="sm"
                      disabled={submittingId === application.id}
                      onClick={() => replaceNominator(application.id, slot, member)}
                    >
                      Use
                    </ViewOnlyActionButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the page —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. It sits OUTSIDE the `space-y-6`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditMembership} className="mb-6">
      Your admin role can view member applications but cannot approve,
      decline, or otherwise act on them.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Membership
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Member Applications
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pending committee review: <strong>{pendingCount}</strong>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {filters.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={filter === option.value ? "default" : "outline"}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
          <DatasetResetButton
            disabled={filter === "PENDING_ADMIN"}
            onReset={() => setFilter("PENDING_ADMIN")}
          />
        </div>
      </div>

      {message && (
        <div className="rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11">
          {message}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Loading applications...
          </CardContent>
        </Card>
      ) : applications.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No applications match this filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {applications.map((application) => (
            <Card key={application.id}>
              <CardHeader className="space-y-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <CardTitle className="text-2xl">
                      {application.applicantFirstName} {application.applicantLastName}
                    </CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Submitted {formatInstant(clubTime, application.createdAt)}
                    </p>
                  </div>
                  <div className="inline-flex w-fit rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {statusLabel(application.status)}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-6">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Contact
                      </p>
                      <p className="mt-1 text-foreground">{application.applicantEmail}</p>
                      {application.applicantPhone && (
                        <p className="text-muted-foreground">{application.applicantPhone}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Address
                      </p>
                      <div className="mt-1 space-y-1 text-muted-foreground">
                        {application.applicantAddress.streetAddressLine1 && (
                          <p>{application.applicantAddress.streetAddressLine1}</p>
                        )}
                        {application.applicantAddress.streetAddressLine2 && (
                          <p>{application.applicantAddress.streetAddressLine2}</p>
                        )}
                        <p>
                          {[
                            application.applicantAddress.streetCity,
                            application.applicantAddress.streetRegion,
                            application.applicantAddress.streetPostalCode,
                          ]
                            .filter(Boolean)
                            .join(", ") || "No address supplied"}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3 text-sm">
                    {renderNominatorCard(application, "nominator1")}
                    {renderNominatorCard(application, "nominator2")}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Dependents
                  </p>
                  {application.familyMembers.length === 0 ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      No dependents included with this application.
                    </p>
                  ) : (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      {application.familyMembers.map((familyMember) => (
                        <div
                          key={`${familyMember.firstName}-${familyMember.lastName}-${familyMember.dateOfBirth}`}
                          className="rounded-lg border border-border px-4 py-3 text-sm"
                        >
                          <p className="font-medium text-foreground">
                            {familyMember.firstName} {familyMember.lastName}
                          </p>
                          <p className="text-muted-foreground">
                            DOB {formatDateOfBirth(familyMember.dateOfBirth)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label
                    className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground"
                    htmlFor={`notes-${application.id}`}
                  >
                    Committee notes
                  </label>
                  <textarea
                    id={`notes-${application.id}`}
                    className="min-h-28 w-full rounded-md border border-border px-3 py-2 text-sm"
                    value={notes[application.id] || ""}
                    onChange={(event) =>
                      setNotes((prev) => ({
                        ...prev,
                        [application.id]: event.target.value,
                      }))
                    }
                    placeholder="Add committee notes or decision context"
                  />
                </div>

                {application.reviewedAt && (
                  <div className="rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                    Reviewed by {application.reviewerName || "an administrator"} on{" "}
                    {formatInstant(clubTime, application.reviewedAt)}
                  </div>
                )}

                {application.status === "PENDING_ADMIN" && (
                  <ApprovalMappingPanel
                    application={application}
                    submitting={submittingId === application.id}
                    canEdit={canEditMembership}
                    onError={setError}
                    onRequestReview={(payload) =>
                      requestReview(application.id, payload)
                    }
                  />
                )}

                {application.status === "PENDING_NOMINATORS" && (
                  <div className="space-y-3 rounded-md border border-border bg-muted p-4 text-sm">
                    <p className="text-muted-foreground">
                      This application is still waiting on its nominators and cannot
                      be approved until both have confirmed. Refresh the workflow to
                      send fresh links to pending nominators, or replace an unconfirmed
                      nominator above.
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <ViewOnlyActionButton
                        canEdit={canEditMembership}
                        describeReason={false}
                        type="button"
                        disabled={submittingId === application.id}
                        onClick={() => refreshNominations(application.id)}
                      >
                        {submittingId === application.id
                          ? "Working..."
                          : "Refresh nomination workflow"}
                      </ViewOnlyActionButton>
                      <ViewOnlyActionButton
                        canEdit={canEditMembership}
                        describeReason={false}
                        type="button"
                        variant="outline"
                        disabled={submittingId === application.id}
                        onClick={() =>
                          requestReview(application.id, {
                            decision: "REJECT",
                            entranceFeeInvoiceDecision: undefined,
                            personDecisions: null,
                            mappingPreviewToken: null,
                          })
                        }
                      >
                        Reject application
                      </ViewOnlyActionButton>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* #1786: per-action applicant-email choice, mirroring the #1769a pattern.
          The applicant approved/rejected email always sends (the applicant email
          is a required field), so the dialog always shows on approve and reject.
          Both choices complete the review; the choice is recorded in the audit
          log. */}
      <Dialog
        open={reviewDialogOpen}
        onOpenChange={(open) => {
          if (!open && submittingId === null) setReviewDialogOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewChoice?.decision === "REJECT"
                ? "Email the applicant about this rejection?"
                : "Email the applicant about this approval?"}
            </DialogTitle>
            <DialogDescription>
              {reviewChoice?.decision === "REJECT"
                ? "The application is rejected either way. Choose whether the applicant receives the standard rejection email — your choice is recorded in the audit log."
                : "The application is approved either way. Choose whether the applicant receives the standard approval email, which carries their account-setup link — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={submittingId !== null}
              onClick={() => confirmReview(false)}
            >
              {reviewChoice?.decision === "REJECT"
                ? "Reject without emailing"
                : "Approve without emailing"}
            </Button>
            <Button
              disabled={submittingId !== null}
              onClick={() => confirmReview(true)}
            >
              {reviewChoice?.decision === "REJECT"
                ? "Reject and email applicant"
                : "Approve and email applicant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
