"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import {
  readHostingCoverageOverridePrompt,
  type HostingCoverageOverridePromptData,
} from "@/lib/hosting-coverage-override-client";
import { useClubTime } from "@/components/club-time-provider";
import {
  calendarDateOfSerialisedDbDateOrNull,
  formatClubDate,
} from "@/lib/club-time";
import { formatPolicyExceptionRequestAge } from "@/lib/booking-exception-requests";
import type { PolicyExceptionReasonCode } from "@/lib/booking-policy-exceptions";
import { HostingCoverageOverridePrompt } from "@/components/hosting-coverage-override-prompt";

/**
 * #2526 — the Booking Officer's booking-policy exception queue.
 *
 * One list for both request flavours (a new booking nobody has made yet, and a
 * change to a live booking), because the officer's question is the same for
 * both: what did the member ask for, which rule does it break, how long have
 * they been waiting, and do we allow it this once?
 *
 * What the card deliberately shows:
 *  - the REQUEST AGE, in plain English, because "how long has this person been
 *    waiting" is half the decision and a raw timestamp makes the officer do the
 *    subtraction;
 *  - the FROZEN EVIDENCE — the exact rules, at the exact policy revision, that
 *    were tripping when the member asked. Approving overrides those and nothing
 *    else; if the policy has moved since, the approval refuses and says so
 *    rather than quietly overriding a rule nobody reviewed;
 *  - whether the request HOLDS BEDS while it waits;
 *  - the last capacity conflict, when an approval has already been kept pending.
 */

type StatusFilter =
  | "REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "SUPERSEDED"
  | "ALL";

const STATUS_FILTERS: StatusFilter[] = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "SUPERSEDED",
  "ALL",
];

interface PolicyRef {
  reasonCode: string;
  policyId: string;
  policyVersion: number;
  capacityMode: string;
}

/** One proposed guest as the detail endpoint describes them. */
interface ProposedPartyGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  nights: string[];
  isMemberGuest: boolean;
  beyondFamily: boolean | null;
}

interface CoverageOverridePrompt extends HostingCoverageOverridePromptData {
  requestId: string;
}

interface QueueItem {
  source: "NEW_BOOKING" | "MODIFICATION";
  id: string;
  status: string;
  createdAt: string;
  version: number;
  bookingId: string | null;
  lodgeId: string | null;
  requestedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  reviewedBy: { id: string; firstName: string; lastName: string } | null;
  reviewedAt: string | null;
  memberMessage: string | null;
  proposalHash: string | null;
  aggregateCapacityMode: "HOLD" | "NO_HOLD" | null;
  reasonCodes: string[];
  policyRefs: PolicyRef[];
  /**
   * What the club's hosting setting DID about the hosting violation, frozen at the
   * time (#2569). Null where the request carries no hosting reason.
   */
  hostingConsequence: "ADMIN_REVIEW_REQUIRED" | "ENFORCED" | null;
  affectedNights: string[];
  proposedCheckIn: string | null;
  proposedCheckOut: string | null;
  proposedGuestCount: number | null;
  /** The MEMBER-FACING decision explanation (#2562) — the member reads this. */
  adminNotes: string | null;
  /** The officer's PRIVATE note (#2562) — admin surfaces only, never the member. */
  internalNotes: string | null;
  createdBookingId: string | null;
  attemptCount: number;
  conflictCount: number;
  lastConflictAt: string | null;
  lastConflictReason: string | null;
  supersededByRequestId: string | null;
  summary: string | null;
}

// Typed against the reason-code union on purpose: adding a code to the
// #2363 allowlist without deciding its officer-facing wording fails typecheck
// here, so a new violation class can never reach the queue as a raw enum
// (#2543 landed second and owed exactly this entry — the recorded #2526/#2543
// cross-lane rule).
const REASON_LABELS: Record<PolicyExceptionReasonCode, string> = {
  MINIMUM_STAY: "Minimum stay",
  ADULT_MEMBER_HOSTING_REQUIRED: "Adult member must host",
  PAID_UP_ADULT_MEMBER_REQUIRED: "Paid-up adult member required",
};

