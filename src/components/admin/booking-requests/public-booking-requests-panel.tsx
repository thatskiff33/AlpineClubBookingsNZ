"use client";

import Link from "next/link";
import { useClubFormat } from "@/components/club-format-provider";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import { buildBookingRequestDatasetPath } from "@/lib/admin-dataset-reset-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useClubIdentity } from "@/components/club-identity-provider";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { useClubTime } from "@/components/club-time-provider";
import { formatStayDate } from "@/lib/club-time";
import { countNightsDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/utils";
import { MONEY_INPUT_PROPS, parseDecimalDollarsToCents } from "@/lib/money-input";
import { FocusedActionError } from "@/components/focused-action-error";
import {
  BookingRequestContactPicker,
  type OwnerContactChoice,
} from "@/components/admin/booking-requests/booking-request-contact-picker";
import { BookingRequestCorrectionEditor } from "@/components/admin/booking-requests/booking-request-correction-editor";
import {
  MemberWholeLodgeApprovalFields,
  WholeLodgeAvailabilityStrip,
  WholeLodgeRequestBadges,
} from "@/components/admin/booking-requests/whole-lodge-request-controls";
// #3412: the bulk child tiers a school group is counted in — ONE definition,
// shared with the server generator and the public form. Teachers and parent
// helpers are the named ADULTs and are not adjusted here. This copy stopped
// being cosmetic when Save quote began pricing the officer's numbers: it
// decides which rate boxes exist and what is posted.
import {
  SCHOOL_CHILD_TIERS,
  unchangedSchoolGuestPrefixLength,
  sameSchoolGuestList,
  type SchoolChildTier,
} from "@/lib/school-booking-constants";
import { SCHOOL_CHILD_NAME_PREFIX } from "@/lib/placeholder-guest-names";

const SCHOOL_CHILD_TIER_LABELS: Record<SchoolChildTier, string> = {
  INFANT: "Infants",
  CHILD: "Children",
  YOUTH: "Youth",
};

/**
 * Count a request's bulk children per tier from its guest snapshot.
 *
 * #2342: a guest whose stored `ageTier` could not be read back matches no tier
 * and so counts as ZERO here — on a flagged row this silently under-counts the
 * group (a 30-child request can prefill as 1). That is why the boxes it
 * prefills, and the Approve button they feed, are disabled on a flagged row,
 * and why `approveSchoolBookingRequest` refuses a count override on one
 * server-side. Do not use this to derive anything a booking is priced from.
 */
function deriveChildCounts(
  guests: Array<{ ageTier: string }>,
): Record<SchoolChildTier, string> {
  const counts: Record<SchoolChildTier, number> = { INFANT: 0, CHILD: 0, YOUTH: 0 };
  for (const guest of guests) {
    if ((SCHOOL_CHILD_TIERS as readonly string[]).includes(guest.ageTier)) {
      counts[guest.ageTier as SchoolChildTier] += 1;
    }
  }
  return {
    INFANT: String(counts.INFANT),
    CHILD: String(counts.CHILD),
    YOUTH: String(counts.YOUTH),
  };
}

/**
 * #2342: does this request carry stored data the server could not read back?
 *
 * True for ANY of the three per-blob flags. A row in this state cannot be
 * quoted, priced, held or approved — every one of those routes now strict-reads
 * the stored blobs and refuses — so the panel disables those affordances rather
 * than offering buttons that are guaranteed to fail. Decline is deliberately
 * NOT gated: it works end to end on a flagged row and is the intended way out.
 */
function storedDataNeedsAttention(request: {
  guestDataNeedsAttention?: boolean;
  linkedMemberDataNeedsAttention?: boolean;
  quoteDataNeedsAttention?: boolean;
}): boolean {
  return Boolean(
    request.guestDataNeedsAttention ||
      request.linkedMemberDataNeedsAttention ||
      request.quoteDataNeedsAttention,
  );
}

function parseCount(value: string): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

type PublicRequestFilter =
  | "QUEUE"
  | "NEW"
  | "VERIFIED"
  | "PRICED"
  | "QUOTED"
  | "QUOTE_SENT"
  | "QUERY_PENDING"
  | "MODIFICATION_REQUESTED"
  | "ACCEPTED"
  | "APPROVED"
  | "DECLINED"
  | "CANCELLED"
  | "CONVERTED"
  | "ALL";

const publicRequestFilters = new Set<PublicRequestFilter>([
  "QUEUE",
  "NEW",
  "VERIFIED",
  "PRICED",
  "QUOTED",
  "QUOTE_SENT",
  "QUERY_PENDING",
  "MODIFICATION_REQUESTED",
  "ACCEPTED",
  "APPROVED",
  "DECLINED",
  "CANCELLED",
  "CONVERTED",
  "ALL",
]);

function isPublicRequestFilter(value: string | null): value is PublicRequestFilter {
  return publicRequestFilters.has(value as PublicRequestFilter);
}

interface PublicBookingRequestData {
  id: string;
  type: string;
  status:
    | "NEW"
    | "VERIFIED"
    | "PRICED"
    | "QUOTED"
    | "QUOTE_SENT"
    | "QUERY_PENDING"
    | "MODIFICATION_REQUESTED"
    | "ACCEPTED"
    | "APPROVED"
    | "DECLINED"
    | "CANCELLED"
    | "CONVERTED";
  schoolName: string | null;
  // #2263: the whole-lodge exclusivity ask, and — for a request that came from a
  // signed-in account — who made it. `requestedByMemberId` is the member-origin
  // discriminator; a member whole-lodge request is `type: "GENERAL"`, so the
  // type alone cannot identify one.
  exclusivityRequested: boolean;
  requestedByMemberId: string | null;
  requestedByMemberName: string | null;
  // Null lodgeId means the club's default lodge (pre-multi-lodge rows and
  // single-lodge submissions).
  lodgeId: string | null;
  lodgeName: string | null;
  // #2749: the other/partner lodge the requester said they belong to. Null
  // otherLodgeId means "No". When set, per-guest-night rates pre-fill at the
  // Full-member rate instead of the non-member rate.
  otherLodgeId: string | null;
  otherLodgeName: string | null;
  // #2749: suggested per-guest-night rates by age tier (non-member + Full-member
  // nightly cents), read from the fee config at the stay's check-in night.
  suggestedGuestNightRates: Record<
    string,
    { nonMemberCents: number | null; memberCents: number | null }
  >;
  // Effective school-group soft cap for this request's lodge, resolved
  // server-side through the same settings path enforcement uses so the queue
  // hint and the actual warning threshold cannot diverge per lodge (#1656).
  schoolGroupSoftCap: number;
  cateringPreference: "CATERED" | "NON_CATERED" | "QUOTE_BOTH" | null;
  teachers: Array<{ firstName: string; lastName: string; email: string | null }>;
  linkedGuestMembers: Array<{ guestIndex: number; memberId: string }>;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone: string | null;
  checkIn: string;
  checkOut: string;
  guests: Array<{ firstName: string; lastName: string; ageTier: string }>;
  // #2342: one flag per stored JSON blob, each present (and always true) only
  // when THAT blob failed validation on the server; all three are absent on a
  // well-formed request. Kept separate rather than OR'd into one, because the
  // panel has to be able to say which thing is wrong — telling an officer their
  // member links are hidden when the links parsed fine, or to distrust names
  // that validated, is worse than saying nothing.
  //
  // `guests` above is then the salvaged list (names as saved, bar collapsed
  // line breaks and a 100-character cap) rather than validated data.
  guestDataNeedsAttention?: boolean;
  // `linkedGuestMembers` above is then empty — no half-trusted links.
  linkedMemberDataNeedsAttention?: boolean;
  // `latestQuote.options` below is then empty.
  quoteDataNeedsAttention?: boolean;
  message: string | null;
  indicativePriceCents: number | null;
  priceCents: number | null;
  // #2338: the flat whole-lodge total for a member whole-lodge request (nights x
  // the covering season's flat rate), or null when no flat rate covers the stay.
  // Present only for member whole-lodge requests; the approve panel offers the
  // "price as whole lodge" toggle only when this is non-null.
  wholeLodgeFlatTotalCents?: number | null;
  verifiedAt: string | null;
  pricedAt: string | null;
  pricedByMemberId: string | null;
  pricedByMemberName: string | null;
  reviewedAt: string | null;
  reviewedByMemberId: string | null;
  reviewedByMemberName: string | null;
  declineReason: string | null;
  convertedBookingId: string | null;
  attendeesConfirmedAt: string | null;
  convertedMemberId: string | null;
  heldBookingId: string | null;
  // #2936: the row's optimistic-concurrency counter, sent back with a
  // correction so the server refuses one written over a request an accept or a
  // decline has moved underneath the officer.
  version: number;
  /**
   * The held booking's own status, or null when there is no hold (#3412 review,
   * F16). The pointer alone does not say whether beds are actually reserved: a
   * cancelled booking leaves a stale pointer that reserves nothing, and the
   * service deliberately lets the officer past it. This is that field, so panel
   * and service ask the same question of the same data.
   */
  heldBookingStatus: string | null;
  acceptedQuoteOptionId: string | null;
  acceptedPriceCents: number | null;
  acceptedAt: string | null;
  responseMessage: string | null;
  responseMessageAt: string | null;
  latestQuote: {
    id: string;
    version: number;
    status: "DRAFT" | "SENT" | "ACCEPTED" | "CANCELLED" | "SUPERSEDED";
    pricingMode: "OVERALL_TOTAL" | "PER_GUEST_NIGHT";
    sentAt: string | null;
    responseTokenExpiresAt: string | null;
    options: Array<{
      id: string;
      label: string;
      totalCents: number;
      cateringOption: "CATERED" | "NON_CATERED" | null;
    }>;
  } | null;
  createdAt: string;
}

interface MemberSearchResult {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface UiMemberLink {
  guestIndex: number;
  memberId: string;
  label?: string;
}

// Advisory-only member-night conflict surfaced when the admin links a guest to
// a real member (issue #1226). Purely informational — the hard block stays at
// approve/hold time — so we only carry the fields the warning renders.
//
// These stay REQUIRED even though `BookingMemberNightConflict` now makes the
// booking half optional (#2250): the only producer of this payload,
// `POST /api/admin/booking-requests/[id]/link-conflicts`, runs behind
// `requireAdmin` and passes `actorRole: "ADMIN"`, so every row it returns is
// `canOpenBooking` and carries the owner and stay dates this warning renders.
interface LinkMemberNightConflict {
  memberId: string;
  memberName: string;
  bookingOwnerName: string;
  bookingCheckIn: string;
  bookingCheckOut: string;
  conflictingNights: string[];
}

// Booking-request statuses whose card renders the pricing/linking editor — and
// therefore the advisory member-night banner. Shared by the render guard and
// the on-load advisory pre-compute so the two never drift: we only fire the
// pre-check for requests that can actually surface the banner.
const LINKING_EDITOR_STATUSES = new Set<PublicBookingRequestData["status"]>([
  "VERIFIED",
  "PRICED",
  "QUOTED",
  "QUOTE_SENT",
  "QUERY_PENDING",
  "MODIFICATION_REQUESTED",
]);

/**
 * #2263: a request submitted through the authenticated member whole-lodge door.
 * Mirrors `isMemberWholeLodgeRequest` in src/lib/booking-request.ts — the client
 * copy exists because the panel only ever sees the serialised row, and it must
 * agree with the server exactly or the wrong approval branch is offered.
 */
function isMemberWholeLodgeRequest(request: PublicBookingRequestData) {
  return Boolean(request.requestedByMemberId) && request.exclusivityRequested;
}

// #2338: nights in a check-in/check-out range, for the whole-lodge flat-price
// caption. Both endpoints are parsed identically, so the span is exact.
function nightsBetween(checkIn: string, checkOut: string): number {
  return countNightsDateOnly(new Date(checkIn), new Date(checkOut));
}

/**
 * A real INSTANT in the club's PERSISTED timezone (CT-4, #2870; INV-CONFIG-002).
 * A hook rather than a plain function because the zone is not a module constant
 * any more: it reaches the browser as data through `ClubTimeProvider`, never
 * from `process.env` and never from the viewer's own clock.
 */
function useInstantFormatter() {
  const clubTime = useClubTime();
  return (value: string | null) =>
    value ? clubTime.instantDateTime(new Date(value)) : null;
}

function statusBadgeClass(status: PublicBookingRequestData["status"]) {
  if (status === "NEW") return "border-border bg-muted text-muted-foreground";
  if (
    status === "VERIFIED" ||
    status === "PRICED" ||
    status === "QUOTED" ||
    status === "QUOTE_SENT" ||
    status === "QUERY_PENDING" ||
    status === "MODIFICATION_REQUESTED"
  ) return "border-warning-6 bg-warning-3 text-warning-11";
  if (status === "APPROVED" || status === "CONVERTED") return "border-success-6 bg-success-3 text-success-11";
  return "border-border bg-muted text-muted-foreground";
}

interface PublicBookingRequestsPanelProps {
  basePath?: string;
  fixedSearchParams?: Record<string, string>;
  showHeading?: boolean;
  canEdit?: boolean;
}

const EMPTY_SEARCH_PARAMS: Record<string, string> = {};

const FILTER_LABELS: Record<PublicRequestFilter, string> = {
  QUEUE: "Queue",
  NEW: "Awaiting verification",
  VERIFIED: "Verified",
  PRICED: "Priced",
  QUOTED: "Quoted",
  QUOTE_SENT: "Quote sent",
  QUERY_PENDING: "Query",
  MODIFICATION_REQUESTED: "Modify",
  ACCEPTED: "Accepted",
  APPROVED: "Approved",
  DECLINED: "Declined",
  CANCELLED: "Cancelled",
  CONVERTED: "Converted",
  ALL: "All",
};

function buildPublicRequestsPath(
  basePath: string,
  currentSearch: string,
  fixedSearchParams: Record<string, string>,
  status: PublicRequestFilter,
  requestId: string | null,
) {
  return buildBookingRequestDatasetPath({
    basePath,
    currentSearch,
    fixedSearchParams,
    status,
    defaultStatus: "QUEUE",
    recordKey: "requestId",
    recordId: requestId,
  });
}

export function PublicBookingRequestsPanel({
  basePath = "/admin/booking-requests",
  fixedSearchParams = EMPTY_SEARCH_PARAMS,
  showHeading = true,
  canEdit = true,
}: PublicBookingRequestsPanelProps) {
  /*
    The club's RECORDED currency, not the build's (#3564; INV-CONFIG-006).
    This label was the transitional constant from `@/config/operational`,
    which is `NEXT_PUBLIC_CURRENCY` inlined at BUILD time and therefore
    `undefined` in the published image, so a club charging in anything but
    New Zealand dollars was shown NZD here whatever it had configured.
  */
  const { currencyCode } = useClubFormat();
  const formatDateTime = useInstantFormatter();
  const { hutLeaderLabel } = useClubIdentity();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("status");
  const requestId = searchParams.get("requestId");
  /*
    #2887: the lodge badge follows `request.lodgeName` and nothing else.

    ADR-002's "no lodge copy in a single-lodge club" rule is applied SERVER-side
    now (`serializeBookingRequestForAdmin` takes the active-lodge count and
    nulls the name below two), which is the only place it can be applied
    honestly. This panel counted the lodge-options hook's list instead, and that
    was wrong in both directions:

      - too closed: `/api/admin/lodges` then needed `lodge:view`, which
        `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` lack, so a multi-lodge club's
        officer queue rendered with no lodge on a MUTATION surface. #2925
        relaxed that route; this still belongs server-side regardless;
      - too open: once this PR made the whole-lodge form always send the sole
        lodge id, new single-lodge rows carry a real name, so a genuine
        single-lodge club would have shown a permanent badge.

    One rule, one place, and the client stops guessing.
  */
  const [requests, setRequests] = useState<PublicBookingRequestData[]>([]);
  const [filter, setFilter] = useState<PublicRequestFilter>(
    isPublicRequestFilter(initialFilter) ? initialFilter : "QUEUE"
  );
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [pricingModes, setPricingModes] = useState<
    Record<string, "OVERALL_TOTAL" | "PER_GUEST_NIGHT">
  >({});
  const [rateInputs, setRateInputs] = useState<Record<string, string>>({});
  const [memberLinks, setMemberLinks] = useState<Record<string, UiMemberLink[]>>({});
  const [linkConflicts, setLinkConflicts] = useState<
    Record<string, LinkMemberNightConflict[]>
  >({});
  // Per-request sequence token (#1226 follow-up): each advisory pre-check bumps
  // its request's token, so a slower earlier response can never overwrite a
  // newer one — only the latest request's result is applied.
  const linkConflictSeqRef = useRef<Record<string, number>>({});
  // Request ids whose advisory has already been fired on load, so the load-time
  // effect runs the pre-check at most once per request.
  const linkConflictLoadedRef = useRef<Set<string>>(new Set<string>());
  const [memberQueries, setMemberQueries] = useState<Record<string, string>>({});
  const [memberResults, setMemberResults] = useState<
    Record<string, MemberSearchResult[]>
  >({});
  const [countInputs, setCountInputs] = useState<
    Record<string, Record<SchoolChildTier, string>>
  >({});
  const [declineReasons, setDeclineReasons] = useState<Record<string, string>>({});
  // #2263: per-request approval inputs for a member whole-lodge request — the
  // officer-confirmed headcount, and the manual total that is the mandatory
  // fallback when no season covers the dates.
  const [wholeLodgeHeadcounts, setWholeLodgeHeadcounts] = useState<
    Record<string, string>
  >({});
  const [wholeLodgePrices, setWholeLodgePrices] = useState<Record<string, string>>(
    {},
  );
  // #2338: the officer's per-approval pricing choice for a member whole-lodge
  // request. Absent/"per-guest" (the default) keeps today's per-guest pricing so
  // nothing changes silently; "whole-lodge" charges the season's flat rate.
  // Offered only when the request carries a non-null wholeLodgeFlatTotalCents.
  const [wholeLodgePricingModes, setWholeLodgePricingModes] = useState<
    Record<string, "per-guest" | "whole-lodge">
  >({});
  // Per-request owner-contact decision (issue #1255): default is to create a new
  // non-login contact; the admin may instead map to an existing one.
  const [ownerChoices, setOwnerChoices] = useState<Record<string, OwnerContactChoice>>({});
  // Request id whose "Release hold" action is awaiting inline confirmation.
  const [releaseConfirmId, setReleaseConfirmId] = useState<string | null>(null);
  // #1791: the request awaiting the admin's decline notify-or-not choice, and
  // whether the choice dialog is open. Declining always emails the requester
  // (contactEmail is always present), so the dialog is shown on every decline.
  const [declineChoice, setDeclineChoice] =
    useState<PublicBookingRequestData | null>(null);
  const [declineDialogOpen, setDeclineDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const [errorAttentionVersion, setErrorAttentionVersion] = useState(0);
  const [recoveryAttentionVersion, setRecoveryAttentionVersion] = useState(0);
  const [declineRecovery, setDeclineRecovery] = useState<{
    requestId: string;
    heldBookingId: string | null;
    message: string;
  } | null>(null);

  function showActionError(message: string) {
    setError(message);
    setErrorAttentionVersion((version) => version + 1);
  }

  function ownerChoiceFor(requestId: string): OwnerContactChoice {
    return ownerChoices[requestId] ?? { mode: "create" };
  }

  // The mapped contact id to send to hold/approve, or undefined for create-new.
  // A held booking's owner is already fixed, so the decision is only threaded
  // while the owner has not yet been materialised.
  function mappedOwnerContactId(request: PublicBookingRequestData): string | undefined {
    if (request.heldBookingId) return undefined;
    const choice = ownerChoiceFor(request.id);
    return choice.mode === "map" && choice.memberId ? choice.memberId : undefined;
  }

  // True when the admin picked "map to existing" but has not yet chosen a
  // contact — block the action so the decision is not silently lost to a new
  // contact. Never applies once the owner is fixed by a hold.
  function ownerChoiceNeedsContact(request: PublicBookingRequestData): boolean {
    if (request.heldBookingId) return false;
    const choice = ownerChoiceFor(request.id);
    return choice.mode === "map" && !choice.memberId;
  }
  const currentPath = buildPublicRequestsPath(
    basePath,
    searchParams.toString(),
    fixedSearchParams,
    filter,
    requestId,
  );

  useEffect(() => {
    router.replace(currentPath, { scroll: false });
  }, [currentPath, router]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/booking-requests?status=${filter}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load booking requests");
      }
      setRequests(Array.isArray(data?.data) ? data.data : []);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load booking requests");
      return false;
    } finally {
      setLoading(false);
    }
    // setState functions are referentially stable; they are listed so the
    // manual dependencies match what the React Compiler infers.
  }, [filter, setError, setLoading, setRequests]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // #2801: this used to open with `if (request.id in priceInputs) return
  // priceInputs[request.id]`, and a mutation probe proved that branch DEAD.
  // Every write to `priceInputs` goes through `priceInputKey`, which keys
  // `${requestId}:${optionId}` - so a bare request id is never a key there and
  // the lookup could only ever miss. It is a leftover from before totals became
  // per-option. Deleting it removes the indexed read rather than guarding it,
  // and this function is now purely the fallback its one caller wants: the
  // figure to show when the officer has not typed in that option's box.
  function priceInputValue(request: PublicBookingRequestData) {
    const cents = request.priceCents ?? request.indicativePriceCents;
    return cents != null ? (cents / 100).toFixed(2) : "";
  }

  function quoteOptionIds(request: PublicBookingRequestData) {
    if (request.type !== "SCHOOL") return ["STANDARD"];
    if (request.cateringPreference === "CATERED") return ["CATERED"];
    if (request.cateringPreference === "NON_CATERED") return ["NON_CATERED"];
    return ["CATERED", "NON_CATERED"];
  }

  function optionLabel(optionId: string) {
    if (optionId === "CATERED") return "Catered";
    if (optionId === "NON_CATERED") return "Non-catered";
    return "Quote";
  }

  function priceInputKey(requestId: string, optionId: string) {
    return `${requestId}:${optionId}`;
  }

  function rateInputKey(
    requestId: string,
    optionId: string,
    ageTier: string,
    isMember: boolean
  ) {
    return `${requestId}:${optionId}:${ageTier}:${isMember ? "member" : "non-member"}`;
  }

  // #2749: the non-member nightly rate for a tier, as a dollar string ("" if
  // none). Shown as the reference line under a field pre-filled at the Full-
  // member rate.
  function nonMemberRateDollars(
    request: PublicBookingRequestData,
    ageTier: string,
  ) {
    const cents = request.suggestedGuestNightRates[ageTier]?.nonMemberCents;
    return cents != null ? (cents / 100).toFixed(2) : "";
  }

  // #2749: the suggested pre-fill value for a rate field. A member combo, or any
  // combo when the requester indicated another lodge, uses the Full-member rate;
  // an ordinary non-member combo uses the non-member rate.
  function suggestedRateDollars(
    request: PublicBookingRequestData,
    combo: { ageTier: string; isMember: boolean },
  ) {
    const tierRates = request.suggestedGuestNightRates[combo.ageTier];
    if (!tierRates) return "";
    const useMemberRate = combo.isMember || request.otherLodgeId != null;
    const cents = useMemberRate ? tierRates.memberCents : tierRates.nonMemberCents;
    return cents != null ? (cents / 100).toFixed(2) : "";
  }

  function activeMemberLinks(request: PublicBookingRequestData): UiMemberLink[] {
    return memberLinks[request.id] ?? request.linkedGuestMembers;
  }

  function linkedMemberIdFor(request: PublicBookingRequestData, guestIndex: number) {
    return activeMemberLinks(request).find((link) => link.guestIndex === guestIndex)?.memberId;
  }

  function pricingCombos(request: PublicBookingRequestData) {
    const seen = new Set<string>();
    const combos: Array<{ ageTier: string; isMember: boolean }> = [];
    plannedGuests(request).forEach((guest, guestIndex) => {
      const isMember = Boolean(linkedMemberIdFor(request, guestIndex));
      const key = `${guest.ageTier}:${isMember}`;
      if (!seen.has(key)) {
        seen.add(key);
        combos.push({ ageTier: guest.ageTier, isMember });
      }
    });
    return combos;
  }

  function optionTotalInputValue(request: PublicBookingRequestData, optionId: string) {
    const key = priceInputKey(request.id, optionId);
    // Same read-the-value rule as `priceInputValue`, and the same reason: ""
    // means the officer emptied this option's total and must reach the refusal.
    const typed = priceInputs[key];
    if (typed !== undefined) return typed;
    if (request.latestQuote) {
      const option = request.latestQuote.options.find((item) => item.id === optionId);
      if (option) return (option.totalCents / 100).toFixed(2);
    }
    if (optionId === "STANDARD") return priceInputValue(request);
    return "";
  }

  function childCountValues(
    request: PublicBookingRequestData,
  ): Record<SchoolChildTier, string> {
    return countInputs[request.id] ?? deriveChildCounts(request.guests);
  }

  /**
   * The school group-number override to POST, or null for "leave the submitted
   * numbers alone" — the ONE place that decision and that payload are made
   * (#3412). Save quote and Approve both send it, under the same condition:
   * the officer edited the boxes on a SCHOOL request. Two surfaces building the
   * same body separately is how they came to disagree in the first place.
   */
  function schoolChildCountOverride(
    request: PublicBookingRequestData,
  ): Record<SchoolChildTier, number> | null {
    if (request.type !== "SCHOOL" || !(request.id in countInputs)) return null;
    const counts = childCountValues(request);
    return {
      INFANT: parseCount(counts.INFANT),
      CHILD: parseCount(counts.CHILD),
      YOUTH: parseCount(counts.YOUTH),
    };
  }

  /**
   * The party the officer is about to quote: the edited numbers where they
   * edited them, the stored list otherwise (#3412). The rate boxes below are
   * built from this, because saving regenerates the list from these same
   * numbers — read from the stored list instead, a group changed from youth to
   * children would be quoted with no child rate field at all and the save would
   * fail on a missing rate.
   *
   * It carries NAMES as well as tiers, because every question below is about
   * which stored rows the regeneration moves, and a row is only unmoved if it
   * is identical — tier and name. This mirrors the server's
   * `generateSchoolGuests`: the named teachers first, then the children
   * numbered 1..N across the tiers in order. That mirroring is a known
   * duplication (the remedy needs the `AgeTier` enum as a runtime value in this
   * bundle); the comparison helpers below are shared with the server, so what
   * is duplicated is the composition rule alone.
   */
  function plannedGuests(
    request: PublicBookingRequestData,
  ): Array<{ firstName: string; lastName: string; ageTier: string }> {
    const override = schoolChildCountOverride(request);
    if (!override) return request.guests;
    let childNumber = 0;
    return [
      ...request.teachers.map((teacher) => ({
        firstName: teacher.firstName,
        lastName: teacher.lastName,
        ageTier: "ADULT",
      })),
      ...SCHOOL_CHILD_TIERS.flatMap((tier) =>
        Array.from({ length: override[tier] }, () => {
          childNumber += 1;
          return {
            firstName: SCHOOL_CHILD_NAME_PREFIX,
            lastName: String(childNumber),
            ageTier: tier as string,
          };
        }),
      ),
    ];
  }

  /**
   * Does the officer's edit actually change the party? (#3412)
   *
   * Asked of the two LISTS, element by element, through the same helper the
   * server's resolver uses — not by comparing per-tier totals, which is a
   * different question wearing the same answer most of the time. False when
   * they typed the stored numbers back, which is why the refusals below key on
   * this rather than on "a box was touched".
   */
  function schoolCountsChanged(request: PublicBookingRequestData) {
    if (schoolChildCountOverride(request) === null) return false;
    return !sameSchoolGuestList(request.guests, plannedGuests(request));
  }

  /**
   * #3412: beds held for this request's current numbers cannot be re-sized by a
   * quote save, so the server refuses one (409). Say so here, before the click,
   * and point at the button that clears it.
   *
   * Keyed on the hold's STATUS, which the queue serialises, and not merely on
   * the pointer: the server blocks only a live `AWAITING_REVIEW` hold, because
   * a pointer left behind by a cancelled booking reserves nothing and "must not
   * trap the officer". Keyed on the pointer, this panel disabled Save quote and
   * sent the officer to Release hold, which 409s on a dead pointer — both doors
   * shut on a save the server would have accepted (#3412 review, F16).
   */
  function schoolHoldIsLive(request: PublicBookingRequestData) {
    return request.heldBookingStatus === "AWAITING_REVIEW";
  }

  function countChangeBlockedByHold(request: PublicBookingRequestData) {
    return schoolHoldIsLive(request) && schoolCountsChanged(request);
  }

  /**
   * The member link these numbers would move onto somebody else's bed, if any
   * (#3412 review, F7).
   *
   * The children are numbered placeholders, so a link stored against child #7
   * comes to mean a DIFFERENT child once the list is renumbered — the server
   * refuses the save for it (422). Working that out before the click is as
   * cheap as the hold check, and without it the officer links a member, adjusts
   * the numbers, and presses a Save quote that is certain to fail.
   *
   * The boundary is derived from the two lists, exactly as the server derives
   * it, rather than counted in the `teachers` column and applied to `guests`.
   */
  function misplacedSchoolLinkAmong(
    request: PublicBookingRequestData,
    links: readonly UiMemberLink[],
  ): UiMemberLink | null {
    if (!schoolCountsChanged(request)) return null;
    const unchangedPrefix = unchangedSchoolGuestPrefixLength(
      request.guests,
      plannedGuests(request),
    );
    return (
      [...links]
        .sort((a, b) => a.guestIndex - b.guestIndex)
        .find((link) => link.guestIndex >= unchangedPrefix) ?? null
    );
  }

  /**
   * What SAVE QUOTE would be refused for: it posts the links on screen
   * (`activeMemberLinks`, the officer's edits where they made any), and the
   * service checks the list it is about to write.
   */
  function misplacedSchoolLink(
    request: PublicBookingRequestData,
  ): UiMemberLink | null {
    return misplacedSchoolLinkAmong(request, activeMemberLinks(request));
  }

  /**
   * What APPROVE would be refused for — and it is a DIFFERENT question (#3412
   * review round 5, C).
   *
   * Approve posts no links at all: the service reads the `linkedGuestMembers`
   * blob SAVED on the request and applies it positionally to the regenerated
   * list. So an officer who unlinks a member on screen watches the save-quote
   * warning clear and Save quote come back, and then gets a 422 from Approve
   * naming the link they just removed — because unlinking on screen has not
   * reached the row yet.
   *
   * Each door is therefore drawn against what THAT door reads. This one is the
   * stored blob, and it gates the Approve button.
   */
  function misplacedSchoolLinkOnApprove(
    request: PublicBookingRequestData,
  ): UiMemberLink | null {
    return misplacedSchoolLinkAmong(request, request.linkedGuestMembers);
  }

  /**
   * Link edits made on screen that no save has carried to the request (#3412
   * review round 5, C).
   *
   * Approve reads the stored blob, so an unsaved link is not refused — it is
   * SILENTLY DROPPED, and that member is invoiced at non-member rates. Nothing
   * about the screen says so, and this round made it worse by disabling Save
   * quote in exactly the state where a link has been added and the numbers
   * changed: Approve was left as the only enabled way out of it.
   *
   * Approve is not disabled for this. Approving the stored links is a
   * legitimate thing to do, and Save quote is not always available to clear it
   * — the officer is told what will happen instead, before the click.
   */
  function unsavedLinkEditCount(request: PublicBookingRequestData) {
    const local = memberLinks[request.id];
    if (!local) return 0;
    const stored = new Map(
      request.linkedGuestMembers.map((link) => [link.guestIndex, link.memberId]),
    );
    const localMap = new Map(
      local.map((link) => [link.guestIndex, link.memberId]),
    );
    let differences = 0;
    new Set([...stored.keys(), ...localMap.keys()]).forEach((guestIndex) => {
      if (stored.get(guestIndex) !== localMap.get(guestIndex)) differences += 1;
    });
    return differences;
  }

  /** How the misplaced link's row reads on screen, so the officer can find it. */
  function schoolGuestRowLabel(
    request: PublicBookingRequestData,
    guestIndex: number,
  ) {
    const guest = request.guests[guestIndex];
    return guest ? `${guest.firstName} ${guest.lastName}` : `row ${guestIndex + 1}`;
  }

  /** Every reason this request's adjusted numbers cannot be saved right now. */
  function countChangeBlocked(request: PublicBookingRequestData) {
    return countChangeBlockedByHold(request) || misplacedSchoolLink(request) !== null;
  }

  // Teachers/parent helpers (ADULT) plus the current (possibly edited) children.
  function plannedGuestTotal(request: PublicBookingRequestData) {
    const counts = childCountValues(request);
    const children = SCHOOL_CHILD_TIERS.reduce(
      (sum, tier) => sum + parseCount(counts[tier]),
      0,
    );
    return request.teachers.length + children;
  }

  // #2685: the canonical exact parser. `null` already reaches the officer as a
  // thrown "Enter a valid …" message below, and now covers a malformed suffix or
  // a third decimal place rather than silently keeping the leading digits.
  function dollarsToCents(raw: string) {
    return parseDecimalDollarsToCents(raw);
  }

  async function handleCreateQuote(request: PublicBookingRequestData) {
    // #3412 review (F14): no early return restating the service's refusal. The
    // button is disabled by the same predicate, so it was unreachable, and the
    // `catch` below already shows the server's own sentence verbatim — which
    // makes the service the ONE place that wording lives.
    setActioningId(request.id);
    setError("");
    try {
      const pricingMode = pricingModes[request.id] ?? "OVERALL_TOTAL";
      const optionIds = quoteOptionIds(request);
      const options = optionIds.map((optionId) => {
        if (pricingMode === "OVERALL_TOTAL") {
          const totalCents = dollarsToCents(optionTotalInputValue(request, optionId));
          if (totalCents == null) {
            throw new Error(`Enter a valid ${optionLabel(optionId).toLowerCase()} total`);
          }
          return {
            id: optionId,
            cateringOption: optionId === "STANDARD" ? null : optionId,
            totalCents,
          };
        }

        const guestNightRates = pricingCombos(request).map((combo) => {
          const key = rateInputKey(request.id, optionId, combo.ageTier, combo.isMember);
          // Fall back to the pre-filled suggestion (#2749) so a field the officer
          // left untouched submits the shown value, not a blank.
          const rateCents = dollarsToCents(
            rateInputs[key] ?? suggestedRateDollars(request, combo),
          );
          if (rateCents == null) {
            throw new Error(
              `Enter a valid ${optionLabel(optionId).toLowerCase()} ${combo.ageTier} ${combo.isMember ? "member" : "non-member"} rate`
            );
          }
          return { ...combo, rateCents };
        });
        return {
          id: optionId,
          cateringOption: optionId === "STANDARD" ? null : optionId,
          guestNightRates,
        };
      });

      // #3412: saving the quote is the moment the officer's adjusted group
      // numbers become real — the same override approval takes, sent under the
      // same condition, so the price, the beds and the approval agree.
      const childCounts = schoolChildCountOverride(request);
      const response = await fetch(`/api/admin/booking-requests/${request.id}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pricingMode,
          options,
          linkedGuestMembers: activeMemberLinks(request).map(({ guestIndex, memberId }) => ({
            guestIndex,
            memberId,
          })),
          ...(childCounts ? { childCounts } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to create quote");
      }
      // #3412: the numbers are now stored on the request, so drop the local
      // edit and let the boxes prefill from what was saved. Kept, the unsaved
      // copy would keep winning over the server's and re-post itself on every
      // later action long after the officer moved on.
      if (childCounts) {
        setCountInputs((prev) => {
          const next = { ...prev };
          delete next[request.id];
          return next;
        });
      }
      toast.success("Quote saved");
      await fetchRequests();
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Failed to create quote");
    } finally {
      setActioningId(null);
    }
  }

  async function handleSendQuote(request: PublicBookingRequestData) {
    if (ownerChoiceNeedsContact(request)) {
      showActionError(
        "Choose an existing contact to map to, or switch to 'Create a new contact'."
      );
      return;
    }
    setActioningId(request.id);
    setError("");
    try {
      // Sending a quote auto-holds capacity, which materialises the owner
      // contact, so the map-to-existing decision (issue #1255) must ride along.
      const ownerContactMemberId = mappedOwnerContactId(request);
      // #3412 (review, B1): send the group numbers currently in the boxes, so
      // the service can refuse to hold beds and email the school for one party
      // while the officer is looking at another. Sending holds and emails from
      // the party STORED on the request, so an unsaved edit here is the very
      // defect this issue fixes, one button over.
      const childCounts = schoolChildCountOverride(request);
      const sendBody =
        ownerContactMemberId || childCounts
          ? {
              ...(ownerContactMemberId ? { ownerContactMemberId } : {}),
              ...(childCounts ? { childCounts } : {}),
            }
          : null;
      const response = await fetch(`/api/admin/booking-requests/${request.id}/send-quote`, {
        method: "POST",
        ...(sendBody
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(sendBody),
            }
          : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to send quote");
      }
      const deliveryError =
        data.emailDelivered === false
          ? "The quote was saved and its link is active, but the email could not be delivered — the requester has not received it. Check the contact email address, then send again or reach them another way."
          : "";
      if (!deliveryError) {
        toast.success("Quote sent");
      }
      await fetchRequests();
      if (deliveryError) showActionError(deliveryError);
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Failed to send quote");
    } finally {
      setActioningId(null);
    }
  }

  async function handleResendAttendeeLink(request: PublicBookingRequestData) {
    setActioningId(request.id);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/booking-requests/${request.id}/resend-attendee-confirmation`,
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to re-send the attendee link");
      }
      toast.success(`Attendee confirmation link sent to ${data.sentTo}`);
      await fetchRequests();
    } catch (err) {
      showActionError(
        err instanceof Error ? err.message : "Failed to re-send the attendee link",
      );
    } finally {
      setActioningId(null);
    }
  }

  async function handleHoldSlots(request: PublicBookingRequestData) {
    if (ownerChoiceNeedsContact(request)) {
      showActionError(
        "Choose an existing contact to map to, or switch to 'Create a new contact'."
      );
      return;
    }
    setActioningId(request.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/booking-requests/${request.id}/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optionId: request.latestQuote?.options[0]?.id,
          ownerContactMemberId: mappedOwnerContactId(request),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && Array.isArray(data.fullNights)) {
          throw new Error(
            `The lodge is at capacity for: ${data.fullNights
              .map((d: string) => formatStayDate(d))
              .join(", ")}`
          );
        }
        throw new Error(data.error || "Failed to hold slots");
      }
      toast.success(data.reused ? "Slots were already held" : "Slots held");
      await fetchRequests();
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Failed to hold slots");
    } finally {
      setActioningId(null);
    }
  }

  async function handleReleaseHold(request: PublicBookingRequestData) {
    if (!request.heldBookingId) return; // guard: nothing to release
    setActioningId(request.id);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/booking-requests/${request.id}/release-hold`,
        { method: "POST" }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to release hold");
      }
      toast.success("Hold released. You can now change the contact and re-hold.");
      setReleaseConfirmId(null);
      // Reset any stale mapping choice so the picker starts from "create new".
      setOwnerChoices((prev) => {
        const next = { ...prev };
        delete next[request.id];
        return next;
      });
      await fetchRequests();
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Failed to release hold");
    } finally {
      setActioningId(null);
    }
  }

  async function handleMemberSearch(requestId: string, guestIndex: number) {
    const key = `${requestId}:${guestIndex}`;
    const query = memberQueries[key]?.trim();
    if (!query) return;
    setError("");
    try {
      const response = await fetch(
        `/api/admin/members?q=${encodeURIComponent(query)}&active=true&pageSize=5`
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to search members");
      }
      setMemberResults((prev) => ({
        ...prev,
        [key]: Array.isArray(data.members) ? data.members : [],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search members");
    }
  }

  // Advisory-only pre-check (issue #1226): ask the server whether any linked
  // member is already on an overlapping booking. This runs both on load for
  // already-linked members and whenever the admin changes the guest→member
  // links. It never blocks — the 409 hard block stays at approve/hold time — it
  // just surfaces the overlap earlier so the admin can resolve it before
  // approving. A per-request sequence token guards against out-of-order
  // responses: a slower earlier request can never overwrite a newer result.
  const refreshLinkConflicts = useCallback(
    async (request: PublicBookingRequestData, links: UiMemberLink[]) => {
      const seq = (linkConflictSeqRef.current[request.id] ?? 0) + 1;
      linkConflictSeqRef.current[request.id] = seq;
      const isLatest = () => linkConflictSeqRef.current[request.id] === seq;

      if (links.length === 0) {
        // Nothing to check — clear synchronously. The seq bump above means any
        // still-in-flight earlier request is discarded when it resolves.
        setLinkConflicts((prev) => ({ ...prev, [request.id]: [] }));
        return;
      }
      try {
        const response = await fetch(
          `/api/admin/booking-requests/${request.id}/link-conflicts`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              links: links.map(({ guestIndex, memberId }) => ({
                guestIndex,
                memberId,
              })),
            }),
          }
        );
        const data = await response.json().catch(() => ({}));
        if (!isLatest()) return; // a newer request superseded this one — ignore
        if (!response.ok) return; // advisory only — never surface as a hard error
        setLinkConflicts((prev) => ({
          ...prev,
          [request.id]: Array.isArray(data.conflicts) ? data.conflicts : [],
        }));
      } catch {
        // Advisory pre-check is best-effort; ignore transport errors.
      }
    },
    [setLinkConflicts]
  );

  // Compute the advisory on load (#1226 follow-up): a request reopened with
  // already-persisted linked members would otherwise show no banner until the
  // admin re-linked. For each request whose card renders the linking editor
  // (and therefore the banner), fire the advisory once for its persisted links.
  // Gated to those statuses so we never fire authenticated pre-checks for
  // approved/declined requests that can't surface a banner, and recorded in a
  // ref only once fired so a request first seen without links still computes
  // when it later gains them.
  useEffect(() => {
    for (const request of requests) {
      if (linkConflictLoadedRef.current.has(request.id)) continue;
      if (!LINKING_EDITOR_STATUSES.has(request.status)) continue;
      if (request.linkedGuestMembers.length === 0) continue;
      linkConflictLoadedRef.current.add(request.id);
      void refreshLinkConflicts(request, request.linkedGuestMembers);
    }
  }, [requests, refreshLinkConflicts]);

  function handleLinkMember(
    request: PublicBookingRequestData,
    guestIndex: number,
    member: MemberSearchResult
  ) {
    const label = `${member.firstName} ${member.lastName}`.trim() || member.email;
    const nextLinks = activeMemberLinks(request).filter(
      (link) => link.guestIndex !== guestIndex
    );
    nextLinks.push({ guestIndex, memberId: member.id, label });
    setMemberLinks((prev) => ({ ...prev, [request.id]: nextLinks }));
    setMemberResults((prev) => ({ ...prev, [`${request.id}:${guestIndex}`]: [] }));
    void refreshLinkConflicts(request, nextLinks);
  }

  function handleUnlinkMember(request: PublicBookingRequestData, guestIndex: number) {
    const nextLinks = activeMemberLinks(request).filter(
      (link) => link.guestIndex !== guestIndex
    );
    setMemberLinks((prev) => ({ ...prev, [request.id]: nextLinks }));
    void refreshLinkConflicts(request, nextLinks);
  }

  async function handleApprove(request: PublicBookingRequestData) {
    if (ownerChoiceNeedsContact(request)) {
      showActionError(
        "Choose an existing contact to map to, or switch to 'Create a new contact'."
      );
      return;
    }
    setActioningId(request.id);
    setError("");
    try {
      // Only send a quantity override when the admin actually edited the school
      // group's child counts; otherwise approve with the submitted numbers —
      // the shared decision and payload (#3412). The map-to-existing-contact
      // decision (issue #1255) rides along in the same body when the admin
      // chose one and the owner is not already held.
      const childCounts = schoolChildCountOverride(request);
      const ownerContactMemberId = mappedOwnerContactId(request);
      const payload: Record<string, unknown> = {};
      if (childCounts) {
        payload.childCounts = childCounts;
      }
      if (ownerContactMemberId) {
        payload.ownerContactMemberId = ownerContactMemberId;
      }
      // #2263: the member whole-lodge approval carries its own two fields. The
      // headcount is only sent when the officer actually changed it; the price
      // override only when they typed one.
      if (isMemberWholeLodgeRequest(request)) {
        const headcountRaw = wholeLodgeHeadcounts[request.id];
        if (headcountRaw != null && headcountRaw.trim() !== "") {
          const headcount = Number(headcountRaw);
          if (!Number.isInteger(headcount) || headcount < 1) {
            throw new Error("Enter a whole number of guests to price");
          }
          if (headcount !== request.guests.length) {
            payload.pricedHeadcount = headcount;
          }
        }
        const priceRaw = wholeLodgePrices[request.id];
        if (priceRaw != null && priceRaw.trim() !== "") {
          const cents = dollarsToCents(priceRaw);
          if (cents == null) {
            throw new Error("Enter the price override as a dollar amount");
          }
          payload.priceOverrideCents = cents;
        }
        // #2338: the officer's per-approval pricing choice. Only meaningful (and
        // only offered) when a flat whole-lodge rate covers the stay; sent as
        // true only when the officer actively picked "price as whole lodge". A
        // manual price override, sent above, still wins over it server-side.
        if (
          request.wholeLodgeFlatTotalCents != null &&
          wholeLodgePricingModes[request.id] === "whole-lodge"
        ) {
          payload.priceAsWholeLodge = true;
        }
      }
      const hasBody = Object.keys(payload).length > 0;
      const response = await fetch(`/api/admin/booking-requests/${request.id}/approve`, {
        method: "POST",
        ...(hasBody
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }
          : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && Array.isArray(data.fullNights)) {
          throw new Error(
            `The lodge is at capacity for: ${data.fullNights
              .map((d: string) => formatStayDate(d))
              .join(", ")}`
          );
        }
        throw new Error(data.error || "Failed to approve request");
      }
      if (data.type === "MEMBER_WHOLE_LODGE") {
        // #2263: the conflict list is ADMIN-ONLY and never reaches the member.
        // It is surfaced here, after the fact, because ADR-001 decision 1 grants
        // the hold regardless — the officer is told what now overlaps so they
        // can sort it out, not asked to approve again.
        const conflicts = Array.isArray(data.exclusiveHoldConflicts)
          ? data.exclusiveHoldConflicts
          : [];
        // What actually happened to the money, stated plainly (school parity).
        // The booking is CONFIRMED but unpaid, so the officer needs to know
        // whether an invoice went out or whether they have to raise it.
        const invoiceSentence =
          data.invoiceMode === "xero"
            ? " The Xero invoice has been raised and the member has been emailed the amount owing and their payment reference."
            : data.invoiceMode === "manual"
              ? " The Xero module is off, so admins have been emailed to invoice the member manually — the member has been told an invoice is coming."
              : " This approval was an idempotent replay, so no new invoice or email was raised.";
        if (conflicts.length > 0) {
          toast.warning(
            `Whole-lodge booking confirmed and the lodge is now held for this group. ${
              conflicts.length === 1
                ? "1 existing booking overlaps"
                : `${conflicts.length} existing bookings overlap`
            } these nights — they were NOT cancelled. Sort them out with the people involved.${invoiceSentence}`,
          );
        } else {
          toast.success(
            `Whole-lodge booking confirmed. The lodge is now held for this group.${invoiceSentence}`,
          );
        }
      } else if (data.type === "SCHOOL") {
        toast.success(
          data.invoiceMode === "xero"
            ? "School booking confirmed. The Xero invoice has been emailed to the school and the teacher PIN email sent."
            : "School booking confirmed. The Xero module is off, so admins have been emailed to invoice the school manually."
        );
      } else {
        toast.success("Request approved. A payment link has been emailed to the requester.");
      }
      await fetchRequests();
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Failed to approve request");
    } finally {
      setActioningId(null);
    }
  }

  // #1791: open the notify-choice dialog for a decline. Declining always emails
  // the requester unless the admin opts out, so this is shown on every decline.
  function openDeclineChoice(request: PublicBookingRequestData) {
    setDeclineChoice(request);
    setDeclineDialogOpen(true);
  }

  // #1791: dispatch the pending decline with the admin's notify choice. Close
  // the dialog first so it does not linger while the request runs.
  function confirmDecline(notifyRequester: boolean) {
    const request = declineChoice;
    setDeclineDialogOpen(false);
    if (!request) return;
    void performDecline(request, notifyRequester);
  }

  async function performDecline(
    request: PublicBookingRequestData,
    notifyRequester: boolean,
  ) {
    setActioningId(request.id);
    setError("");
    try {
      const reason = declineReasons[request.id]?.trim();
      const response = await fetch(`/api/admin/booking-requests/${request.id}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reason || undefined,
          // #1791: absent = notify (default); false = suppress the decline email.
          notifyMember: notifyRequester,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.requestDeclined === true) {
          const recoveryBase = data.holdReleasePending === true
            ? "The request was declined, but its capacity hold still needs to be released. Do not decline this request again."
            : data.holdReleaseStatusUnconfirmed === true
              ? "The request was declined, but its capacity hold status could not be confirmed. Do not decline this request again."
              : "The request was declined, but the updated request could not be loaded. Do not decline this request again.";
          setRequests((current) =>
            current.filter((candidate) => candidate.id !== request.id),
          );
          setDeclineRecovery({
            requestId: request.id,
            heldBookingId: request.heldBookingId,
            message: recoveryBase,
          });
          setRecoveryAttentionVersion((version) => version + 1);
          const refreshed = await fetchRequests();
          // The refresh outcome is folded into the durable recovery below; do
          // not duplicate it in the ordinary action region or steal focus.
          setError("");
          const refreshResult = refreshed
            ? " The latest request queue was loaded; open the held booking and check its cancellation status."
            : " The request queue could not be refreshed. This warning remains active; open the held booking and check its cancellation status.";
          setDeclineRecovery({
            requestId: request.id,
            heldBookingId: request.heldBookingId,
            message: `${recoveryBase}${refreshResult}`,
          });
          setRecoveryAttentionVersion((version) => version + 1);
          return;
        }
        throw new Error(data.error || "Failed to decline request");
      }
      toast.success(
        "Request declined" +
          (notifyRequester ? "" : " The requester was not emailed."),
      );
      await fetchRequests();
    } catch (err) {
      showActionError(err instanceof Error ? err.message : "Failed to decline request");
    } finally {
      setActioningId(null);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below (and instead of repeating it inside every request
    card). The `role="status"` wrapper is permanently mounted so the live region
    is registered in the accessibility tree before its content appears; a region
    injected already-populated is silently dropped by some
    screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so the
    empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view booking requests but cannot price,
      hold, approve, decline, or change their linked contact.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      {showHeading ? (
        <div>
          <h1 className="text-3xl font-bold">Public booking requests</h1>
          <p className="mt-1 text-muted-foreground">
            Review, price and approve booking requests submitted by non-members from the website.
          </p>
        </div>
      ) : null}

      <FocusedActionError
        id="public-booking-requests-recovery"
        error={declineRecovery?.message ?? ""}
        attentionKey={recoveryAttentionVersion}
        heading={declineRecovery ? "Request declined - hold release pending" : undefined}
        action={
          declineRecovery?.heldBookingId ? (
            <Button asChild variant="outline" size="sm">
              <Link
                href={buildHrefWithReturnTo(
                  `/bookings/${encodeURIComponent(declineRecovery.heldBookingId)}`,
                  currentPath,
                )}
              >
                Open affected booking
              </Link>
            </Button>
          ) : undefined
        }
      />
      <FocusedActionError
        id="public-booking-requests-error"
        error={error}
        attentionKey={errorAttentionVersion}
        action={
          error ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setError("")}>
              Dismiss
            </Button>
          ) : undefined
        }
      />


      <div className="flex flex-wrap gap-2">
        {(Object.keys(FILTER_LABELS) as PublicRequestFilter[]).map((status) => (
          <Button
            key={status}
            variant={filter === status ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(status)}
          >
            {FILTER_LABELS[status]}
          </Button>
        ))}
        <DatasetResetButton
          disabled={filter === "QUEUE"}
          onReset={() => setFilter("QUEUE")}
        />
      </div>

      {loading ? (
        <div className="py-8 text-center">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No booking requests found for this filter.
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => {
            const isActioning = actioningId === request.id;
            // #2263: a member whole-lodge request has ONE admin lifecycle —
            // approve directly with a priced headcount, or decline. The quote,
            // officer-price and hold-slots controls are hidden below, and the
            // service layer refuses them too (booking-request-quotes.ts):
            // hiding is the UX, the 409 is the guarantee.
            const memberWholeLodge = isMemberWholeLodgeRequest(request);
            // One read for the advisory member-night overlaps below, which used
            // to look this entry up three times and guard only the first. No
            // entry means the pre-check has not run or found nothing, and an
            // empty list means it ran and found none -- the banner has always
            // treated those the same, so naming it changes no rendering.
            const requestLinkConflicts = linkConflicts[request.id] ?? [];
            // #2342: same shape as the line above — the acting affordances are
            // disabled below AND the routes refuse; the disable is the UX, the
            // 409 is the guarantee. Decline stays enabled: it is the one action
            // that works end to end on a flagged row.
            const dataNeedsAttention = storedDataNeedsAttention(request);
            const actionsBlocked = isActioning || dataNeedsAttention;

            return (
              <Card
                key={request.id}
                className={request.id === requestId ? "border-warning-6" : undefined}
              >
                <CardHeader>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <CardTitle className="text-lg">
                        {request.type === "SCHOOL" && request.schoolName
                          ? request.schoolName
                          : `${request.contactFirstName} ${request.contactLastName}`}
                      </CardTitle>
                      {request.type === "SCHOOL" ? (
                        <p className="text-sm text-muted-foreground">
                          Contact: {request.contactFirstName} {request.contactLastName}
                        </p>
                      ) : null}
                      <p className="text-sm text-muted-foreground">
                        {request.contactEmail}
                        {request.contactPhone ? ` · ${request.contactPhone}` : ""}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Submitted {formatDateTime(request.createdAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {request.lodgeName ? (
                        <Badge
                          variant="outline"
                          className="border-info-6 bg-info-3 text-info-11"
                        >
                          {request.lodgeName}
                        </Badge>
                      ) : null}
                      {request.type === "SCHOOL" ? (
                        <Badge
                          variant="outline"
                          className="border-cat3-6 bg-cat3-3 text-cat3-11"
                        >
                          School
                        </Badge>
                      ) : null}
                      {/* #2263: "Member" marks a request from a signed-in
                          account; "Whole lodge requested" marks the exclusivity
                          ask and renders for SCHOOL rows too, closing a display
                          gap that predates this feature. */}
                      <WholeLodgeRequestBadges
                        memberOrigin={isMemberWholeLodgeRequest(request)}
                        exclusivityRequested={request.exclusivityRequested}
                        requesterName={request.requestedByMemberName}
                      />
                      <Badge variant="outline" className={statusBadgeClass(request.status)}>
                        {request.status}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <span className="text-muted-foreground">Dates:</span>{" "}
                      {formatStayDate(request.checkIn)} to {formatStayDate(request.checkOut)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Nights:</span>{" "}
                      {nightsBetween(request.checkIn, request.checkOut)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Guests:</span> {request.guests.length}
                    </div>
                    {request.indicativePriceCents != null ? (
                      <div>
                        <span className="text-muted-foreground">Indicative price:</span>{" "}
                        {formatCents(request.indicativePriceCents)}
                      </div>
                    ) : null}
                    {request.priceCents != null ? (
                      <div>
                        <span className="text-muted-foreground">Quoted price:</span>{" "}
                        {formatCents(request.priceCents)}
                      </div>
                    ) : null}
                  </div>

                  {/* Only GENERAL public requests are asked the "other lodge"
                      question on the form (#2749). */}
                  {memberWholeLodge || request.type === "SCHOOL" ? null : (
                    <div className="text-sm">
                      <span className="text-muted-foreground">
                        Member of another Lodge:
                      </span>{" "}
                      {request.otherLodgeName ?? "No"}
                    </div>
                  )}

                  {request.type === "SCHOOL" && request.teachers.length > 0 ? (
                    <div className="text-sm">
                      <span className="text-muted-foreground">
                        Teachers &amp; parent helpers (
                        {hutLeaderLabel.toLowerCase()}s):
                      </span>{" "}
                      {request.teachers
                        .map((teacher) => `${teacher.firstName} ${teacher.lastName}`)
                        .join(", ")}
                    </div>
                  ) : null}

                  {/* #2342: one row with an unreadable stored blob used to 500
                      the whole page. It now renders, flagged, and the copy
                      names ONLY the blob that actually failed — an OR'd flag
                      described both failures whichever had happened. The
                      bordered warning box is this panel's idiom for a data
                      warning that changes what the officer should do (the
                      soft-cap hint, the link-conflict advisory, the requester
                      response); a bare warning paragraph is for passive status
                      lines like "waiting for the requester to verify". */}
                  {dataNeedsAttention ? (
                    <div
                      className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11"
                      role="status"
                    >
                      {/* Heading states the fact only. What follows from it
                          depends on the request's status, so the consequence
                          lives in the status-aware paragraph below rather than
                          here, where it would be wrong on a finalised row. */}
                      <p className="font-medium">
                        Saved details need attention
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {request.guestDataNeedsAttention ? (
                          <li>
                            The saved guest list could not be read back. The
                            names and age groups below are shown as they were
                            saved, so treat them as a rough record rather than
                            confirmed details.
                          </li>
                        ) : null}
                        {request.linkedMemberDataNeedsAttention ? (
                          <li>
                            The saved member links could not be read back, so no
                            linked members are shown for this request.
                          </li>
                        ) : null}
                        {request.quoteDataNeedsAttention ? (
                          <li>
                            The saved quote could not be read back, so its
                            options and totals are not shown.
                          </li>
                        ) : null}
                      </ul>
                      {/* The remedy depends on whether this request is still
                          open. The row that found this bug was CONVERTED, and
                          telling an officer to Decline a finalised request —
                          or that buttons it is not shown are turned off —
                          would be wrong on both counts. */}
                      {LINKING_EDITOR_STATUSES.has(request.status) ? (
                        <p className="mt-1">
                          Quoting, pricing, holding and approving are turned off
                          for this request and will be refused if attempted —
                          there is no screen for repairing the saved data. Check
                          what the group actually wants with the requester, then
                          either <strong>Decline</strong> it so they can submit
                          again, or ask support to repair the stored row.
                        </p>
                      ) : (
                        <p className="mt-1">
                          No decision is open on this request at its current
                          status, so nothing is blocked. If these details matter
                          — for the booking it became, or before it moves on —
                          ask support to repair the stored row.
                        </p>
                      )}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-1 text-sm">
                    {request.guests.map((guest, index) => (
                      <Badge key={index} variant="secondary">
                        {guest.firstName} {guest.lastName} — {guest.ageTier}
                      </Badge>
                    ))}
                  </div>

                  {request.message ? (
                    <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
                      {request.message}
                    </div>
                  ) : null}

                  {request.status === "NEW" ? (
                    <p className="text-sm text-warning-11">
                      Waiting for the requester to verify their email address.
                    </p>
                  ) : null}

                  {/* #2263: admin-only availability + conflict preview for any
                      whole-lodge request, before the decision rather than after
                      it. Advisory: approving never displaces anything. */}
                  {request.exclusivityRequested &&
                  LINKING_EDITOR_STATUSES.has(request.status) ? (
                    <WholeLodgeAvailabilityStrip requestId={request.id} />
                  ) : null}

                  {request.latestQuote ? (
                    <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
                      <p className="font-medium">
                        Quote v{request.latestQuote.version} · {request.latestQuote.status}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {request.latestQuote.options.map((option) => (
                          <Badge key={option.id} variant="secondary">
                            {option.label}: {formatCents(option.totalCents)}
                          </Badge>
                        ))}
                      </div>
                      {request.latestQuote.responseTokenExpiresAt ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Link expires {formatDateTime(request.latestQuote.responseTokenExpiresAt)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {request.responseMessage ? (
                    <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
                      <p className="font-medium">
                        {request.status === "QUERY_PENDING"
                          ? "Requester question"
                          : request.status === "MODIFICATION_REQUESTED"
                            ? "Requester change request"
                            : "Requester response"}
                      </p>
                      <p className="mt-1">{request.responseMessage}</p>
                      {request.responseMessageAt ? (
                        <p className="mt-1 text-xs opacity-80">
                          Sent {formatDateTime(request.responseMessageAt)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {LINKING_EDITOR_STATUSES.has(request.status) ? (
                    canEdit ? (
                    <div className="space-y-3 rounded-md border border-border p-3">
                      {/* #2936: correcting what was asked for comes BEFORE
                          pricing it — a price or a quote built from the wrong
                          dates is the thing this exists to stop. Hidden for a
                          member whole-lodge request, which has no quote stage,
                          and for a row whose stored party cannot be read back,
                          which is repaired or declined rather than guessed at;
                          the service refuses both anyway. */}
                      {memberWholeLodge || dataNeedsAttention ? null : (
                        <BookingRequestCorrectionEditor
                          request={request}
                          disabled={isActioning}
                          onCorrected={(summary) => {
                            // #2936: the member links are keyed by POSITION in
                            // the guest list, so a correction that moves the
                            // party clears them server-side. This card keeps an
                            // UNSAVED local copy that wins over the server's
                            // (`activeMemberLinks`) and survives a refetch — so
                            // without dropping it here, the next "Save quote"
                            // would post the stale links straight back and put
                            // a member on somebody else's row. Dropped whatever
                            // the correction changed: re-linking is cheap, and
                            // a wrong link is priced, invoiced and emailed.
                            setMemberLinks((prev) => {
                              const next = { ...prev };
                              delete next[request.id];
                              return next;
                            });
                            setLinkConflicts((prev) => ({
                              ...prev,
                              [request.id]: [],
                            }));
                            // Let the advisory pre-check fire again for whatever
                            // links the corrected row comes back with.
                            linkConflictLoadedRef.current.delete(request.id);
                            toast.success(summary);
                            void fetchRequests();
                          }}
                          onError={showActionError}
                        />
                      )}
                      {/* #2263: a member whole-lodge booking is owned by the
                          member's own login account, so there is no non-login
                          contact to map or create, and no hold to release. */}
                      {memberWholeLodge ? null : request.heldBookingId ? (
                        <div className="space-y-2 rounded-md border bg-muted p-3 text-sm text-muted-foreground">
                          <p>
                            Booking contact was set when slots were held. Release
                            the hold to change which contact owns this booking.
                          </p>
                          {releaseConfirmId === request.id ? (
                            <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                              <p className="text-xs">
                                This frees the held beds and returns the request
                                to an un-held state so you can re-map and re-hold.
                              </p>
                              <p className="text-xs font-medium">
                                Warning: the requester&apos;s existing quote link
                                stays active. If they accept before you re-hold,
                                releasing may drop their reservation or lose the
                                intended mapping. Re-send a fresh quote after
                                re-mapping the owner.
                              </p>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => handleReleaseHold(request)}
                                  disabled={isActioning}
                                >
                                  {isActioning ? "Releasing…" : "Confirm release"}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setReleaseConfirmId(null)}
                                  disabled={isActioning}
                                >
                                  Keep hold
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setReleaseConfirmId(request.id)}
                              disabled={isActioning}
                            >
                              Release hold
                            </Button>
                          )}
                        </div>
                      ) : (
                        <BookingRequestContactPicker
                          requestId={request.id}
                          choice={ownerChoiceFor(request.id)}
                          onChange={(choice) =>
                            setOwnerChoices((prev) => ({
                              ...prev,
                              [request.id]: choice,
                            }))
                          }
                          disabled={isActioning}
                        />
                      )}
                      {request.type === "SCHOOL" ? (
                        <div className="space-y-2">
                          <Label>Adjust group numbers</Label>
                          <div className="flex flex-wrap items-end gap-3">
                            {SCHOOL_CHILD_TIERS.map((tier) => (
                              <div key={tier} className="space-y-1">
                                <Label
                                  htmlFor={`count-${tier}-${request.id}`}
                                  className="text-xs text-muted-foreground"
                                >
                                  {SCHOOL_CHILD_TIER_LABELS[tier]}
                                </Label>
                                <Input
                                  id={`count-${tier}-${request.id}`}
                                  type="number"
                                  min="0"
                                  className="w-24"
                                  // #2342: these boxes are PREFILLED from the
                                  // guest list, and on a flagged row that list
                                  // is the salvaged one, in which an unreadable
                                  // age tier counts as zero. Approving from
                                  // them would invoice a 30-child group for
                                  // two. The server refuses the override on
                                  // such a row too.
                                  disabled={actionsBlocked}
                                  value={childCountValues(request)[tier]}
                                  onChange={(event) =>
                                    setCountInputs((prev) => {
                                      const current =
                                        prev[request.id] ?? deriveChildCounts(request.guests);
                                      return {
                                        ...prev,
                                        [request.id]: { ...current, [tier]: event.target.value },
                                      };
                                    })
                                  }
                                />
                              </div>
                            ))}
                          </div>
                          {/* #2936: this said "Decline and ask the school to
                              resubmit" — the destructive instruction the
                              correction editor above exists to retire, sitting
                              directly beneath it and contradicting the guide
                              added with it. It also left two child-count
                              controls on one card with very different
                              consequences and nothing to tell them apart, so
                              each now says what it changes. */}
                          <p className="text-xs text-muted-foreground">
                            {request.teachers.length} teachers &amp; helpers + children ={" "}
                            {plannedGuestTotal(request)} total. These boxes change only the
                            booking you are about to quote or approve, not what the school
                            asked for. To change the request itself — its dates, its teachers
                            or its catering — use &ldquo;Correct this request&rdquo; above.
                          </p>
                          {/* #3412: saving the quote now rewrites the group,
                              and beds already held for the old numbers are not
                              re-sized under it. Say so before the click — the
                              service refuses it with the same sentence. */}
                          {countChangeBlockedByHold(request) ? (
                            <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-xs text-warning-11">
                              Beds are held for this request&apos;s current numbers, so
                              these new numbers can&apos;t be saved yet. Use{" "}
                              <strong>Release hold</strong> above, then save and send the
                              quote again.
                            </p>
                          ) : misplacedSchoolLink(request) ? (
                            /* #3412 review (F7): the 422 the save would hit,
                               said before the click and naming BOTH the member
                               and the row — the officer is otherwise scanning
                               a list of identical "School Child N" rows. */
                            <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-xs text-warning-11">
                              {misplacedSchoolLink(request)?.label ?? "A member"} is
                              linked to{" "}
                              <strong>
                                {schoolGuestRowLabel(
                                  request,
                                  misplacedSchoolLink(request)!.guestIndex,
                                )}
                              </strong>
                              , and these numbers renumber that row — they can&apos;t be
                              saved while the link is there. Unlink them below, save the
                              new numbers, then link them again to the right row so they
                              keep the member rate.
                            </p>
                          ) : schoolCountsChanged(request) ? (
                            /* #3412 review (B4): Save quote does NOT hold beds.
                               It applies the numbers and prices them; the beds
                               are held by Send quote or by Hold slots. */
                            <p className="text-xs text-muted-foreground">
                              <strong>Save quote</strong> applies these numbers to the
                              request and prices them. The beds are reserved later, when
                              you send the quote or press <strong>Hold slots</strong>.
                            </p>
                          ) : null}
                          {plannedGuestTotal(request) > request.schoolGroupSoftCap ? (
                            <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-xs text-warning-11">
                              Over {request.schoolGroupSoftCap}: confirm a club member is staying with the
                              group before approving.
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      {/* #2263: the quote editor is the requester-facing pricing
                          surface. A member whole-lodge request never gets one —
                          it is priced at approval and the member is shown no
                          price at request time — so the whole block is hidden,
                          and the service layer refuses a quote for these rows
                          even if something POSTs one directly. */}
                      {memberWholeLodge ? null : (
                      <div className="grid gap-3 md:grid-cols-[220px_1fr]">
                        <div className="space-y-1">
                          <Label htmlFor={`pricing-mode-${request.id}`}>Pricing mode</Label>
                          <Select
                            disabled={actionsBlocked}
                            value={pricingModes[request.id] ?? "OVERALL_TOTAL"}
                            onValueChange={(value) =>
                              setPricingModes((prev) => ({
                                ...prev,
                                [request.id]: value as "OVERALL_TOTAL" | "PER_GUEST_NIGHT",
                              }))
                            }
                          >
                            <SelectTrigger id={`pricing-mode-${request.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="OVERALL_TOTAL">Overall total</SelectItem>
                              <SelectItem value="PER_GUEST_NIGHT">Per guest-night</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          {quoteOptionIds(request).map((optionId) => (
                            <div key={optionId} className="rounded-md border bg-card p-3">
                              <p className="text-sm font-medium">{optionLabel(optionId)}</p>
                              {(pricingModes[request.id] ?? "OVERALL_TOTAL") === "OVERALL_TOTAL" ? (
                                <div className="mt-2 flex flex-wrap items-end gap-3">
                                  <div className="space-y-1">
                                    <Label htmlFor={`price-${request.id}-${optionId}`}>
                                      Total ({currencyCode})
                                    </Label>
                                    <Input
                                      id={`price-${request.id}-${optionId}`}
                                      {...MONEY_INPUT_PROPS}
                                      className="w-32"
                                      disabled={actionsBlocked}
                                      value={optionTotalInputValue(request, optionId)}
                                      onChange={(event) =>
                                        setPriceInputs((prev) => ({
                                          ...prev,
                                          [priceInputKey(request.id, optionId)]:
                                            event.target.value,
                                        }))
                                      }
                                    />
                                  </div>
                                </div>
                              ) : (
                                <div className="mt-2 flex flex-wrap gap-3">
                                  {pricingCombos(request).map((combo) => {
                                    const key = rateInputKey(
                                      request.id,
                                      optionId,
                                      combo.ageTier,
                                      combo.isMember
                                    );
                                    // #2749: pre-fill from the fee config. When
                                    // the requester named another lodge, a
                                    // non-member field carries the Full-member
                                    // rate and shows the non-member rate below.
                                    const otherLodgeRate =
                                      request.otherLodgeId != null &&
                                      !combo.isMember;
                                    const nonMemberReference = otherLodgeRate
                                      ? nonMemberRateDollars(request, combo.ageTier)
                                      : "";
                                    return (
                                      <div key={key} className="space-y-1">
                                        <Label htmlFor={key}>
                                          {combo.ageTier}{" "}
                                          {combo.isMember ? "member" : "non-member"}
                                        </Label>
                                        <Input
                                          id={key}
                                          {...MONEY_INPUT_PROPS}
                                          className="w-32"
                                          disabled={actionsBlocked}
                                          value={
                                            rateInputs[key] ??
                                            suggestedRateDollars(request, combo)
                                          }
                                          onChange={(event) =>
                                            setRateInputs((prev) => ({
                                              ...prev,
                                              [key]: event.target.value,
                                            }))
                                          }
                                        />
                                        {otherLodgeRate && nonMemberReference ? (
                                          <p className="text-xs text-muted-foreground">
                                            non-member - {nonMemberReference}
                                          </p>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                      )}

                      {/* #2263: the member's party is unnamed placeholders by
                          design (no guest names are collected), so there is
                          nobody to link here.

                          After approval, an officer works on the BOOKING. A
                          placeholder can be renamed through the ordinary
                          guest-edit path, but renaming does not change the rate:
                          member linkage cannot be edited onto an existing guest
                          row at all (booking-modify-plan.ts refuses any update
                          touching a member guest, so a rename can never quietly
                          transfer who a booking is for). To put a real member on
                          the booking at their own rate the officer REMOVES the
                          placeholder and ADDS the member as a new guest, which
                          re-prices and settles through BookingModification
                          (owner decision OD-A, as corrected in ADR-001's dated
                          entry). */}
                      {memberWholeLodge ? null : (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Linked member guests</p>
                        {requestLinkConflicts.length ? (
                          <div
                            className="rounded-md border border-warning-6 bg-warning-3 p-2 text-xs text-warning-11"
                            role="status"
                          >
                            <p className="font-medium">
                              Heads up: member-night overlap on{" "}
                              {requestLinkConflicts.length === 1
                                ? "a linked member"
                                : "linked members"}
                            </p>
                            <ul className="mt-1 list-disc space-y-0.5 pl-4">
                              {requestLinkConflicts.map((conflict) => (
                                <li key={`${conflict.memberId}-${conflict.bookingCheckIn}`}>
                                  {conflict.memberName} is already on{" "}
                                  {conflict.bookingOwnerName}&apos;s booking (
                                  {formatStayDate(conflict.bookingCheckIn)}–
                                  {formatStayDate(conflict.bookingCheckOut)}) for{" "}
                                  {conflict.conflictingNights
                                    .map((night) => formatStayDate(night))
                                    .join(", ")}
                                  .
                                </li>
                              ))}
                            </ul>
                            <p className="mt-1">
                              This is advisory only. Approving or holding is still
                              blocked while a member is double-booked — resolve the
                              overlap before you approve.
                            </p>
                          </div>
                        ) : null}
                        <div className="grid gap-2">
                          {request.guests.map((guest, guestIndex) => {
                            const key = `${request.id}:${guestIndex}`;
                            const linkedId = linkedMemberIdFor(request, guestIndex);
                            const linkedLabel = activeMemberLinks(request).find(
                              (link) => link.guestIndex === guestIndex
                            )?.label;
                            return (
                              <div
                                key={key}
                                className="grid gap-2 rounded-md border bg-card p-2 md:grid-cols-[1fr_220px_auto]"
                              >
                                <div className="text-sm">
                                  <p className="font-medium">
                                    {guest.firstName} {guest.lastName}
                                  </p>
                                  <p className="text-xs text-muted-foreground">{guest.ageTier}</p>
                                  {linkedId ? (
                                    <p className="mt-1 text-xs text-success-11">
                                      Linked to {linkedLabel ?? linkedId}
                                    </p>
                                  ) : null}
                                </div>
                                <Input
                                  value={memberQueries[key] ?? ""}
                                  disabled={actionsBlocked}
                                  onChange={(event) =>
                                    setMemberQueries((prev) => ({
                                      ...prev,
                                      [key]: event.target.value,
                                    }))
                                  }
                                  placeholder="Search member"
                                />
                                <div className="flex flex-wrap gap-2">
                                  {/* #2342: linking is staged locally and only
                                      persisted by "Save quote", which the
                                      server now refuses on a flagged row — so
                                      leaving these live would let an officer
                                      spend time on links that can never be
                                      saved. */}
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={actionsBlocked}
                                    onClick={() => handleMemberSearch(request.id, guestIndex)}
                                  >
                                    Search
                                  </Button>
                                  {linkedId ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      disabled={actionsBlocked}
                                      onClick={() => handleUnlinkMember(request, guestIndex)}
                                    >
                                      Unlink
                                    </Button>
                                  ) : null}
                                </div>
                                {memberResults[key]?.length ? (
                                  <div className="md:col-span-3 flex flex-wrap gap-2">
                                    {memberResults[key].map((member) => (
                                      <Button
                                        key={member.id}
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        disabled={actionsBlocked}
                                        onClick={() =>
                                          handleLinkMember(request, guestIndex, member)
                                        }
                                      >
                                        {member.firstName} {member.lastName}
                                      </Button>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      )}

                      {memberWholeLodge ? (
                        <MemberWholeLodgeApprovalFields
                          requestId={request.id}
                          submittedHeadcount={request.guests.length}
                          headcount={
                            wholeLodgeHeadcounts[request.id] ??
                            String(request.guests.length)
                          }
                          onHeadcountChange={(value) =>
                            setWholeLodgeHeadcounts((prev) => ({
                              ...prev,
                              [request.id]: value,
                            }))
                          }
                          priceDollars={wholeLodgePrices[request.id] ?? ""}
                          onPriceChange={(value) =>
                            setWholeLodgePrices((prev) => ({
                              ...prev,
                              [request.id]: value,
                            }))
                          }
                          flatWholeLodgeTotalCents={
                            request.wholeLodgeFlatTotalCents ?? null
                          }
                          nights={nightsBetween(request.checkIn, request.checkOut)}
                          pricingMode={
                            wholeLodgePricingModes[request.id] ?? "per-guest"
                          }
                          onPricingModeChange={(mode) =>
                            setWholeLodgePricingModes((prev) => ({
                              ...prev,
                              [request.id]: mode,
                            }))
                          }
                          disabled={actionsBlocked}
                        />
                      ) : null}

                      <div className="space-y-1">
                        <Label htmlFor={`decline-reason-${request.id}`}>
                          {memberWholeLodge
                            ? "Decline note — audit log only, never shown to the member (optional)"
                            : "Decline reason (optional)"}
                        </Label>
                        <Textarea
                          id={`decline-reason-${request.id}`}
                          value={declineReasons[request.id] ?? ""}
                          onChange={(event) =>
                            setDeclineReasons((prev) => ({ ...prev, [request.id]: event.target.value }))
                          }
                          maxLength={2000}
                          placeholder={
                            memberWholeLodge
                              ? "Recorded in the audit log for the club's own record"
                              : "Shown to the requester in the decline email"
                          }
                        />
                        {memberWholeLodge ? (
                          // #2263: on a member whole-lodge request this note is
                          // NOT persisted on the request and NOT interpolated
                          // into any email. A note like "we're holding that week
                          // for another group" would otherwise tell a member
                          // exactly what ADR-001 decision 6 says they are never
                          // told, so the member's email carries one fixed
                          // sentence with no note at all.
                          <p className="text-xs text-muted-foreground">
                            The member is emailed the same fixed wording whatever
                            you write here — never the note, and never anything
                            about who else has the lodge.
                          </p>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {memberWholeLodge ? null : (
                          <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleCreateQuote(request)}
                          // #3412: a count change under a live hold is refused
                          // by the service (409), and one that would renumber a
                          // member's row is refused too (422) — so do not offer
                          // the click for either.
                          disabled={actionsBlocked || countChangeBlocked(request)}
                        >
                          Save quote
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleSendQuote(request)}
                          // #3412 (review, B1): sending HOLDS THE BEDS and
                          // EMAILS the school, both for the party stored on the
                          // request — so an unsaved group-number edit here is
                          // the same defect one button over: 29 beds held and a
                          // quote for 29 while the panel reads "= 20 total".
                          // The service refuses it as well.
                          disabled={
                            actionsBlocked ||
                            !request.latestQuote ||
                            schoolCountsChanged(request)
                          }
                        >
                          Send quote
                        </Button>
                          </>
                        )}
                        {/*
                          #1385: the manual Hold slots entry is SCHOOL-only.
                          Sending a quote auto-holds the beds across the whole
                          quote lifecycle (#1280), so a separate manual hold is
                          redundant on the generic quote flow. SCHOOL requests can
                          be approved DIRECTLY (without a sent quote) and school
                          approval reuses the held booking (#1352), so the manual
                          hold remains meaningful there.
                        */}
                        {request.type === "SCHOOL" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleHoldSlots(request)}
                            // #3412: holding reserves beds for the numbers
                            // STORED on the request, and once those beds are
                            // held the adjusted numbers can no longer be saved
                            // (the service refuses, 409). Holding first would
                            // therefore reserve the wrong count and then trap
                            // the officer between two buttons, so save the
                            // numbers first — the save is what makes them real.
                            disabled={
                              actionsBlocked ||
                              Boolean(request.heldBookingId) ||
                              schoolCountsChanged(request)
                            }
                          >
                            {request.heldBookingId ? "Slots held" : "Hold slots"}
                          </Button>
                        ) : null}
                        {/* #2263 captioned style deviation (owner-approved in
                            the mockup sign-off): Approve is the SOLID PRIMARY
                            button on the member whole-lodge path. Everywhere
                            else in this queue approve is one of several
                            equal-weight steps; here it is the ONLY forward
                            action — there is no quote, no price step and no
                            hold — so the button that does the thing should look
                            like it. */}
                        <Button
                          size="sm"
                          variant={memberWholeLodge ? "default" : "outline"}
                          onClick={() => handleApprove(request)}
                          // #3412 (review round 5, C): approve reads the links
                          // SAVED on the request, so it is refused (422) by a
                          // saved link the officer's numbers would move —
                          // whatever the link editor on screen currently shows.
                          // Gated on its own question, not on Save quote's.
                          disabled={
                            actionsBlocked ||
                            (!memberWholeLodge &&
                              request.type !== "SCHOOL" &&
                              request.status !== "PRICED") ||
                            misplacedSchoolLinkOnApprove(request) !== null
                          }
                        >
                          {memberWholeLodge
                            ? "Approve & hold the whole lodge"
                            : request.type === "SCHOOL"
                              ? "Approve & invoice school"
                              : "Approve & send payment link"}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => openDeclineChoice(request)}
                          disabled={isActioning}
                        >
                          Decline
                        </Button>
                      </div>
                      {/* #2342: stated again beside the disabled buttons, since
                          the warning box above is several blocks up the card
                          and a disabled button's `title` never fires here
                          (buttonVariants sets disabled:pointer-events-none). */}
                      {dataNeedsAttention ? (
                        <p className="text-xs text-warning-11">
                          Quoting, holding and approving are turned off because
                          this request&rsquo;s saved details could not be read —
                          see the note above. Decline is still available.
                        </p>
                      ) : null}
                      {/* #3412: same reason as the disabled Hold slots button,
                          stated where a disabled button cannot state it. */}
                      {!dataNeedsAttention && schoolCountsChanged(request) ? (
                        <p className="text-xs text-muted-foreground">
                          Hold slots and Send quote are off until you save the
                          quote: both reserve the beds for the numbers saved on
                          the request — and sending also emails the school that
                          headcount — so saving these new ones is what makes them
                          the numbers.
                        </p>
                      ) : null}
                      {/* #3412 (review round 5, C): approving reads the member
                          links SAVED on the request, not the ones on screen.
                          Both halves of that were silent — a saved link made
                          approve fail after the click, and an unsaved one was
                          dropped without a word and invoiced at non-member
                          rates. */}
                      {!dataNeedsAttention &&
                      misplacedSchoolLinkOnApprove(request) !== null ? (
                        <p className="text-xs text-warning-11">
                          Approving is off: a member is linked to{" "}
                          <strong>
                            {schoolGuestRowLabel(
                              request,
                              misplacedSchoolLinkOnApprove(request)!.guestIndex,
                            )}
                          </strong>{" "}
                          on the saved request, and these numbers change who is
                          on that row. Approving reads the saved links, so
                          unlinking here is not enough on its own — unlink,
                          save the quote, then link them again to the right row
                          so they keep the member rate.
                        </p>
                      ) : null}
                      {!dataNeedsAttention && unsavedLinkEditCount(request) > 0 ? (
                        <p className="text-xs text-warning-11">
                          {unsavedLinkEditCount(request) === 1
                            ? "One member link change here has not been saved."
                            : `${unsavedLinkEditCount(request)} member link changes here have not been saved.`}{" "}
                          Approving uses the links saved on the request, not the
                          ones on screen: a member you linked here would be
                          missed, and that guest invoiced at non-member rates,
                          while one you unlinked here would still be linked.
                          Press <strong>Save quote</strong> first.
                        </p>
                      ) : null}
                      {memberWholeLodge ? (
                        <p className="text-xs text-muted-foreground">
                          Approving confirms the booking, charges the priced
                          headcount at non-member rates, and holds the whole
                          lodge for these nights. It never cancels an existing
                          booking — anything already on these nights is listed
                          above and stays yours to sort out. There is no quote
                          step on this path: the member has not been shown a
                          price.
                        </p>
                      ) : request.type === "SCHOOL" ? (
                        <p className="text-xs text-muted-foreground">
                          Hold slots reserves the beds for this school request
                          before it is approved or quoted — approving a school
                          reuses the held booking (#1352), and sending a quote
                          auto-holds too. Set the group numbers and the contact
                          FIRST and save the quote, then reserve capacity: beds
                          are held for the numbers saved on the request, and
                          once they are held the numbers can no longer be
                          changed without releasing the hold (#3412). An
                          accepted-but-unpaid booking can still be bumped by the
                          confirm-pending job if the lodge capacity for these
                          nights is later lowered below what is booked.
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Sending a quote auto-holds the beds for this request, so
                          there is no separate hold step. An accepted-but-unpaid
                          booking can still be bumped by the confirm-pending job if
                          the lodge capacity for these nights is later lowered
                          below what is booked.
                        </p>
                      )}
                      {request.status === "VERIFIED" && !memberWholeLodge ? (
                        <p className="text-xs text-muted-foreground">
                          {request.type === "SCHOOL"
                            ? "Adjust group numbers if needed, then save and send a quote so the school can accept or request changes."
                            : "Save and send a quote so the requester can accept, cancel, query, or request changes."}
                        </p>
                      ) : null}
                    </div>
                    ) : null
                  ) : null}

                  {request.status === "DECLINED" ? (
                    <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                      Declined
                      {formatDateTime(request.reviewedAt) ? ` on ${formatDateTime(request.reviewedAt)}` : ""}
                      {request.reviewedByMemberName ? ` by ${request.reviewedByMemberName}` : ""}
                      {request.declineReason ? <p className="mt-2">{request.declineReason}</p> : null}
                    </div>
                  ) : null}

                  {(request.status === "APPROVED" || request.status === "CONVERTED") ? (
                    <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                      Approved
                      {formatDateTime(request.reviewedAt) ? ` on ${formatDateTime(request.reviewedAt)}` : ""}
                      {request.reviewedByMemberName ? ` by ${request.reviewedByMemberName}` : ""}
                      {request.pricedByMemberName ? ` · Priced by ${request.pricedByMemberName}` : ""}
                      {request.convertedBookingId ? (
                        <p className="mt-2">
                          <Link
                            href={buildHrefWithReturnTo(
                              `/bookings/${request.convertedBookingId}`,
                              currentPath
                            )}
                            className="text-info-11 hover:underline"
                          >
                            Open booking
                          </Link>
                        </p>
                      ) : null}
                      {request.type === "SCHOOL" && request.convertedBookingId ? (
                        request.attendeesConfirmedAt ? (
                          <p className="mt-2 text-success-11">
                            Attendee list confirmed{" "}
                            {formatDateTime(request.attendeesConfirmedAt) ?? ""}
                          </p>
                        ) : (
                          <div className="mt-2">
                            <ViewOnlyActionButton
                              canEdit={canEdit}
                              describeReason={false}
                              variant="outline"
                              size="sm"
                              disabled={actioningId === request.id}
                              onClick={() => handleResendAttendeeLink(request)}
                            >
                              {actioningId === request.id
                                ? "Sending…"
                                : "Re-send attendee confirmation link"}
                            </ViewOnlyActionButton>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Rotates the secure link and emails it to the school
                              contact now, outside the reminder cadence.
                            </p>
                          </div>
                        )
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* #1791: per-decline requester-email choice, mirroring the #1705/#1769a
          pattern. Declining always emails the requester (contactEmail is always
          present), so the dialog is shown on every decline. Both choices decline
          the request; the choice itself is recorded in the audit log. */}
      <Dialog
        open={declineDialogOpen}
        onOpenChange={(open) => {
          if (!open) setDeclineDialogOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email the requester about this decline?</DialogTitle>
            <DialogDescription>
              The request is declined either way. Choose whether the requester
              receives the standard decline email — your choice is recorded in
              the audit log.
            </DialogDescription>
            {/* #2263: the whole-lodge consequence is folded INTO this dialog
                rather than chained after it as a second dialog — one decision,
                one prompt. It states what the member will and will not be told,
                because the officer writing the note needs to know the note is
                not what gets sent. */}
            {declineChoice && isMemberWholeLodgeRequest(declineChoice) ? (
              <p className="text-sm text-muted-foreground">
                This is a whole-lodge request. Declining it releases nothing and
                changes no capacity — the lodge was never held for it. If you
                email the member they receive one fixed sentence saying the
                whole lodge was not available for those dates: never your note,
                and never anything about who else has the lodge. Your note is
                kept in the audit log.
              </p>
            ) : null}
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={actioningId !== null}
              onClick={() => confirmDecline(false)}
            >
              Decline without emailing
            </Button>
            <Button
              variant="destructive"
              disabled={actioningId !== null}
              onClick={() => confirmDecline(true)}
            >
              Decline and email requester
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
