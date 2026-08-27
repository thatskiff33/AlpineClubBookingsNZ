"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { FocusedActionError } from "@/components/focused-action-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { APP_CURRENCY } from "@/config/operational";
import {
  calendarDayFromPayload,
  formatPayloadCalendarDay,
} from "../_lib/calendar-day";
import { formatCents } from "@/lib/pricing";
import { useLodgeOptions } from "@/components/lodge-select";
import { LodgeScopeStatusNotice } from "@/components/admin/lodge-options-status";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { MONEY_INPUT_PROPS, parseDecimalDollarsToCents } from "@/lib/money-input";
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope";
import { PromoRedemptionsPanel } from "./promo-redemptions-panel";

interface RedemptionsPromoSummary {
  id: string;
  code: string;
  description: string | null;
  type: PromoType;
  archived: boolean;
}

interface MemberOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface XeroAccountOption {
  code: string;
  name: string;
  type: string;
}

interface XeroItemOption {
  code: string;
  name: string;
}

interface PromoAssignment {
  id: string;
  memberId: string;
  member: MemberOption;
}

interface PromoRedemptionRow {
  id: string;
  discountCents: number;
  priceAdjustmentCents: number;
  memberId: string;
  createdAt: string;
}

type PromoType = "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS" | "FIXED_NIGHTLY_PRICE";

interface PromoCode {
  id: string;
  code: string;
  description: string | null;
  type: PromoType;
  valueCents: number | null;
  percentOff: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: "SET_PRICE" | "CAP_ONLY" | null;
  maxNightlyValueCents: number | null;
  maxGuestsPerBooking: number | null;
  maxRedemptionsTotal: number | null;
  maxUniqueMembersTotal: number | null;
  maxUsesPerMember: number | null;
  currentRedemptions: number;
  validFrom: string | null;
  validUntil: string | null;
  bookingStartFrom: string | null;
  bookingStartUntil: string | null;
  membersOnly: boolean;
  memberGuestsOnly: boolean;
  assignedMembersOnlyOwnNights: boolean | null;
  xeroItemCode: string | null;
  xeroAccountCode: string | null;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
  // Beneficial allocation rows only — the ones that consume usage caps (#2299).
  redemptions: PromoRedemptionRow[];
  // Every application of the code, benefit or not. Used for the archive-or-
  // delete decision and shown as the operator-facing "applied" figure.
  totalRedemptionCount: number;
  // How many of those applications gave NOBODY a benefit (#2299). Counted on
  // the server; it is not `totalRedemptionCount - currentRedemptions`, because
  // those two are in different units (applications vs beneficiaries).
  benefitFreeRedemptionCount: number;
  assignments: PromoAssignment[];
  lodgeIds: string[];
}

const TYPE_LABELS: Record<string, string> = {
  PERCENTAGE: "Percentage",
  FIXED_AMOUNT: "Fixed Amount",
  FREE_NIGHTS: "Free Nights",
  FIXED_NIGHTLY_PRICE: "Fixed Price per Night",
};

/*
  TRUNCATION, NOT A ZONE PROJECTION (#2872; INV-DATE-019's first boundary with
  INV-DATE-026, not INV-DATE-010 — #3080). All four `PromoCode` window columns
  are `@db.Date` — a CALENDAR DAY encoded as UTC midnight — so the day is read
  off the front of the serialised value, and `formatClubDate` needs no zone.

  Both used to project through the club zone, and on the input that was a live
  data defect rather than a cosmetic one, because THIS FORM WRITES THE VALUE
  BACK: west of UTC the projection reads the PREVIOUS day, so an admin editing
  only the description saved the window a day short, and every later edit walked
  it back again. These columns gate a discount against `Booking.checkIn`, so the
  day is money. It agrees in New Zealand, which is why nothing caught it.
*/
function formatPromoDateInput(value: string | null) {
  return calendarDayFromPayload(value) ?? "";
}

function formatPromoDateDisplay(value: string | null) {
  return formatPayloadCalendarDay(value, "");
}