function reasonLabel(code: string) {
  return (REASON_LABELS as Record<string, string>)[code] ?? code;
}

/**
 * Whether the adult-member rule refused this or merely flagged it (#2569).
 *
 * The reason label is the same either way, and the difference is the whole
 * character of the decision: under the enforcing consequence there is no booking
 * (or no change) until an officer approves, and under the review consequence there
 * already is one and the officer is recording a view of it. An officer who reads the
 * second while it is the first leaves a member without a bed and does not know it.
 *
 * Says nothing about beds: the badge in the header already reports the hold, and
 * saying it twice from two different derivations is how the two come to disagree.
 */
function hostingConsequenceSentence(
  consequence: "ADMIN_REVIEW_REQUIRED" | "ENFORCED",
  source: "NEW_BOOKING" | "MODIFICATION",
): string {
  if (consequence === "ENFORCED") {
    return source === "NEW_BOOKING"
      ? "The adult-member rule refused this booking, so it does not exist yet. Approving the exception is what allows it to be made."
      : "The adult-member rule refused this change, so the booking still stands as it was. Approving the exception is what allows the change.";
  }
  return source === "NEW_BOOKING"
    ? "The adult-member rule allowed the booking and asked for a look, so it already exists. Your decision records what the club makes of it."
    : "The adult-member rule allowed the change and asked for a look. Your decision records what the club makes of it.";
}

/** "ADULT" -> "Adult", so an age tier reads as words on the decision card. */
function ageTierLabel(tier: string) {
  return tier.charAt(0) + tier.slice(1).toLowerCase().replace(/_/g, " ");
}

function statusBadgeClass(status: string) {
  if (status === "REQUESTED") return "border-warning-6 bg-warning-3 text-warning-11";
  if (status === "APPROVED") return "border-success-6 bg-success-3 text-success-11";
  return "border-border bg-muted text-muted-foreground";
}

/**
 * The proposed lodge nights as the calendar days they ARE - no timezone, because
 * a calendar day has none (CT-4, #2870; INV-DATE-010). `@db.Date` reaches the
 * browser as UTC midnight, and the kernel's calendar-date formatter pins UTC over
 * that encoding, so the projection is the identity. What this replaces read the
 * day through a zone: correct east of Greenwich, a day early west of it.
 */
function formatDate(value: string | null) {
  const day = calendarDateOfSerialisedDbDateOrNull(value);
  return day ? formatClubDate(day) : "—";
}

export interface PolicyExceptionRequestsPanelProps {
  basePath?: string;
  showHeading?: boolean;
  canEdit?: boolean;
}