export function PromoCodesPageClient({
  permissionMatrix,
}: {
  permissionMatrix: AdminPermissionMatrix;
}) {
  // The Xero reference data (chart-of-accounts + items) is finance area, fetched
  // only when the create/edit form opens. Gate it at finance `view` so a viewer
  // with promo (bookings) access but not finance never fetches into a 403; the
  // form falls back to its manual code inputs. Seeded roles that reach this page
  // all hold finance view, so they are unaffected.
  const canFinance = permissionMatrix.finance !== "none";
  // Promo codes are a bookings-area setting; a bookings:view admin sees this
  // page read-only (#1940). The create/edit/toggle/delete routes enforce
  // bookings:edit.
  const canEdit = permissionMatrix.bookings === "edit";
  const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
  const [archivedCodes, setArchivedCodes] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /*
    #2685 review — the Save button on this form sits roughly 630 lines of markup
    BELOW the error banner, so a refused amount put its explanation somewhere
    the admin could not see, in a plain `<div>` with no role and no live region:
    nothing was announced, nothing took focus, and nothing scrolled. The banner
    is now `FocusedActionError`, which is a permanently mounted assertive live
    region that takes focus and scrolls itself into view.

    The counter is what makes it work the SECOND time. Pressing Save again with
    the same amount still in the box produces the identical message string, so
    `error` does not change and the effect keyed on it would not re-fire. Every
    submit-time refusal bumps this.
  */
  const [errorAttention, setErrorAttention] = useState(0);
  /** Record a failure AND re-announce it, even when the text has not changed. */
  const raiseError = useCallback((message: string) => {
    setError(message);
    setErrorAttention((version) => version + 1);
  }, []);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // When set, the page swaps the list for the per-code redemptions report.
  const [redemptionsPromo, setRedemptionsPromo] =
    useState<RedemptionsPromoSummary | null>(null);

  // #2257 — every example that used to sit in a placeholder now renders as
  // helper text under its field, properly associated with it.
  const codeHint = useFieldHint();
  const descriptionHint = useFieldHint();
  const percentOffHint = useFieldHint();
  const valueDollarsHint = useFieldHint();
  const fixedNightlyPriceHint = useFieldHint();
  const freeNightsPerIndividualHint = useFieldHint();
  const xeroItemCodeHint = useFieldHint();
  const xeroAccountCodeHint = useFieldHint();

  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<PromoType>("PERCENTAGE");
  const [percentOff, setPercentOff] = useState("");
  const [valueDollars, setValueDollars] = useState("");
  const [freeNightsPerIndividual, setFreeNightsPerIndividual] = useState("");
  const [lifetimeFreeNightsCap, setLifetimeFreeNightsCap] = useState("");
  const [fixedNightlyPriceDollars, setFixedNightlyPriceDollars] = useState("");
  const [fixedNightlyMode, setFixedNightlyMode] = useState<"SET_PRICE" | "CAP_ONLY">("CAP_ONLY");
  const [maxNightlyValueDollars, setMaxNightlyValueDollars] = useState("");
  const [maxGuestsPerBooking, setMaxGuestsPerBooking] = useState("");
  const [maxRedemptionsTotal, setMaxRedemptionsTotal] = useState("");
  const [maxUniqueMembersTotal, setMaxUniqueMembersTotal] = useState("");
  const [maxUsesPerMember, setMaxUsesPerMember] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [bookingStartFrom, setBookingStartFrom] = useState("");
  const [bookingStartUntil, setBookingStartUntil] = useState("");
  const [membersOnly, setMembersOnly] = useState(false);
  const [memberGuestsOnly, setMemberGuestsOnly] = useState(false);
  const [assignedMembersOnlyOwnNights, setAssignedMembersOnlyOwnNights] = useState(true);
  // Tracks whether the admin has explicitly picked an assignment scope, so the
  // type-aware default below only seeds an untouched, brand-new code.
  const [assignmentScopeTouched, setAssignmentScopeTouched] = useState(false);
  const [xeroItemCode, setXeroItemCode] = useState("");
  const [xeroAccountCode, setXeroAccountCode] = useState("");
  const [active, setActive] = useState(true);
  // Optional per-lodge restriction (no selection = redeemable at every
  // lodge). The whole control is hidden while fewer than two lodges exist
  // (ADR-002 presentation rule).
  //
  // #2701: "no selection" is a real product difference, not a blank field — the
  // code becomes redeemable at EVERY lodge, including lodges added later. A
  // failed lodge list left `lodges` empty, which reads here as a single-lodge
  // club: the restriction control vanished and the next code created was
  // club-wide, silently. Creating and editing codes stops until the list
  // returns. Loading, failure, 403, and a successful empty response are all
  // stopped states rather than an implicit club-wide choice.
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
    reload: reloadLodges,
  } = useLodgeOptions("admin");
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: "__all_lodges__",
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
    explicitAllLodgesValue: "__all_lodges__",
  });
  const lodgeScopeReady = lodgeScope.kind === "all";
  const multiLodge = lodges.length > 1;
  const [restrictedLodgeIds, setRestrictedLodgeIds] = useState<string[]>([]);

  const [assignedMemberIds, setAssignedMemberIds] = useState<string[]>([]);
  const [assignedMembers, setAssignedMembers] = useState<MemberOption[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberResults, setMemberResults] = useState<MemberOption[]>([]);
  const [searchingMembers, setSearchingMembers] = useState(false);

  const [xeroAccounts, setXeroAccounts] = useState<XeroAccountOption[]>([]);
  const [xeroItems, setXeroItems] = useState<XeroItemOption[]>([]);
  const [xeroDataLoaded, setXeroDataLoaded] = useState(false);
  const [xeroDataLoading, setXeroDataLoading] = useState(false);
  const [xeroDataError, setXeroDataError] = useState("");

  const fetchPromoCodes = useCallback(async () => {
    if (!lodgeScopeReady) {
      setPromoCodes([]);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/admin/promo-codes");
      if (!res.ok) throw new Error("Failed to fetch promo codes");
      const data = await res.json();
      setPromoCodes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [lodgeScopeReady]);

  const fetchArchivedCodes = useCallback(async () => {
    if (!lodgeScopeReady) {
      setArchivedCodes([]);
      return;
    }
    try {
      const res = await fetch("/api/admin/promo-codes?archived=true");
      if (!res.ok) throw new Error("Failed to fetch archived codes");
      const data = await res.json();
      setArchivedCodes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [lodgeScopeReady]);

  useEffect(() => {
    fetchPromoCodes();
  }, [fetchPromoCodes]);

  useEffect(() => {
    if (showArchived) {
      fetchArchivedCodes();
    }
  }, [showArchived, fetchArchivedCodes]);

  const fetchXeroReferenceData = useCallback(async () => {
    if (!lodgeScopeReady) return;
    if (xeroDataLoaded || xeroDataLoading) return;
    // Skip the finance-area fetch entirely for a viewer without finance access;
    // the form's manual code inputs remain the fallback, with no error banner.
    if (!canFinance) return;
    setXeroDataLoading(true);
    setXeroDataError("");
    try {
      const [accountsRes, itemsRes] = await Promise.all([
        fetch("/api/admin/xero/chart-of-accounts"),
        fetch("/api/admin/xero/items"),
      ]);
      // Backstop for matrix↔enforcement drift or a mid-session revocation: a
      // 401/403 degrades quietly to the manual inputs (no banner), while a
      // genuine failure — Xero not connected returns 500 — keeps the amber note.
      //
      // 404 belongs in the same quiet branch. `/api/admin/xero/*` is
      // module-gated, so it answers 404 both when the Xero module is off and
      // when the sign-in behind this tab has expired — a gated route hides that
      // difference on purpose (`moduleGatedNotFoundResponse` in
      // `src/lib/session-guards.ts`). Neither cause is "Xero is not connected",
      // and a promo code is perfectly usable with its account code typed by
      // hand, so the amber banner would be both wrong and in the way.
      const denied = (status: number) =>
        status === 401 || status === 403 || status === 404;

      if (denied(accountsRes.status) || denied(itemsRes.status)) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "PromoCodesPage: Xero reference fetch denied or unavailable; using manual entry (module off, revoked session, or matrix/enforcement drift?)",
          );
        }
        return;
      }
      if (!accountsRes.ok || !itemsRes.ok) {
        throw new Error("Xero not connected or accounts/items unavailable");
      }
      const accountsData = (await accountsRes.json()) as { accounts?: XeroAccountOption[] };
      const itemsData = (await itemsRes.json()) as { items?: XeroItemOption[] };
      setXeroAccounts(accountsData.accounts ?? []);
      setXeroItems(itemsData.items ?? []);
      setXeroDataLoaded(true);
    } catch (err) {
      setXeroDataError(
        err instanceof Error
          ? err.message
          : "Could not load Xero accounts/items"
      );
    } finally {
      setXeroDataLoading(false);
    }
  }, [xeroDataLoaded, xeroDataLoading, canFinance, lodgeScopeReady]);

  useEffect(() => {
    if (showForm) {
      void fetchXeroReferenceData();
    }
  }, [showForm, fetchXeroReferenceData]);

  // A fixed-nightly code that is not member-guests-only can price the whole
  // booking as a group. Those codes default to group scope (own-nights = false);
  // every other code defaults to own-night scoping (true).
  const fixedNightlyGroupCapable =
    type === "FIXED_NIGHTLY_PRICE" && !memberGuestsOnly;

  // Seed the assignment-scope default for a new code from its type. Skips
  // editing (keep the saved value) and any code where the admin has already
  // chosen a scope.
  useEffect(() => {
    if (editingId || assignmentScopeTouched) return;
    setAssignedMembersOnlyOwnNights(!fixedNightlyGroupCapable);
  }, [fixedNightlyGroupCapable, editingId, assignmentScopeTouched]);

  async function searchMembers(query: string) {
    if (!lodgeScopeReady) return;
    setMemberSearch(query);
    if (query.length < 2) {
      setMemberResults([]);
      return;
    }
    setSearchingMembers(true);
    try {
      const res = await fetch(
        `/api/admin/members?q=${encodeURIComponent(query)}&pageSize=10&active=true`
      );
      if (!res.ok) throw new Error("Failed to search members");
      const data = await res.json();
      const members = (data.members || []).map((m: MemberOption) => ({
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
      }));
      setMemberResults(
        members.filter((m: MemberOption) => !assignedMemberIds.includes(m.id))
      );
    } catch {
      setMemberResults([]);
    } finally {
      setSearchingMembers(false);
    }
  }

  function addMember(member: MemberOption) {
    if (!assignedMemberIds.includes(member.id)) {
      setAssignedMemberIds([...assignedMemberIds, member.id]);
      setAssignedMembers([...assignedMembers, member]);
    }
    setMemberSearch("");
    setMemberResults([]);
  }

  function removeMember(memberId: string) {
    setAssignedMemberIds(assignedMemberIds.filter((id) => id !== memberId));
    setAssignedMembers(assignedMembers.filter((m) => m.id !== memberId));
  }

  function resetForm() {
    setCode("");
    setDescription("");
    setType("PERCENTAGE");
    setPercentOff("");
    setValueDollars("");
    setFreeNightsPerIndividual("");
    setLifetimeFreeNightsCap("");
    setFixedNightlyPriceDollars("");
    setFixedNightlyMode("CAP_ONLY");
    setMaxNightlyValueDollars("");
    setMaxGuestsPerBooking("");
    setMaxRedemptionsTotal("");
    setMaxUniqueMembersTotal("");
    setMaxUsesPerMember("");
    setValidFrom("");
    setValidUntil("");
    setBookingStartFrom("");
    setBookingStartUntil("");
    setMembersOnly(false);
    setMemberGuestsOnly(false);
    setAssignedMembersOnlyOwnNights(true);
    setAssignmentScopeTouched(false);
    setXeroItemCode("");
    setXeroAccountCode("");
    setActive(true);
    setRestrictedLodgeIds([]);
    setEditingId(null);
    setShowForm(false);
    setError("");
    setAssignedMemberIds([]);
    setAssignedMembers([]);
    setMemberSearch("");
    setMemberResults([]);
  }

  function startEdit(promo: PromoCode) {
    if (!lodgeScopeReady) return;
    setEditingId(promo.id);
    setCode(promo.code);
    setDescription(promo.description || "");
    setType(promo.type);
    setPercentOff(promo.percentOff != null ? String(promo.percentOff) : "");
    setValueDollars(
      promo.valueCents != null ? (promo.valueCents / 100).toFixed(2) : ""
    );
    setFreeNightsPerIndividual(
      promo.freeNightsPerIndividual != null ? String(promo.freeNightsPerIndividual) : ""
    );
    setLifetimeFreeNightsCap(
      promo.lifetimeFreeNightsCap != null ? String(promo.lifetimeFreeNightsCap) : ""
    );
    setFixedNightlyPriceDollars(
      promo.fixedNightlyPriceCents != null
        ? (promo.fixedNightlyPriceCents / 100).toFixed(2)
        : ""
    );
    setFixedNightlyMode(promo.fixedNightlyMode ?? "CAP_ONLY");
    setMaxNightlyValueDollars(
      promo.maxNightlyValueCents != null
        ? (promo.maxNightlyValueCents / 100).toFixed(2)
        : ""
    );
    setMaxGuestsPerBooking(
      promo.maxGuestsPerBooking != null ? String(promo.maxGuestsPerBooking) : ""
    );
    setMaxRedemptionsTotal(
      promo.maxRedemptionsTotal != null ? String(promo.maxRedemptionsTotal) : ""
    );
    setMaxUniqueMembersTotal(
      promo.maxUniqueMembersTotal != null ? String(promo.maxUniqueMembersTotal) : ""
    );
    setMaxUsesPerMember(
      promo.maxUsesPerMember != null ? String(promo.maxUsesPerMember) : ""
    );
    setValidFrom(formatPromoDateInput(promo.validFrom));
    setValidUntil(formatPromoDateInput(promo.validUntil));
    setBookingStartFrom(formatPromoDateInput(promo.bookingStartFrom));
    setBookingStartUntil(formatPromoDateInput(promo.bookingStartUntil));
    setMembersOnly(promo.membersOnly);
    setMemberGuestsOnly(promo.memberGuestsOnly);
    setAssignedMembersOnlyOwnNights(promo.assignedMembersOnlyOwnNights ?? true);
    // Keep the saved scope; do not let the type-aware default reseed it.
    setAssignmentScopeTouched(true);
    setXeroItemCode(promo.xeroItemCode ?? "");
    setXeroAccountCode(promo.xeroAccountCode ?? "");
    setActive(promo.active);
    setRestrictedLodgeIds(promo.lodgeIds ?? []);
    setAssignedMemberIds(promo.assignments?.map((a) => a.member.id) || []);
    setAssignedMembers(promo.assignments?.map((a) => a.member) || []);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    /*
      #2701 backstop for the disabled Save button — pressing Enter in any text
      field still submits a form. Without the lodge list the payload below omits
      `lodgeIds` entirely, which on a NEW code means "redeemable at every lodge",
      the widest setting there is, chosen by nobody.
    */
    if (!lodgeScopeReady) {
      raiseError(
        "The lodge list could not be loaded, so this code cannot be saved yet — its lodge restriction is part of what is being saved. Retry the lodge list above, then save.",
      );
      return;
    }
    setSaving(true);
    setError("");

    const payload: Record<string, unknown> = {
      code,
      description: description || null,
      type,
      membersOnly,
      memberGuestsOnly,
      assignedMembersOnlyOwnNights,
      xeroItemCode: xeroItemCode.trim() || null,
      xeroAccountCode: xeroAccountCode.trim() || null,
      active,
      validFrom: validFrom || null,
      validUntil: validUntil || null,
      bookingStartFrom: bookingStartFrom || null,
      bookingStartUntil: bookingStartUntil || null,
      maxGuestsPerBooking: maxGuestsPerBooking ? parseInt(maxGuestsPerBooking) : null,
      maxRedemptionsTotal: maxRedemptionsTotal ? parseInt(maxRedemptionsTotal) : null,
      maxUniqueMembersTotal: maxUniqueMembersTotal ? parseInt(maxUniqueMembersTotal) : null,
      maxUsesPerMember: maxUsesPerMember ? parseInt(maxUsesPerMember) : null,
      assignedMemberIds,
      // Only send the lodge restriction when the control is visible; a
      // single-lodge admin editing a promo must not clear a restriction
      // configured elsewhere (omitted = left unchanged by the API).
      ...(multiLodge ? { lodgeIds: restrictedLodgeIds } : {}),
    };

    /*
      #2685: every dollar box on this form is parsed exactly, and a malformed
      amount stops the save with a message. It used to be
      `Math.round(parseFloat(x) * 100)`, which produced `NaN` — and
      `JSON.stringify` writes `NaN` as `null`, so a typo reached the API as
      "this promo has no value" rather than as an error.
    */
    const amountField = (raw: string, label: string): number | null => {
      const cents = parseDecimalDollarsToCents(raw);
      if (cents === null) {
        // `raiseError`, not `setError`: pressing Save twice with the same bad
        // amount produces the identical string, and the banner is ~630 lines of
        // markup above the button, so it has to re-announce and re-scroll each
        // time rather than sit there unchanged (#2685 review).
        raiseError(`Enter ${label} in dollars and cents, for example 25.00.`);
        // The caller returns straight away, so release the Save button here.
        setSaving(false);
      }
      return cents;
    };

    if (type === "PERCENTAGE") {
      payload.percentOff = percentOff ? parseInt(percentOff) : null;
    } else if (type === "FIXED_AMOUNT") {
      if (valueDollars) {
        const cents = amountField(valueDollars, "the discount amount");
        if (cents === null) return;
        payload.valueCents = cents;
      } else {
        payload.valueCents = null;
      }
    } else if (type === "FREE_NIGHTS") {
      payload.freeNightsPerIndividual = freeNightsPerIndividual
        ? parseInt(freeNightsPerIndividual)
        : null;
      payload.lifetimeFreeNightsCap = lifetimeFreeNightsCap
        ? parseInt(lifetimeFreeNightsCap)
        : null;
    } else if (type === "FIXED_NIGHTLY_PRICE") {
      if (fixedNightlyPriceDollars) {
        const cents = amountField(
          fixedNightlyPriceDollars,
          "the fixed nightly price",
        );
        if (cents === null) return;
        payload.fixedNightlyPriceCents = cents;
      } else {
        payload.fixedNightlyPriceCents = null;
      }
      payload.fixedNightlyMode = fixedNightlyMode;
    }

    if (type !== "FIXED_AMOUNT" && type !== "FIXED_NIGHTLY_PRICE") {
      if (maxNightlyValueDollars) {
        const cents = amountField(
          maxNightlyValueDollars,
          "the maximum nightly value",
        );
        if (cents === null) return;
        payload.maxNightlyValueCents = cents;
      } else {
        payload.maxNightlyValueCents = null;
      }
    }

    try {
      const url = editingId
        ? `/api/admin/promo-codes/${editingId}`
        : "/api/admin/promo-codes";
      const method = editingId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 403) {
        throw new Error(ADMIN_FORBIDDEN_SAVE_REASON);
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save promo code");
      }

      resetForm();
      fetchPromoCodes();
    } catch (err) {
      raiseError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(promo: PromoCode) {
    if (!lodgeScopeReady) return;
    // Applications, not beneficial uses: a code that was applied to a booking
    // is always archived rather than deleted, even if it gave nobody anything
    // (#2299) — the server refuses the hard delete for the same reason.
    const hasRedemptions = promo.totalRedemptionCount > 0;
    const confirmMsg = hasRedemptions
      ? `This promo code has been applied to ${promo.totalRedemptionCount} booking(s). It will be archived (not deleted) so you can still reference it. Continue?`
      : "Are you sure you want to delete this promo code?";

    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch(`/api/admin/promo-codes/${promo.id}`, {
        method: "DELETE",
      });
      if (res.status === 403) {
        throw new Error(ADMIN_FORBIDDEN_SAVE_REASON);
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete");
      }
      fetchPromoCodes();
      if (showArchived) fetchArchivedCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleRestore(id: string) {
    if (!lodgeScopeReady) return;
    try {
      const res = await fetch(`/api/admin/promo-codes/${id}`, {
        method: "PATCH",
      });
      if (res.status === 403) {
        throw new Error(ADMIN_FORBIDDEN_SAVE_REASON);
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to restore");
      }
      fetchPromoCodes();
      fetchArchivedCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleToggleActive(promo: PromoCode) {
    if (!lodgeScopeReady) return;
    try {
      const res = await fetch(`/api/admin/promo-codes/${promo.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !promo.active }),
      });
      if (res.status === 403) {
        throw new Error(ADMIN_FORBIDDEN_SAVE_REASON);
      }
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update");
      }
      fetchPromoCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  function formatPromoValue(promo: PromoCode): string {
    switch (promo.type) {
      case "PERCENTAGE":
        return `${promo.percentOff}% off per individual`;
      case "FIXED_AMOUNT":
        return `${formatCents(promo.valueCents || 0)} off per individual`;
      case "FREE_NIGHTS": {
        const perBooking = `${promo.freeNightsPerIndividual} free night${promo.freeNightsPerIndividual !== 1 ? "s" : ""} per booking`;
        if (promo.lifetimeFreeNightsCap != null) {
          return `${perBooking} · ${promo.lifetimeFreeNightsCap} lifetime`;
        }
        return perBooking;
      }
      case "FIXED_NIGHTLY_PRICE": {
        const mode = promo.fixedNightlyMode === "SET_PRICE" ? "set price" : "cap only";
        return `${formatCents(promo.fixedNightlyPriceCents || 0)} per eligible night · ${mode}`;
      }
      default:
        return "";
    }
  }

  function uniqueMemberCount(redemptions: PromoRedemptionRow[]): number {
    return new Set(redemptions.map((r) => r.memberId)).size;
  }

  // Summarise how an assigned code applies: own-night scoping, group pricing
  // (fixed-nightly, not member-guests-only), or booker-picks-guests.
  function assignmentScopeLabel(promo: PromoCode): string {
    if (promo.assignedMembersOnlyOwnNights ?? true) {
      return "Assigned members' own nights";
    }
    if (promo.type === "FIXED_NIGHTLY_PRICE" && !promo.memberGuestsOnly) {
      return "Group rate for all guests";
    }
    return "Booker chooses guests";
  }

  function renderPromoCard(promo: PromoCode, isArchived: boolean) {
    const uniqueMembers = uniqueMemberCount(promo.redemptions);
    return (
      <Card key={promo.id}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <CardTitle className="text-xl font-mono">
                {promo.code}
              </CardTitle>
              <Badge
                variant={
                  promo.type === "PERCENTAGE"
                    ? "default"
                    : promo.type === "FIXED_AMOUNT"
                      ? "secondary"
                      : "outline"
                }
              >
                {TYPE_LABELS[promo.type]}
              </Badge>
              {isArchived ? (
                <Badge variant="outline" className="text-warning-11 border-warning-7">
                  Archived
                </Badge>
              ) : (
                <Badge variant={promo.active ? "default" : "outline"}>
                  {promo.active ? "Active" : "Inactive"}
                </Badge>
              )}
            </div>
            <div className="flex space-x-2">
              {/* Redemptions is a read-only report, available to view-only
                  bookings admins too, so it is a plain button rather than a
                  ViewOnlyActionButton. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setRedemptionsPromo({
                    id: promo.id,
                    code: promo.code,
                    description: promo.description,
                    type: promo.type,
                    archived: isArchived,
                  })
                }
              >
                Redemptions
              </Button>
              {isArchived ? (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  variant="outline"
                  size="sm"
                  onClick={() => handleRestore(promo.id)}
                >
                  Restore
                </ViewOnlyActionButton>
              ) : (
                <>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggleActive(promo)}
                  >
                    {promo.active ? "Deactivate" : "Activate"}
                  </ViewOnlyActionButton>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    variant="outline"
                    size="sm"
                    onClick={() => startEdit(promo)}
                    // #2701: editing a code whose lodge restriction cannot be
                    // rendered is how a restriction becomes unrevocable — the
                    // form would show no lodge boxes and the save would leave
                    // whatever is stored untouched, with nothing on screen
                    // saying so.
                    disabled={lodgesFailed}
                  >
                    Edit
                  </ViewOnlyActionButton>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(promo)}
                  >
                    {promo.totalRedemptionCount > 0 ? "Archive" : "Delete"}
                  </ViewOnlyActionButton>
                </>
              )}
            </div>
          </div>
          {promo.description && (
            <CardDescription>{promo.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Benefit:</span>{" "}
              <span className="font-medium">{formatPromoValue(promo)}</span>
            </div>
            <div>
              {/* The number the total-uses cap is enforced against: one per
                  member per booking, counting only members whose price actually
                  changed (#2299). Named for what it counts, not "redemptions" —
                  a single application that benefits three members moves this by
                  three. */}
              <span className="text-muted-foreground">Benefits given:</span>{" "}
              <span className="font-medium">
                {promo.currentRedemptions}
                {promo.maxRedemptionsTotal != null
                  ? ` / ${promo.maxRedemptionsTotal}`
                  : " (unlimited)"}
              </span>
              {/* Always shown, so the operator can reconcile the cap figure
                  against the number of bookings the code was actually used on;
                  the benefit-free count comes from the server, because these
                  two figures are in different units and cannot be subtracted. */}
              <p className="text-xs text-muted-foreground">
                One per member, per booking. Applied to{" "}
                {promo.totalRedemptionCount} booking
                {promo.totalRedemptionCount === 1 ? "" : "s"}
                {promo.benefitFreeRedemptionCount > 0
                  ? `, of which ${promo.benefitFreeRedemptionCount} gave no benefit and used up no allowance`
                  : ""}
              </p>
            </div>
            <div>
              {/* Distinct members who benefited — the unique-members cap's own
                  unit, so value and cap match. */}
              <span className="text-muted-foreground">Members who benefited:</span>{" "}
              <span className="font-medium">
                {uniqueMembers}
                {promo.maxUniqueMembersTotal != null
                  ? ` / ${promo.maxUniqueMembersTotal}`
                  : " (unlimited)"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Valid:</span>{" "}
              <span className="font-medium">
                {promo.validFrom
                  ? formatPromoDateDisplay(promo.validFrom)
                  : "Any time"}
                {" - "}
                {promo.validUntil
                  ? formatPromoDateDisplay(promo.validUntil)
                  : "No expiry"}
              </span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {promo.maxGuestsPerBooking != null && (
              <Badge variant="outline">
                Up to {promo.maxGuestsPerBooking} guest{promo.maxGuestsPerBooking === 1 ? "" : "s"} per booking
              </Badge>
            )}
            {promo.maxUsesPerMember != null && (
              <Badge variant="outline">
                Max {promo.maxUsesPerMember} use{promo.maxUsesPerMember === 1 ? "" : "s"} per member
              </Badge>
            )}
            {promo.maxNightlyValueCents != null && (
              <Badge variant="outline">
                Up to {formatCents(promo.maxNightlyValueCents)}/night
              </Badge>
            )}
            {promo.membersOnly && (
              <Badge variant="outline">Members only</Badge>
            )}
            {promo.memberGuestsOnly && (
              <Badge variant="outline">Member guests only</Badge>
            )}
            {/* #2701: still shown when the lodge list FAILED, with the ids
                standing in for the names it could not load. A code that is
                restricted must never look unrestricted — that is the reading
                an admin would act on. */}
            {(multiLodge || lodgesFailed) && (promo.lodgeIds?.length ?? 0) > 0 && (
              <Badge variant="outline">
                Lodges:{" "}
                {promo.lodgeIds
                  .map(
                    (id) => lodges.find((lodge) => lodge.id === id)?.name ?? id
                  )
                  .join(", ")}
              </Badge>
            )}
            {promo.xeroItemCode && (
              <Badge variant="outline">Xero Item: {promo.xeroItemCode}</Badge>
            )}
            {promo.xeroAccountCode && (
              <Badge variant="outline">Xero Account: {promo.xeroAccountCode}</Badge>
            )}
          </div>
          {promo.assignments && promo.assignments.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <span className="text-sm text-muted-foreground">Assigned to: </span>
              <div className="flex flex-wrap gap-1 mt-1">
                {promo.assignments.map((a) => (
                  <Badge key={a.member.id} variant="secondary" className="text-xs">
                    {a.member.firstName} {a.member.lastName}
                  </Badge>
                ))}
              </div>
              <Badge variant="outline" className="mt-2 text-xs">
                {assignmentScopeLabel(promo)}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view promo codes but cannot change them. Bookings
      edit access is required.
    </AdminViewOnlySectionBanner>
  );

  // The redemptions report is a self-contained sub-view; render it in place of
  // the list (and its view-only banner, which is about editing) until dismissed.
  if (redemptionsPromo) {
    return (
      <PromoRedemptionsPanel
        promo={redemptionsPromo}
        onBack={() => setRedemptionsPromo(null)}
      />
    );
  }

  if (loading) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="text-center py-8">Loading promo codes...</div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Promo Codes</h1>
          <p className="text-muted-foreground mt-1">
            Create and manage discount codes and vouchers
          </p>
        </div>
        {lodgeScopeReady && !showForm && (
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={() => setShowForm(true)}
            // #2701: `canEdit` keeps carrying the ROLE reason; a missing lodge
            // list disables creating a code separately, explained by the notice
            // below.
          >
            Add Promo Code
          </ViewOnlyActionButton>
        )}
      </div>

      <LodgeScopeStatusNotice
        scope={lodgeScope}
        onRetry={reloadLodges}
        what="lodge-restricted promo codes"
      />

      {lodgeScopeReady ? <FocusedActionError
        id="promo-codes-error"
        error={error}
        attentionKey={errorAttention}
        className="scroll-mt-20"
      /> : null}

      {lodgeScopeReady ? (
        <>

      {lodgeScopeReady && showForm && (
        <Card>
          <CardHeader>
            <CardTitle>
              {editingId ? "Edit Promo Code" : "New Promo Code"}
            </CardTitle>
            <CardDescription>
              Configure discount type, per-individual value, usage caps, and member restrictions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="code">Code</Label>
                  <Input
                    id="code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    required
                    {...codeHint.fieldProps}
                  />
                  <FieldHint {...codeHint.hintProps}>Example: WINTER20</FieldHint>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Input
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    {...descriptionHint.fieldProps}
                  />
                  <FieldHint {...descriptionHint.hintProps}>
                    Example: Winter 2026 early bird discount
                  </FieldHint>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="type">Discount Type</Label>
                  <select
                    id="type"
                    value={type}
                    onChange={(e) =>
                      setType(e.target.value as PromoType)
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    <option value="PERCENTAGE">Percentage Off</option>
                    <option value="FIXED_AMOUNT">Fixed Amount Off</option>
                    <option value="FREE_NIGHTS">Free Nights</option>
                    <option value="FIXED_NIGHTLY_PRICE">Fixed Price per Night</option>
                  </select>
                </div>

                {type === "PERCENTAGE" && (
                  <div className="space-y-2">
                    <Label htmlFor="percentOff">Percentage off per individual (%)</Label>
                    <Input
                      id="percentOff"
                      type="number"
                      min="1"
                      max="100"
                      value={percentOff}
                      onChange={(e) => setPercentOff(e.target.value)}
                      required
                      {...percentOffHint.fieldProps}
                    />
                    <FieldHint {...percentOffHint.hintProps}>
                      Applied to each eligible guest&apos;s stay total. Example: 20
                    </FieldHint>
                  </div>
                )}

                {type === "FIXED_AMOUNT" && (
                  <div className="space-y-2">
                    <Label htmlFor="valueDollars">Amount off per individual ({APP_CURRENCY})</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        $
                      </span>
                      <Input
                        id="valueDollars"
                        {...MONEY_INPUT_PROPS}
                        className="pl-7"
                        value={valueDollars}
                        onChange={(e) => setValueDollars(e.target.value)}
                        required
                        {...valueDollarsHint.fieldProps}
                      />
                    </div>
                    <FieldHint {...valueDollarsHint.hintProps}>
                      Each eligible guest receives this amount off, capped at their stay total.
                      Example: 25.00
                    </FieldHint>
                  </div>
                )}

                {type === "FREE_NIGHTS" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="freeNightsPerIndividual">
                        Free nights per individual (per booking)
                      </Label>
                      <Input
                        id="freeNightsPerIndividual"
                        type="number"
                        min="1"
                        value={freeNightsPerIndividual}
                        onChange={(e) => setFreeNightsPerIndividual(e.target.value)}
                        required
                        {...freeNightsPerIndividualHint.fieldProps}
                      />
                      <FieldHint {...freeNightsPerIndividualHint.hintProps}>
                        Each eligible guest receives up to this many free nights on a single booking. Example: 2
                      </FieldHint>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="lifetimeFreeNightsCap">
                        Lifetime free nights per individual (optional)
                      </Label>
                      <Input
                        id="lifetimeFreeNightsCap"
                        type="number"
                        min="1"
                        value={lifetimeFreeNightsCap}
                        onChange={(e) => setLifetimeFreeNightsCap(e.target.value)}
                        placeholder="Leave blank for no lifetime cap"
                      />
                      {/* #2264 — the "Leave blank for no lifetime cap"
                          instruction is stated once, in the placeholder (where
                          it describes the empty control's own behaviour); the
                          line below no longer repeats it. */}
                      <p className="text-xs text-muted-foreground">
                        Caps the total free nights any one member can claim from this code across all
                        their bookings.
                      </p>
                    </div>
                  </>
                )}

                {type === "FIXED_NIGHTLY_PRICE" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="fixedNightlyPrice">
                        Fixed nightly price per eligible individual ({APP_CURRENCY})
                      </Label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                          $
                        </span>
                        <Input
                          id="fixedNightlyPrice"
                          {...MONEY_INPUT_PROPS}
                          className="pl-7"
                          value={fixedNightlyPriceDollars}
                          onChange={(e) => setFixedNightlyPriceDollars(e.target.value)}
                          required
                          {...fixedNightlyPriceHint.fieldProps}
                        />
                      </div>
                      <FieldHint {...fixedNightlyPriceHint.hintProps}>
                        Applied to each eligible guest-night. When assigned to members, the &quot;how
                        the code applies&quot; choice below decides whether it prices the whole group
                        or only the assigned members&apos; own nights. Example: 30.00
                      </FieldHint>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="fixedNightlyMode">Fixed nightly mode</Label>
                      <select
                        id="fixedNightlyMode"
                        value={fixedNightlyMode}
                        onChange={(e) =>
                          setFixedNightlyMode(e.target.value as "SET_PRICE" | "CAP_ONLY")
                        }
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                      >
                        <option value="SET_PRICE">Set everyone to this price</option>
                        <option value="CAP_ONLY">Use as maximum cap</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Set price can increase cheaper nights and decrease dearer nights. Cap only
                        leaves cheaper nights unchanged.
                      </p>
                    </div>
                  </>
                )}
              </div>

              {type !== "FIXED_AMOUNT" && type !== "FIXED_NIGHTLY_PRICE" && (
                <div className="space-y-2 max-w-md">
                  <Label htmlFor="maxNightlyValue">
                    Maximum nightly value covered (optional, {APP_CURRENCY})
                  </Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      $
                    </span>
                    <Input
                      id="maxNightlyValue"
                      {...MONEY_INPUT_PROPS}
                      className="pl-7"
                      value={maxNightlyValueDollars}
                      onChange={(e) => setMaxNightlyValueDollars(e.target.value)}
                      placeholder="Unlimited"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Caps the discount applied to any single night. Guest pays any excess.
                  </p>
                </div>
              )}

              <div className="border rounded-md p-4 space-y-4">
                <div>
                  <h3 className="text-sm font-medium">Usage limits</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave any field blank for no limit.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="maxGuestsPerBooking">
                      How many individuals can use this per booking?
                    </Label>
                    <Input
                      id="maxGuestsPerBooking"
                      type="number"
                      min="1"
                      value={maxGuestsPerBooking}
                      onChange={(e) => setMaxGuestsPerBooking(e.target.value)}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">
                      Max guests on a single booking the promo applies to (most expensive first).
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxUniqueMembersTotal">
                      How many individuals can use this overall?
                    </Label>
                    <Input
                      id="maxUniqueMembersTotal"
                      type="number"
                      min="1"
                      value={maxUniqueMembersTotal}
                      onChange={(e) => setMaxUniqueMembersTotal(e.target.value)}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">
                      Cap on distinct members who can ever redeem this code.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxUsesPerMember">
                      How many times can the same individual use this?
                    </Label>
                    <Input
                      id="maxUsesPerMember"
                      type="number"
                      min="1"
                      value={maxUsesPerMember}
                      onChange={(e) => setMaxUsesPerMember(e.target.value)}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">
                      Set to 1 for single-use per member.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxRedemptionsTotal">
                      Total redemptions allowed
                    </Label>
                    <Input
                      id="maxRedemptionsTotal"
                      type="number"
                      min="1"
                      value={maxRedemptionsTotal}
                      onChange={(e) => setMaxRedemptionsTotal(e.target.value)}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">
                      Hard cap on uses across everyone. Reaching either this or the unique-members cap closes the promo.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="validFrom">Valid From (optional)</Label>
                  <Input
                    id="validFrom"
                    type="date"
                    value={validFrom}
                    onChange={(e) => setValidFrom(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="validUntil">Valid Until (optional)</Label>
                  <Input
                    id="validUntil"
                    type="date"
                    value={validUntil}
                    onChange={(e) => setValidUntil(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="bookingStartFrom">Booking Check-in From (optional)</Label>
                  <Input
                    id="bookingStartFrom"
                    type="date"
                    value={bookingStartFrom}
                    onChange={(e) => setBookingStartFrom(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Only apply to bookings with check-in on or after this date
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bookingStartUntil">Booking Check-in Until (optional)</Label>
                  <Input
                    id="bookingStartUntil"
                    type="date"
                    value={bookingStartUntil}
                    onChange={(e) => setBookingStartUntil(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Only apply to bookings with check-in before this date
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-6">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="membersOnly"
                    checked={membersOnly}
                    onChange={(e) => setMembersOnly(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="membersOnly">Members only (booker must be a member)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="memberGuestsOnly"
                    checked={memberGuestsOnly}
                    onChange={(e) => setMemberGuestsOnly(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="memberGuestsOnly">
                    Member guests only (promo applies only to member guest rows)
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="active"
                    checked={active}
                    onChange={(e) => setActive(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="active">Active</Label>
                </div>
              </div>

              <div className="space-y-3 border rounded-md p-4">
                <div>
                  <Label>Xero accounting (optional)</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    Code the discount line on the Xero invoice to a separate item or account so promo usage shows in the P&amp;L. Leave both blank to keep the existing behaviour (discount inherits the hut-fee codes).
                  </p>
                </div>
                {xeroDataLoading ? (
                  <p className="text-xs text-muted-foreground">Loading Xero accounts and items...</p>
                ) : null}
                {xeroDataError ? (
                  <p className="text-xs text-warning-11">
                    {xeroDataError}. Enter the codes manually below.
                  </p>
                ) : null}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="xeroItemCode">Xero Item Code</Label>
                    {xeroDataLoaded && xeroItems.length > 0 ? (
                      <Select
                        value={xeroItemCode || "__none__"}
                        onValueChange={(value) =>
                          setXeroItemCode(value === "__none__" ? "" : value)
                        }
                      >
                        <SelectTrigger id="xeroItemCode">
                          <SelectValue placeholder="Select item..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">
                            <span className="text-muted-foreground">Not configured</span>
                          </SelectItem>
                          {xeroItems.map((item) => (
                            <SelectItem key={item.code} value={item.code}>
                              {item.code} - {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id="xeroItemCode"
                        type="text"
                        value={xeroItemCode}
                        onChange={(e) => setXeroItemCode(e.target.value)}
                        maxLength={30}
                        {...xeroItemCodeHint.fieldProps}
                      />
                    )}
                    {/* #2257 — the example belongs to the MANUAL-entry branch
                        only: when Xero data loaded, the code is chosen from a
                        Select and there is nothing to type. */}
                    {xeroDataLoaded && xeroItems.length > 0 ? null : (
                      <FieldHint {...xeroItemCodeHint.hintProps}>
                        Example: PROMO-DISC
                      </FieldHint>
                    )}
                    <p className="text-xs text-muted-foreground">
                      If set, the discount line posts to this Xero item. The item&apos;s mapped account in Xero takes priority over the account code below.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="xeroAccountCode">Xero Account Code</Label>
                    {xeroDataLoaded && xeroAccounts.length > 0 ? (
                      <Select
                        value={xeroAccountCode || "__none__"}
                        onValueChange={(value) =>
                          setXeroAccountCode(value === "__none__" ? "" : value)
                        }
                      >
                        <SelectTrigger id="xeroAccountCode">
                          <SelectValue placeholder="Select account..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">
                            <span className="text-muted-foreground">Not configured (use default)</span>
                          </SelectItem>
                          {xeroAccounts
                            .filter((a) => a.type === "REVENUE")
                            .map((account) => (
                              <SelectItem key={account.code} value={account.code}>
                                {account.code} - {account.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id="xeroAccountCode"
                        type="text"
                        value={xeroAccountCode}
                        onChange={(e) => setXeroAccountCode(e.target.value)}
                        maxLength={10}
                        {...xeroAccountCodeHint.fieldProps}
                      />
                    )}
                    {/* #2257 — manual-entry branch only; see the item-code note. */}
                    {xeroDataLoaded && xeroAccounts.length > 0 ? null : (
                      <FieldHint {...xeroAccountCodeHint.hintProps}>
                        Example: 201
                      </FieldHint>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Used when no item code is set, or to override the item&apos;s default account.
                    </p>
                  </div>
                </div>
              </div>

              {multiLodge && (
                <div className="space-y-3 border rounded-md p-4">
                  <div>
                    <Label>Restrict to Lodges (optional)</Label>
                    <p className="text-sm text-muted-foreground mt-1">
                      If lodges are selected, the code is redeemable only on
                      bookings at those lodges. Leave all unticked for every
                      lodge, including lodges added later.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-4">
                    {lodges.map((lodge) => (
                      <label
                        key={lodge.id}
                        className="flex items-center space-x-2"
                      >
                        <input
                          type="checkbox"
                          checked={restrictedLodgeIds.includes(lodge.id)}
                          onChange={(e) => {
                            setRestrictedLodgeIds((current) =>
                              e.target.checked
                                ? [...current, lodge.id]
                                : current.filter((id) => id !== lodge.id)
                            );
                          }}
                          className="rounded border-input"
                        />
                        <span className="text-sm">{lodge.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-3 border rounded-md p-4">
                <div>
                  <Label>Assign to Specific Members (optional)</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    If members are assigned, only they can use this code. Leave empty to allow anyone.
                  </p>
                </div>
                <div className="relative">
                  <Input
                    value={memberSearch}
                    onChange={(e) => searchMembers(e.target.value)}
                    placeholder="Search members by name or email..."
                  />
                  {memberResults.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-background border rounded-md shadow-lg max-h-48 overflow-y-auto">
                      {memberResults.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => addMember(m)}
                          className="w-full text-left px-3 py-2 hover:bg-muted text-sm"
                        >
                          {m.firstName} {m.lastName}{" "}
                          <span className="text-muted-foreground">({m.email})</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {searchingMembers && (
                    <div className="absolute z-10 w-full mt-1 bg-background border rounded-md shadow-lg px-3 py-2 text-sm text-muted-foreground">
                      Searching...
                    </div>
                  )}
                </div>
                {assignedMembers.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {assignedMembers.map((m) => (
                        <Badge
                          key={m.id}
                          variant="secondary"
                          className="flex items-center gap-1 py-1 px-2"
                        >
                          {m.firstName} {m.lastName}
                          <button
                            type="button"
                            onClick={() => removeMember(m.id)}
                            className="ml-1 text-muted-foreground hover:text-foreground"
                          >
                            &times;
                          </button>
                        </Badge>
                      ))}
                    </div>
                    <div className="space-y-2 rounded-md border bg-muted p-3">
                      <span className="block text-sm font-medium">
                        How the code applies to a booking
                      </span>
                      <label className="flex items-start gap-2">
                        <input
                          type="radio"
                          name="assignedMembersOnlyOwnNights"
                          checked={assignedMembersOnlyOwnNights}
                          onChange={() => {
                            setAssignedMembersOnlyOwnNights(true);
                            setAssignmentScopeTouched(true);
                          }}
                          className="mt-1"
                        />
                        <span className="space-y-1">
                          <span className="block text-sm font-medium">
                            Assigned members&apos; own nights only
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            Anyone can enter the code, but it only applies to the listed members&apos; own guest nights.
                          </span>
                        </span>
                      </label>
                      <label className="flex items-start gap-2">
                        <input
                          type="radio"
                          name="assignedMembersOnlyOwnNights"
                          checked={!assignedMembersOnlyOwnNights}
                          onChange={() => {
                            setAssignedMembersOnlyOwnNights(false);
                            setAssignmentScopeTouched(true);
                          }}
                          className="mt-1"
                        />
                        <span className="space-y-1">
                          <span className="block text-sm font-medium">
                            {fixedNightlyGroupCapable
                              ? "Whole booking (group rate)"
                              : "Booker chooses guests"}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {fixedNightlyGroupCapable
                              ? "A listed member must be the booker. The fixed nightly price then applies to every eligible guest on the booking, members and non-members alike."
                              : "Only a listed member can use the code as booker, then choose which guests receive it."}
                          </span>
                        </span>
                      </label>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex space-x-3">
                <ViewOnlyActionButton canEdit={canEdit} describeReason={false} type="submit" disabled={saving}>
                  {saving
                    ? "Saving..."
                    : editingId
                      ? "Update Promo Code"
                      : "Create Promo Code"}
                </ViewOnlyActionButton>
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {promoCodes.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No promo codes yet. Click &quot;Add Promo Code&quot; to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {promoCodes.map((promo) => renderPromoCard(promo, false))}
        </div>
      )}

      <div className="border-t pt-6">
        <button
          onClick={() => setShowArchived(!showArchived)}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground text-sm font-medium"
        >
          <span>{showArchived ? "▼" : "▶"}</span>
          Archived Promo Codes
          {archivedCodes.length > 0 && showArchived && (
            <Badge variant="outline">{archivedCodes.length}</Badge>
          )}
        </button>
        {showArchived && (
          <div className="mt-4 space-y-4">
            {archivedCodes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No archived promo codes.</p>
            ) : (
              archivedCodes.map((promo) => renderPromoCard(promo, true))
            )}
          </div>
        )}
      </div>
        </>
      ) : null}
      </div>
    </div>
  );
}