export function PolicyExceptionRequestsPanel({
  basePath = "/admin/booking-requests?tab=exceptions",
  showHeading = false,
  canEdit = true,
}: PolicyExceptionRequestsPanelProps) {
  /**
   * Every timestamp below is a real INSTANT projected into the club's PERSISTED
   * timezone (CT-4, #2870; INV-CONFIG-002) rather than the container's `TZ`. The
   * zone reaches this browser as data through `ClubTimeProvider`; it is never
   * read from the viewer's own clock.
   */
  const clubTime = useClubTime();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("REQUESTED");
  const [loadedFilter, setLoadedFilter] = useState<StatusFilter | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  const activeFilterRef = useRef(filter);
  // A slower response for the filter the officer just left must never become
  // authoritative for the filter now shown in the toolbar.
  const loadRequestIdRef = useRef(0);
  const [openId, setOpenId] = useState<string | null>(null);
  // The MEMBER-FACING decision explanation. Named `notes` since #2526 and kept
  // that way so every existing reference reads the same field; the label beside
  // it, and the state below, are what #2562 added.
  const [notes, setNotes] = useState("");
  // The officer's PRIVATE note. A separate field so an officer who needs to
  // record a judgement about a member has somewhere to put it that is not the
  // member's own screen — which is the whole reason the split exists.
  const [internalNotes, setInternalNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [coverageOverridePrompt, setCoverageOverridePrompt] =
    useState<CoverageOverridePrompt | null>(null);
  const [coverageOverrideConfirmed, setCoverageOverrideConfirmed] =
    useState(false);
  const [coverageOverrideReason, setCoverageOverrideReason] = useState("");
  /**
   * Ref-backed because a disabled button is not a synchronous claim: two clicks
   * dispatched in one React batch otherwise both enter `decide`. State mirrors the
   * per-request claims for rendering and leaves unrelated rows usable (#2562).
   */
  const decisionInFlightRef = useRef(new Set<string>());
  const [decisionInFlight, setDecisionInFlight] = useState<Set<string>>(
    () => new Set(),
  );
  // How a refund arising from an approved CHANGE is settled. Not part of the
  // reviewed proposal (the proposal decides WHAT changes; this decides how the
  // money moves), so it lives on the decision form rather than the request.
  const [settlementMethod, setSettlementMethod] = useState<"" | "card" | "credit">(
    "",
  );
  // The full proposed party, fetched on demand from the detail endpoint. Approving
  // executes this party for real, so the officer has to be able to see WHO is on
  // it — a guest count cannot show an unrelated member being attached to somebody
  // else's stay, or a party of minors with no adult.
  const [partyById, setPartyById] = useState<
    Record<string, ProposedPartyGuest[] | "loading" | "error">
  >({});
  // Re-rendered on a timer so the plain-English age on an open queue stays true
  // instead of freezing at whatever it was when the page loaded.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const fetchItems = useCallback(async (
    { preserveItemsOnFailure = false }: { preserveItemsOnFailure?: boolean } = {},
  ) => {
    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () =>
      requestId === loadRequestIdRef.current && filter === activeFilterRef.current;
    if (!preserveItemsOnFailure) setLoading(true);
    setLoadFailed(false);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/booking-exception-requests?status=${filter}&pageSize=100`,
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load exception requests");
      }
      if (!isCurrentRequest()) return false;
      setItems(Array.isArray(data?.data) ? data.data : []);
      setLoadedFilter(filter);
      return true;
    } catch (err) {
      if (!isCurrentRequest()) return false;
      if (!preserveItemsOnFailure) {
        setItems([]);
        setLoadedFilter(null);
        setLoadFailed(true);
      }
      setError(
        err instanceof Error ? err.message : "Failed to load exception requests",
      );
      return false;
    } finally {
      if (isCurrentRequest() && !preserveItemsOnFailure) {
        setLoading(false);
      }
    }
  }, [filter]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    if (!error) return;
    const alert = errorRef.current;
    if (!alert) return;
    alert.focus({ preventScroll: true });
    if (typeof alert.scrollIntoView === "function") {
      alert.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [error]);

  function resetDecisionForm() {
    setOpenId(null);
    setNotes("");
    setInternalNotes("");
    setConfirmed(false);
    setCoverageOverridePrompt(null);
    setCoverageOverrideConfirmed(false);
    setCoverageOverrideReason("");
    setSettlementMethod("");
  }

  /** Load the proposed party for one request, once. */
  const loadParty = useCallback(async (id: string) => {
    setPartyById((current) =>
      current[id] && current[id] !== "error" ? current : { ...current, [id]: "loading" },
    );
    try {
      const response = await fetch(`/api/admin/booking-exception-requests/${id}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Failed to load the proposal");
      setPartyById((current) => ({
        ...current,
        [id]: Array.isArray(data?.proposedGuests) ? data.proposedGuests : [],
      }));
    } catch {
      setPartyById((current) => ({ ...current, [id]: "error" }));
    }
  }, []);

  async function decide(item: QueueItem, action: "approve" | "reject") {
    /*
      THE DRAFT BELONGS TO THE OPEN CARD, and this says so rather than assuming it
      (#2562 re-review). This queue keeps one decision draft and one `openId`: the
      form — and the two decision buttons — are drawn only inside the card whose id
      `openId` names, and opening another card resets the draft, so the notes read
      below have always been this card's own. The SIBLING panel on the same table
      (`booking-change-requests-panel`) had the same shape with several cards' forms
      mounted at once and leaked one member's decision explanation onto another
      member's request. Nothing here can reach that state, and a guard that fails
      closed costs one comparison and removes the possibility that a later refactor
      (drawing more than one form, or keeping a draft across cards) re-opens it
      silently. `adminNotes` is read verbatim by the member.
    */
    if (openId !== item.id) {
      setError(
        "Open the request you want to decide before sending a decision, so the notes go to the right member.",
      );
      return;
    }
    const coveragePrompt =
      coverageOverridePrompt?.requestId === item.id
        ? coverageOverridePrompt
        : null;
    if (
      action === "approve" &&
      coveragePrompt &&
      (!coverageOverrideConfirmed || coverageOverrideReason.trim().length < 10)
    ) {
      setError(
        "Confirm the affected bookings and give a private override reason of at least 10 characters.",
      );
      return;
    }
    if (decisionInFlightRef.current.has(item.id)) return;
    decisionInFlightRef.current.add(item.id);
    setDecisionInFlight((current) => new Set(current).add(item.id));
    setError("");
    try {
      const response = await fetch(
        `/api/admin/booking-exception-requests/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            source: item.source,
            expectedVersion: item.version,
            adminNotes: notes.trim() || undefined,
            internalNotes: internalNotes.trim() || undefined,
            ...(action === "approve" ? { confirm: true } : {}),
            ...(action === "approve" && settlementMethod
              ? { settlementMethod }
              : {}),
            ...(action === "approve" && coveragePrompt
              ? {
                  hostingCoverageOverride: {
                    acknowledged: true,
                    reason: coverageOverrideReason.trim(),
                    strandedStateKey: coveragePrompt.strandedStateKey,
                  },
                }
              : {}),
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const hostingPrompt = readHostingCoverageOverridePrompt(data);
        if (hostingPrompt) {
          setCoverageOverridePrompt({
            requestId: item.id,
            ...hostingPrompt,
          });
          setCoverageOverrideConfirmed(false);
          setCoverageOverrideReason("");
          throw new Error(
            "Review the affected bookings and nights, then explicitly confirm the private override.",
          );
        }
        // Any refusal may have moved the row's `version` — a kept-pending capacity
        // conflict always does — so re-read the queue before the officer tries
        // again. Without this their next click lost the guarded compare and was
        // told the request "changed while you were reviewing it", which blamed a
        // third party for their own previous attempt and left the guide's remedy
        // ("approve it again once beds free up") unreachable without a reload.
        if (filter === activeFilterRef.current) {
          await fetchItems({ preserveItemsOnFailure: true });
        }
        // A kept-pending answer is NOT a failure of the officer's intent: the
        // request is still open and can be approved once beds free up. Say that
        // in those words rather than showing a bare error.
        throw new Error(
          data?.keptPending
            ? `${data.error} The request is still pending.`
            : data.error || "The decision could not be recorded",
        );
      }
      toast.success(
        action === "approve"
          ? data.followUpFailed
            ? data.createdBookingId
              ? "Approved and the booking was created, but some follow-up work failed — check the booking and the member's email."
              : "Approved and the change was applied, but some follow-up work failed — check the booking and the member's email."
            : data.createdBookingId
              ? "Approved — the booking has been created."
              : "Approved — the change has been applied to the booking."
          : item.source === "NEW_BOOKING"
            ? "Request refused. Nothing was booked."
            : "Request refused. The member keeps their existing booking.",
      );
      resetDecisionForm();
      await fetchItems();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The decision could not be recorded",
      );
    } finally {
      decisionInFlightRef.current.delete(item.id);
      setDecisionInFlight((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view booking-policy exception requests but cannot
      approve or refuse them. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
        {showHeading ? (
          <div>
            <h1 className="text-3xl font-bold">Booking-policy exceptions</h1>
            <p className="mt-1 text-muted-foreground">
              Members ask here when a booking rule would otherwise stop them.
            </p>
          </div>
        ) : null}

        <p className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          Approving executes the exact proposal shown — it creates the booking,
          or applies the change, in one step. It overrides only the rules listed
          on the card, and nothing else: lodge capacity, payment, membership and
          privacy rules all still apply, and a booking that is waiting on any
          admin review still cannot check in until that review is cleared. Open
          the guest list before you decide: a member guest from outside the
          requester&apos;s family still has to be asked, and a party of minors with
          no adult still goes to a child-safety review.
        </p>

        <div
          id="policy-exception-error"
          ref={errorRef}
          role="alert"
          aria-atomic="true"
          tabIndex={-1}
          className={
            error
              ? "rounded-md bg-destructive/10 px-4 py-3 text-destructive"
              : "sr-only"
          }
        >
          {error ? (
            <>
              {error}
              {loadFailed ? (
                <button
                  type="button"
                  onClick={() => void fetchItems()}
                  className="ml-2 underline"
                >
                  Try again
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setError("")}
                  className="ml-2 underline"
                >
                  Dismiss
                </button>
              )}
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((status) => (
            <Button
              key={status}
              variant={filter === status ? "default" : "outline"}
              size="sm"
              onClick={() => {
                activeFilterRef.current = status;
                resetDecisionForm();
                setFilter(status);
              }}
            >
              {status === "ALL"
                ? "All"
                : status.charAt(0) + status.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>

        {loading || (!loadFailed && loadedFilter !== filter) ? (
          <div className="py-8 text-center">Loading...</div>
        ) : loadFailed ? null : items.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            No {filter === "ALL" ? "" : `${filter.toLowerCase()} `}booking-policy
            exception requests.
          </div>
        ) : (
          <div className="space-y-4">
            {items.map((item) => {
              const requester = item.requestedBy
                ? `${item.requestedBy.firstName} ${item.requestedBy.lastName}`
                : "Unknown member";
              const age = formatPolicyExceptionRequestAge(
                new Date(item.createdAt),
                new Date(now),
              );
              const isOpen = openId === item.id;
              const needsReason =
                item.reasonCodes.includes("ADULT_MEMBER_HOSTING_REQUIRED");
              const hasNotes = notes.trim().length > 0;

              return (
                // #2562: the request id is carried on the card so the member-UI
                // browser spec can decide THE request it just raised rather than
                // "the first card", which in a shared, age-ordered queue is a
                // different request the moment anything else is waiting.
                <Card
                  key={item.id}
                  data-testid="policy-exception-request"
                  data-request-id={item.id}
                >
                  <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="text-lg">{requester}</CardTitle>
                        <p className="text-sm text-muted-foreground">
                          {item.source === "NEW_BOOKING"
                            ? "New booking"
                            : "Change to an existing booking"}{" "}
                          · asked {age} ({clubTime.instantDateTime(new Date(item.createdAt))})
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={statusBadgeClass(item.status)}
                        >
                          {item.status}
                        </Badge>
                        <Badge variant="outline">
                          {/* A NEW-booking request reserves nothing whatever the
                              policy's capacity mode says — the reservation ledger
                              is keyed on an existing booking, and there is no
                              booking yet. Showing "Holding beds" told the officer
                              the request could not be beaten to the beds, which
                              was the opposite of the truth and invited them to
                              deprioritise it. */}
                          {item.source === "MODIFICATION" &&
                          item.aggregateCapacityMode === "HOLD"
                            ? "Holding beds"
                            : "No beds held"}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <span className="text-muted-foreground">
                          Proposed dates:
                        </span>{" "}
                        {formatDate(item.proposedCheckIn)} to{" "}
                        {formatDate(item.proposedCheckOut)}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Guests:</span>{" "}
                        {item.proposedGuestCount ?? "—"}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Attempts:</span>{" "}
                        {item.attemptCount}
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          Capacity conflicts:
                        </span>{" "}
                        {item.conflictCount}
                      </div>
                    </div>

                    <div className="rounded-md border bg-muted p-3 text-sm">
                      <p className="font-medium text-foreground">
                        Rules this request breaks
                      </p>
                      <ul className="mt-2 space-y-1 text-muted-foreground">
                        {item.policyRefs.length > 0
                          ? item.policyRefs.map((ref) => (
                              <li key={`${ref.reasonCode}-${ref.policyId}`}>
                                {reasonLabel(ref.reasonCode)} (policy{" "}
                                <span className="font-mono">{ref.policyId}</span>{" "}
                                v{ref.policyVersion},{" "}
                                {ref.capacityMode === "HOLD"
                                  ? "holds beds"
                                  : "holds no beds"}
                                )
                              </li>
                            ))
                          : item.reasonCodes.map((code) => (
                              <li key={code}>{reasonLabel(code)}</li>
                            ))}
                      </ul>
                      {item.hostingConsequence ? (
                        <p className="mt-2 text-muted-foreground">
                          {hostingConsequenceSentence(
                            item.hostingConsequence,
                            item.source,
                          )}
                        </p>
                      ) : null}
                      {item.affectedNights.length > 0 ? (
                        <p className="mt-2 text-muted-foreground">
                          Nights affected: {item.affectedNights.join(", ")}
                        </p>
                      ) : null}
                      {item.summary ? (
                        <p className="mt-2 text-muted-foreground">
                          Requested change: {item.summary}
                        </p>
                      ) : null}
                    </div>

                    <div className="rounded-md border border-border p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-foreground">
                          Who this would put on the booking
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => loadParty(item.id)}
                          disabled={partyById[item.id] === "loading"}
                        >
                          {partyById[item.id] === "loading"
                            ? "Loading..."
                            : Array.isArray(partyById[item.id])
                              ? "Reload"
                              : "Show the guests"}
                        </Button>
                      </div>
                      {partyById[item.id] === "error" ? (
                        <p className="mt-2 text-destructive">
                          The proposal could not be loaded. Try again before
                          deciding.
                        </p>
                      ) : Array.isArray(partyById[item.id]) ? (
                        (partyById[item.id] as ProposedPartyGuest[]).length ===
                        0 ? (
                          <p className="mt-2 text-muted-foreground">
                            No guests could be read from the stored proposal. Do
                            not approve it — ask the member to resubmit.
                          </p>
                        ) : (
                          <ul className="mt-2 space-y-1 text-muted-foreground">
                            {(partyById[item.id] as ProposedPartyGuest[]).map(
                              (guest, index) => (
                                <li key={`${guest.firstName}-${guest.lastName}-${index}`}>
                                  {guest.firstName} {guest.lastName} —{" "}
                                  {ageTierLabel(guest.ageTier)}
                                  {guest.isMemberGuest ? ", member" : ""}
                                  {guest.beyondFamily === true
                                    ? " (outside the requester's family — they will be asked to consent, or the add will be refused)"
                                    : ""}
                                  {guest.nights.length > 0
                                    ? ` · ${guest.nights.length} night(s)`
                                    : ""}
                                </li>
                              ),
                            )}
                          </ul>
                        )
                      ) : (
                        <p className="mt-2 text-muted-foreground">
                          Approving executes this exact party. Open it before you
                          decide.
                        </p>
                      )}
                    </div>

                    {item.memberMessage ? (
                      <div className="rounded-md border border-border p-3 text-sm">
                        <p className="font-medium text-foreground">
                          What the member said
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {item.memberMessage}
                        </p>
                      </div>
                    ) : null}

                    {item.lastConflictReason ? (
                      <p className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
                        Last approval attempt was kept pending:{" "}
                        {item.lastConflictReason}
                        {item.lastConflictAt
                          ? ` (${clubTime.instantDateTime(new Date(item.lastConflictAt))})`
                          : ""}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap gap-3 text-sm">
                      {item.bookingId ? (
                        <Link
                          href={buildHrefWithReturnTo(
                            `/bookings/${item.bookingId}`,
                            basePath,
                          )}
                          className="text-info-11 hover:underline"
                        >
                          Open booking
                        </Link>
                      ) : null}
                      {item.createdBookingId ? (
                        <Link
                          href={buildHrefWithReturnTo(
                            `/bookings/${item.createdBookingId}`,
                            basePath,
                          )}
                          className="text-info-11 hover:underline"
                        >
                          Open the booking this created
                        </Link>
                      ) : null}
                      {item.requestedBy ? (
                        <Link
                          href={buildHrefWithReturnTo(
                            `/admin/members/${item.requestedBy.id}`,
                            basePath,
                          )}
                          className="text-info-11 hover:underline"
                        >
                          Open member
                        </Link>
                      ) : null}
                    </div>

                    {item.status === "REQUESTED" ? (
                      <div className="space-y-3 rounded-md border border-border p-3">
                        {!isOpen ? (
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            describeReason={false}
                            size="sm"
                            onClick={() => {
                              setOpenId(item.id);
                              setNotes("");
                              setInternalNotes("");
                              setConfirmed(false);
                              setCoverageOverridePrompt(null);
                              setCoverageOverrideConfirmed(false);
                              setCoverageOverrideReason("");
                            }}
                          >
                            Decide this request
                          </ViewOnlyActionButton>
                        ) : (
                          <>
                            {/* #2562 — the note SPLIT, and the labelling that makes
                                it safe. Before this, one field served both jobs and
                                was member-visible, so an officer recording a
                                judgement about the member had no honest option. The
                                two fields are drawn together, each saying plainly
                                who reads it, BEFORE the decision is submitted. */}
                            <div className="space-y-1">
                              <Label htmlFor={`exception-notes-${item.id}`}>
                                Explanation for the member
                                {needsReason
                                  ? " (required)"
                                  : " (required to refuse; optional on approve)"}
                              </Label>
                              <p className="text-xs font-semibold text-warning-11">
                                The member will see this. It is shown on their own
                                request list and, on an approval, in the email they
                                get.
                              </p>
                              <Textarea
                                id={`exception-notes-${item.id}`}
                                value={notes}
                                disabled={!canEdit}
                                title={
                                  canEdit === false
                                    ? ADMIN_VIEW_ONLY_ACTION_REASON
                                    : undefined
                                }
                                onChange={(event) => setNotes(event.target.value)}
                                maxLength={2000}
                                placeholder="What you decided and why, written for the member. It is kept on the booking's record."
                              />
                            </div>
                            <div className="space-y-1">
                              <Label htmlFor={`exception-internal-${item.id}`}>
                                Internal note (optional)
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Only admins see this. It is never shown to the
                                member, never emailed to them, and never sent to any
                                member-facing screen — put anything here that you
                                would not say to their face.
                              </p>
                              <Textarea
                                id={`exception-internal-${item.id}`}
                                value={internalNotes}
                                disabled={!canEdit}
                                title={
                                  canEdit === false
                                    ? ADMIN_VIEW_ONLY_ACTION_REASON
                                    : undefined
                                }
                                onChange={(event) =>
                                  setInternalNotes(event.target.value)
                                }
                                maxLength={2000}
                                placeholder="Context for the next officer. The member never reads this."
                              />
                            </div>
                            {item.source === "MODIFICATION" ? (
                              <div className="space-y-1">
                                <Label htmlFor={`exception-settlement-${item.id}`}>
                                  If this change reduces the price, where does the
                                  refund go?
                                </Label>
                                <select
                                  id={`exception-settlement-${item.id}`}
                                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                  value={settlementMethod}
                                  disabled={!canEdit}
                                  onChange={(event) =>
                                    setSettlementMethod(
                                      event.target.value as "" | "card" | "credit",
                                    )
                                  }
                                >
                                  <option value="">
                                    Not needed (the price does not drop)
                                  </option>
                                  <option value="card">Refund to the card</option>
                                  <option value="credit">Account credit</option>
                                </select>
                                <p className="text-xs text-muted-foreground">
                                  Only used when the change actually reduces a paid
                                  booking&apos;s price. Leave it as-is and the
                                  approval will tell you if a choice is needed.
                                </p>
                              </div>
                            ) : null}
                            <label className="flex items-start gap-2 text-sm">
                              <input
                                type="checkbox"
                                className="mt-1"
                                checked={confirmed}
                                disabled={!canEdit}
                                onChange={(event) =>
                                  setConfirmed(event.target.checked)
                                }
                              />
                              <span>
                                I have read the proposal above and I am applying
                                this exception.
                              </span>
                            </label>
                            <HostingCoverageOverridePrompt
                              prompt={
                                coverageOverridePrompt?.requestId === item.id
                                  ? coverageOverridePrompt
                                  : null
                              }
                              confirmed={coverageOverrideConfirmed}
                              reason={coverageOverrideReason}
                              disabled={!canEdit}
                              idPrefix={`coverage-override-${item.id}`}
                              onConfirmedChange={setCoverageOverrideConfirmed}
                              onReasonChange={setCoverageOverrideReason}
                            />
                            <div className="flex flex-wrap gap-2">
                              <ViewOnlyActionButton
                                canEdit={canEdit}
                                describeReason={false}
                                size="sm"
                                onClick={() => decide(item, "approve")}
                                disabled={
                                  decisionInFlight.has(item.id) ||
                                  !confirmed ||
                                  (needsReason && !hasNotes) ||
                                  (coverageOverridePrompt?.requestId === item.id &&
                                    (!coverageOverrideConfirmed ||
                                      coverageOverrideReason.trim().length < 10))
                                }
                              >
                                Approve and apply
                              </ViewOnlyActionButton>
                              <ViewOnlyActionButton
                                canEdit={canEdit}
                                describeReason={false}
                                size="sm"
                                variant="outline"
                                onClick={() => decide(item, "reject")}
                                disabled={
                                  decisionInFlight.has(item.id) || !hasNotes
                                }
                              >
                                Refuse
                              </ViewOnlyActionButton>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={resetDecisionForm}
                                disabled={decisionInFlight.has(item.id)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                        {item.status.charAt(0) + item.status.slice(1).toLowerCase()}
                        {item.reviewedAt
                          ? ` on ${clubTime.instantDateTime(new Date(item.reviewedAt))}`
                          : ""}
                        {item.reviewedBy
                          ? ` by ${item.reviewedBy.firstName} ${item.reviewedBy.lastName}`
                          : ""}
                        {/* #2562: after the decision the two notes stay visually
                            separated and labelled, so an officer reading a colleague's
                            decision knows which half the member has already read. */}
                        {item.adminNotes ? (
                          <div className="mt-2 rounded-md border border-border bg-background p-2">
                            <p className="text-xs font-semibold text-foreground">
                              Explanation the member can see
                            </p>
                            <p className="mt-1 whitespace-pre-wrap">
                              {item.adminNotes}
                            </p>
                          </div>
                        ) : null}
                        {item.internalNotes ? (
                          <div className="mt-2 rounded-md border border-dashed border-border bg-background p-2">
                            <p className="text-xs font-semibold text-foreground">
                              Internal note — admins only, never shown to the member
                            </p>
                            <p className="mt-1 whitespace-pre-wrap">
                              {item.internalNotes}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
