"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, describedByFieldHint, useFieldHint } from "@/components/ui/field-hint";
import { FocusedActionError } from "@/components/focused-action-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { APP_CURRENCY } from "@/config/operational";
import { formatCents } from "@/lib/pricing";
import { MONEY_INPUT_PROPS, parseDecimalDollarsToCents } from "@/lib/money-input";
import {
  computeMembershipTypeRateGaps,
  seasonRequiresRates,
  selectTypesRequiringHutRates,
  type MembershipTypeRateGap,
} from "@/lib/membership-type-rate-coverage";
import {
  FLAT_RATE_CELL_KEY as FLAT_KEY,
  amountFieldValue,
  copySeasonConfiguration,
  emptyRateCells as emptyRates,
  rateCellKey as rateKey,
  rateCellsFromSeason as seasonToRatesMap,
  rateRowsFromCells,
  resolvedTierRate,
  type RateCells,
} from "@/lib/season-rate-grid";
import {
  SeasonCoverageGapNotice,
  SeasonCoverageGapSummary,
} from "@/components/admin/season-coverage-warning";
import { useClubTime } from "@/components/club-time-provider";
import {
  AdminViewOnlyNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select";
import { LodgeScopeStatusNotice } from "@/components/admin/lodge-options-status";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope";
import {
  calendarDayFromPayload,
  formatPayloadCalendarDay,
} from "../../_lib/calendar-day";
import { readSeasonSchedule } from "../../_lib/season-schedule";
import { MissingHutRatesNotice } from "./missing-hut-rates-notice";

// The Hut Fees section of the consolidated /admin/fees console (#1933, E7):
// per-lodge → per-season → membership-type × age-tier nightly rate grid (E4).
// This is where hut nightly rates AND seasons are created/edited (the season
// POST requires ≥1 rate, so a rate-less season cannot be created on the
// windows-only /admin/seasons page — creating a season with its rates lives
// here). Editing rates for an existing season PUTs membershipTypeRates; editing
// only a season's window metadata is done on /admin/seasons (which omits rates,
// leaving them untouched). All edit controls gate on `canEdit` (bookings:edit).

interface MembershipTypeRate {
  membershipTypeId: string;
  ageTier: AgeTier | null;
  pricePerNightCents: number;
}

interface Season {
  id: string;
  name: string;
  type: "WINTER" | "SUMMER";
  startDate: string;
  endDate: string;
  active: boolean;
  // Flat whole-lodge night rate in integer cents, or null when not set (#2338).
  flatWholeLodgeNightCents: number | null;
  membershipTypeRates: MembershipTypeRate[];
}

interface AgeTierSetting {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  sortOrder: number;
}

interface RateType {
  id: string;
  key: string;
  name: string;
  bookingBehavior: "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
  ageGroupsApply: boolean;
}

const FALLBACK_TIERS: AgeTierSetting[] = [
  { tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant (under 5)", sortOrder: 0 },
  { tier: "CHILD", minAge: 5, maxAge: 9, label: "Child (5-9)", sortOrder: 1 },
  { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
  { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 3 },
];

// CT-4 (#2870): a season edge is a CALENDAR DATE and calendar dates take no
// timezone — the API serialises the `@db.Date` column as UTC midnight, and the
// kernel's calendar-date formatter pins "UTC" over that encoding, so the
// projection is the identity for every club. It used to be read through
// APP_TIME_ZONE, which for a club behind UTC named the previous day.
function formatSeasonEdge(value: string): string {
  return formatPayloadCalendarDay(value, value);
}

/*
  #2264 — ONE hint per membership type's rate table, not one per rate cell: the
  grid is nested `.map()`s, so a per-cell hint would repeat the same example
  dozens of times. The rate boxes render inside a `.map()` too, so a hook cannot
  be called per table; the id is derived from the membership type id and spelled
  exactly once here.
*/
function rateHintId(membershipTypeId: string): string {
  return `rate-hint-${membershipTypeId}`;
}

function rateErrorId(key: string): string {
  return `rate-error-${key}`;
}

/** What every refused amount box on this form says (#2685). */
const AMOUNT_FIELD_ERROR =
  "Enter an amount in dollars and cents, for example 45.00.";

function withoutKey(
  errors: Record<string, string>,
  key: string,
): Record<string, string> {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

export function HutFeesSection({ canEdit }: { canEdit: boolean }) {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [ageTiers, setAgeTiers] = useState<AgeTierSetting[]>(FALLBACK_TIERS);
  const [rateTypes, setRateTypes] = useState<RateType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /*
    #2685 review — "Fix the highlighted amounts before saving." was raised from
    a submit handler about 200 lines of markup BELOW the banner that shows it.
    The banner carried `role="alert"`, so a screen reader heard it, but nothing
    took focus and nothing scrolled: a sighted admin pressed Save on a long
    seasons form, the page did not visibly move, and the only sign the save had
    been refused was off the top of the screen.

    `FocusedActionError` is the repository's answer to exactly that — an
    assertive live region that focuses itself and scrolls into view — and the
    counter re-fires it when the same message is raised twice, which pressing
    Save again without fixing the box does every time.
  */
  const [errorAttention, setErrorAttention] = useState(0);
  /** Record a failure AND re-announce it, even when the text has not changed. */
  const raiseError = useCallback((message: string) => {
    setError(message);
    setErrorAttention((version) => version + 1);
  }, []);
  // Cross-area read: /api/admin/seasons is bookings-gated, so a finance-only
  // operator on the shared /admin/fees console gets a 403 here. Surface that as
  // a friendly read-only notice instead of a raw fetch-failed error (E7 review,
  // Lens-A F1). The read API area is intentionally left unchanged.
  const [forbidden, setForbidden] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const { scrollToTop } = useScrollToFeedback();
  /*
    #2938 review — which season the open form was pre-filled from, and a
    counter so copying twice from the same one re-announces it.

    `null` means "this form was not pre-filled": a fresh Add season, an Edit, or
    a closed form. Only the name is held, because the name is the ONLY thing the
    officer needs back — everything else about the copy is in the boxes in front
    of them, and deliberately not the source's identity.
  */
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);
  const [copyAttention, setCopyAttention] = useState(0);
  const copyNoticeRef = useRef<HTMLParagraphElement>(null);
  /*
    A PASSIVE effect, for the reason `FocusedActionError` writes out in full:
    focus has to land strictly AFTER the commit that puts the paragraph in the
    DOM, or there is nothing to focus. `copyAttention` is in the dependency list
    so a second copy from the SAME season re-announces rather than sitting
    silent because the name did not change.
  */
  useEffect(() => {
    if (copiedFrom === null) return;
    copyNoticeRef.current?.focus({ preventScroll: true });
  }, [copiedFrom, copyAttention]);
  const {
    lodges,
    loading: lodgesLoading,
    // Named apart from this section's own `forbidden` above, which is about the
    // bookings-gated seasons READ. These two are different refusals.
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
    reload: reloadLodgeOptions,
  } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation);
  /*
    #2701: a FAILED lodge list is not "a club with no lodges", but until now the
    two were the same empty array here. LodgeSelect renders nothing below two
    options (ADR-002) and normalises the selection to null, and a season created
    with no lodgeId is resolved server-side to the club's DEFAULT lodge — which
    on this section means a whole grid of nightly rates, and a flat whole-lodge
    night rate, priced onto a property nobody chose. While that is true this
    section does no lodge-scoped work at all.

    A `?lodgeId=` hub link is retained through failure/retry, but remains inert
    until a successful lodge response validates that id.
  */
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: lodgeId,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
  });
  const scopedLodgeId = lodgeScope.kind === "lodge" ? lodgeScope.lodgeId : null;
  const activeScopeRef = useRef<string | null>(scopedLodgeId);
  /*
    #2887: ownership follows the COMMIT, not the render, and this must stay a
    LAYOUT effect - a passive one is flushed after paint, leaving a window in
    which a late lodge-A response still reads A as current. Full reasoning and
    both mutation proofs live in one place:
    `src/lib/__tests__/lodge-scope-committed-ownership.test.tsx`.
  */
  useLayoutEffect(() => {
    activeScopeRef.current = scopedLodgeId;
  }, [scopedLodgeId]);
  const lodgeScopeReady = scopedLodgeId !== null;

  const [name, setName] = useState("");
  // #2257 — the example lives UNDER the field, not inside it as grey pseudo-content.
  const nameHint = useFieldHint();
  const [type, setType] = useState<"WINTER" | "SUMMER">("WINTER");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [active, setActive] = useState(true);
  // A cell with no rate is `null`, never `0` — see `emptyRates` (#2933).
  const [rates, setRates] = useState<RateCells>({});
  /*
    #2685: what the admin has actually TYPED into each amount box, and the
    complaint for any box whose text is not a dollar amount.

    `rates` holds cents and is what gets saved, so it cannot also hold a
    half-typed or malformed entry. Keeping the raw text beside it is what lets
    the box show "45.0x" with an error under it instead of silently snapping
    back — and, before this issue, instead of silently saving a nightly rate of
    $0.00 for the whole season.
  */
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [rateErrors, setRateErrors] = useState<Record<string, string>>({});
  const [flatWholeLodgeDraft, setFlatWholeLodgeDraft] = useState<string | null>(null);
  const [flatWholeLodgeError, setFlatWholeLodgeError] = useState("");
  // #2338: the season's flat whole-lodge night rate in integer cents, or null
  // when the club does not charge a flat whole-lodge rate for this season.
  const [flatWholeLodgeCents, setFlatWholeLodgeCents] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchAgeTiers = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/age-tier-settings");
      if (!res.ok) return;
      const data = await res.json();
      if (data.settings && data.settings.length > 0) {
        setAgeTiers(data.settings);
      }
    } catch {
      // Use fallback tiers
    }
  }, []);

  const fetchRateTypes = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/membership-types");
      if (!res.ok) return;
      const data = await res.json();
      // `INV-MOD-007`, asked in one place (#2933): every active MEMBER_RATE type
      // plus the built-in NON_MEMBER type owes its own rows, and nothing else
      // does — so nothing else may be warned about missing them either.
      const types: RateType[] = selectTypesRequiringHutRates(
        (data.membershipTypes ?? []) as Array<RateType & { isActive: boolean }>,
      )
        .map((t: RateType) => ({
          id: t.id,
          key: t.key,
          name: t.name,
          bookingBehavior: t.bookingBehavior,
          ageGroupsApply: t.ageGroupsApply,
        }));
      setRateTypes(types);
    } catch {
      // No rate types available; the grid renders empty.
    }
  }, []);

  const fetchSeasons = useCallback(async (signal?: AbortSignal) => {
    // #2701: no lodge, no read. Clear what the pre-failure unscoped request
    // put on screen too — those are some other lodge's rates.
    if (!scopedLodgeId) {
      setSeasons([]);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(
        `/api/admin/seasons?lodgeId=${encodeURIComponent(scopedLodgeId)}`,
        { signal },
      );
      if (res.status === 403) {
        setForbidden(true);
        setError("");
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch seasons");
      const data = await res.json();
      setForbidden(false);
      setSeasons(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [scopedLodgeId]);

  useEffect(() => {
    if (!lodgeScopeReady) return;
    fetchAgeTiers();
    fetchRateTypes();
  }, [fetchAgeTiers, fetchRateTypes, lodgeScopeReady]);

  useEffect(() => {
    const controller = new AbortController();
    fetchSeasons(controller.signal);
    return () => controller.abort();
  }, [fetchSeasons]);

  /*
    #2933 — which required nightly rates are MISSING, per season, computed from
    exactly what is already on screen.

    The rule is the shared one (`INV-MOD-007`): `rateTypes` above is already the
    set of types that owe rows, and `computeMembershipTypeRateGaps` decides
    coverage tier by tier, including the flat-row fallback an age-keyed type may
    price from. So a type that owes nothing is never warned about, and a type
    covered by a flat rate is not reported as missing four tier rates it will
    never read.

    Only seasons a booking can still land on are judged. A closed past season
    keeps whatever rows priced its bookings and there is nothing an officer can
    usefully do about it. "Today" is the CLUB's day (`INV-DATE-019`), taken from
    the bound kernel rather than the browser's clock.
  */
  const clubToday = useClubTime().today();
  const gapsBySeason = useMemo(() => {
    const bookableAgeTiers = ageTiers.map((tier) => tier.tier);
    const byId = new Map<string, MembershipTypeRateGap[]>();
    if (rateTypes.length === 0 || bookableAgeTiers.length === 0) return byId;
    for (const season of seasons) {
      const endDate = calendarDayFromPayload(season.endDate);
      // An edge this screen cannot read is not evidence of a gap. Say nothing
      // rather than warn about a season whose scope is unknown.
      if (endDate === null) continue;
      if (!seasonRequiresRates({ active: season.active, endDate }, clubToday)) {
        continue;
      }
      const gaps = computeMembershipTypeRateGaps({
        types: rateTypes,
        seasons: [{ id: season.id, name: season.name }],
        rateRows: season.membershipTypeRates.map((rate) => ({
          seasonId: season.id,
          membershipTypeId: rate.membershipTypeId,
          ageTier: rate.ageTier,
        })),
        bookableAgeTiers,
      });
      if (gaps.length > 0) byId.set(season.id, gaps);
    }
    return byId;
  }, [ageTiers, clubToday, rateTypes, seasons]);

  /*
    #2938 — the schedule IN ORDER, with the nights nothing prices marked where
    they fall.

    Seasons arrive from the API in whatever order the query returned, which is
    not chronological and is not stable between refreshes. The decode-and-order
    policy is `readSeasonSchedule`, shared with the Seasons page because both
    screens answer the same question from the same payload and a rule typed
    twice drifts; the date arithmetic under it lives in `@/lib/season-timeline`.
  */
  const { timeline, coverageGaps, undatedSeasons } = useMemo(
    () => readSeasonSchedule({ seasons, today: clubToday }),
    [clubToday, seasons],
  );

  /** The club's own label for an age tier, falling back to the tier's name. */
  const tierLabel = useCallback(
    (tier: string) =>
      ageTiers.find((setting) => setting.tier === tier)?.label ?? tier,
    [ageTiers],
  );

  function resetForm() {
    setCopiedFrom(null);
    setName("");
    setType("WINTER");
    setStartDate("");
    setEndDate("");
    setActive(true);
    setRates(emptyRates(rateTypes, ageTiers));
    clearAmountDrafts();
    setFlatWholeLodgeCents(null);
    setEditingId(null);
    setShowForm(false);
    setError("");
  }

  function handleLodgeChange(nextLodgeId: string | null) {
    activeScopeRef.current = nextLodgeId;
    setLodgeId(nextLodgeId);
    setSeasons([]);
    setLoading(true);
    resetForm();
  }

  function startEdit(season: Season) {
    if (!lodgeScopeReady) return;
    setCopiedFrom(null);
    setEditingId(season.id);
    setName(season.name);
    setType(season.type);
    setStartDate(calendarDayFromPayload(season.startDate) ?? "");
    setEndDate(calendarDayFromPayload(season.endDate) ?? "");
    setActive(season.active);
    setRates(seasonToRatesMap(season.membershipTypeRates, rateTypes, ageTiers));
    clearAmountDrafts();
    setFlatWholeLodgeCents(season.flatWholeLodgeNightCents);
    setShowForm(true);
    // The Edit buttons sit at the bottom of the seasons table, but the form
    // they open renders at the top of this section — without a scroll the page
    // does not visibly change and the form opens off the top of the screen.
    scrollToTop(sectionRef);
  }

  function startCreate() {
    if (!lodgeScopeReady) return;
    setCopiedFrom(null);
    setRates(emptyRates(rateTypes, ageTiers));
    clearAmountDrafts();
    setFlatWholeLodgeCents(null);
    setShowForm(true);
  }

  /*
    #2938 — "Copy/Create from this season": a NEW season pre-loaded with an
    existing one's configuration, so a club that runs the same shape of winter
    every year sets its rates once.

    `copySeasonConfiguration` decides what crosses, and its return type is what
    keeps the copy honest — it has no id, no name and no dates, so there is
    nothing here for a new season to inherit the source's identity through.
    Three consequences, all of them the issue's binding contract:

    - `editingId` stays NULL, so Save is a POST of a brand-new season. The
      source cannot be overwritten by this action because the form holds no id
      to PUT to.
    - Name and dates are left EMPTY and are `required` on the form, so the
      officer must give the new season its own identity and window, and the POST
      route then applies its ordinary overlap and shape validation.
    - Amounts cross as the integer cents the API returned. The boxes are drawn
      from those cents by `amountFieldValue`, and `rateDrafts` is cleared, so an
      amount the officer does not touch is never parsed back out of the text it
      is displayed as (#2932). A cell the source has no rate for arrives absent,
      not zero — copying a hole as a $0.00 row would manufacture exactly what
      the missing-rates panel above exists to prevent (#2933).
  */
  function startCopyFrom(season: Season) {
    if (!lodgeScopeReady) return;
    const copied = copySeasonConfiguration(season, rateTypes, ageTiers);
    setEditingId(null);
    setName("");
    setStartDate("");
    setEndDate("");
    setType(copied.type);
    setActive(copied.active);
    setRates(copied.rateCells);
    clearAmountDrafts();
    setFlatWholeLodgeCents(copied.flatWholeLodgeNightCents);
    setShowForm(true);
    setError("");
    // What was copied, and from what — said on screen and taken to by focus,
    // because the copy carries no name or dates and so confirms itself nowhere
    // else. The effect above does the focusing; see the paragraph it focuses.
    setCopiedFrom(season.name);
    setCopyAttention((version) => version + 1);
    // Same reason as `startEdit`: the button is at the bottom of the list and
    // the form it opens renders at the top of the section.
    scrollToTop(sectionRef);
  }

  /** Drop every typed-but-unsaved amount and its complaint. */
  function clearAmountDrafts() {
    setRateDrafts({});
    setRateErrors({});
    setFlatWholeLodgeDraft(null);
    setFlatWholeLodgeError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!scopedLodgeId) return;
    const requestedScope = scopedLodgeId;
    setError("");

    // #2685: never save around an amount the parser refused — the stored cents
    // for that field are the PREVIOUS value, which is not what the admin typed.
    if (Object.keys(rateErrors).length > 0 || flatWholeLodgeError) {
      // `raiseError`, not `setError`: this exact sentence is what a second Save
      // press produces too, so the banner has to re-announce and re-scroll
      // rather than sit unchanged far above the button (#2685 review).
      raiseError("Fix the highlighted amounts before saving.");
      return;
    }

    /*
      #2933 review, now stated once in `@/lib/season-rate-grid`: a cell with NO
      rate is not sent, and a cell holding `0` is. `membershipTypeRates` is a
      replace-all payload, so an unsent cell is a cell with no row — the state
      the missing-rates panel above is warning about, and the state the pricing
      engine refuses on rather than guesses at. Sending a zero for it would
      silence the warning by charging those guests nothing. The copy action
      below reads that same rule, which is why it moved out of this function.
    */
    const membershipTypeRates: MembershipTypeRate[] = rateRowsFromCells(rates);

    /*
      `membershipTypeSeasonRateInputSchema` requires at least one rate, so a
      season with every box empty is refused by the API as "Validation failed" —
      true, and no use to the officer who cleared the last box. Say it here, in
      this screen's own words, and send nothing. It is a refusal and not a
      silent zero: the answer to "no rates" is still no rates.
    */
    if (membershipTypeRates.length === 0) {
      raiseError("Set at least one nightly rate before saving this season.");
      return;
    }

    // Last, so every refusal above returns before the button is disabled and
    // the `finally` below is the only thing that has to release it.
    setSaving(true);

    const payload = {
      name,
      type,
      startDate,
      endDate,
      active,
      membershipTypeRates,
      // #2338: send the flat whole-lodge rate explicitly (null clears it) so an
      // edit here always reflects what the form shows. The windows-only Seasons
      // page never sends this field, so a window edit there leaves it untouched.
      flatWholeLodgeNightCents: flatWholeLodgeCents,
      ...(editingId ? {} : { lodgeId: scopedLodgeId }),
    };

    try {
      const url = editingId
        ? `/api/admin/seasons/${editingId}`
        : "/api/admin/seasons";
      const method = editingId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save season");
      }

      if (activeScopeRef.current !== requestedScope) return;

      resetForm();
      fetchSeasons();
    } catch (err) {
      raiseError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!lodgeScopeReady) return;
    const requestedScope = scopedLodgeId;
    if (!confirm("Are you sure you want to delete this season?")) return;

    try {
      const res = await fetch(`/api/admin/seasons/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete");
      }
      if (activeScopeRef.current !== requestedScope) return;
      fetchSeasons();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleToggleActive(season: Season) {
    if (!lodgeScopeReady) return;
    const requestedScope = scopedLodgeId;
    try {
      const res = await fetch(`/api/admin/seasons/${season.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !season.active }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update");
      }
      if (activeScopeRef.current !== requestedScope) return;
      fetchSeasons();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  /*
    #2685: a nightly rate the parser refuses is REFUSED, not rounded and not
    zeroed. It used to be `parseFloat`, and anything it could not read — a stray
    character, a third decimal place, an amount past the storable maximum —
    became `0`, which saved as "this membership type stays here for free" with
    nothing on screen to say so.

    An empty box is still a deliberate clear, not an error: it means NO RATE,
    which is `null` and not `0` (#2933 review). Clearing a box used to store
    zero, so "I do not charge this type on this season" and "I charge them
    nothing" were the same saved row — and the second is the one that gets
    written, because a zero-cent row prices every such guest at $0.00 instead of
    refusing the booking. This is the rule the flat whole-lodge handler below
    already followed.
  */
  function handleRateChange(key: string, value: string) {
    setRateDrafts((prev) => ({ ...prev, [key]: value }));

    if (value.trim() === "") {
      setRates((prev) => ({ ...prev, [key]: null }));
      setRateErrors((prev) => withoutKey(prev, key));
      return;
    }

    const cents = parseDecimalDollarsToCents(value);
    if (cents === null) {
      setRateErrors((prev) => ({ ...prev, [key]: AMOUNT_FIELD_ERROR }));
      return;
    }

    setRates((prev) => ({ ...prev, [key]: cents }));
    setRateErrors((prev) => withoutKey(prev, key));
  }

  // #2338: an EMPTY flat whole-lodge field means "no flat rate" (null), NOT $0 —
  // clearing it must switch the season back to per-guest whole-lodge pricing,
  // never charge nothing for the building. A typed dollar amount stores cents.
  function handleFlatWholeLodgeChange(value: string) {
    setFlatWholeLodgeDraft(value);

    if (value.trim() === "") {
      setFlatWholeLodgeCents(null);
      setFlatWholeLodgeError("");
      return;
    }

    // #2685: an amount the parser refuses used to land here as `null`, which is
    // the same value as an empty box — so a typo silently switched the season
    // back to per-guest whole-lodge pricing. It now complains instead.
    const cents = parseDecimalDollarsToCents(value);
    if (cents === null) {
      setFlatWholeLodgeError(AMOUNT_FIELD_ERROR);
      return;
    }

    setFlatWholeLodgeCents(cents);
    setFlatWholeLodgeError("");
  }

  /*
    One season's card. Lifted out of the list so the timeline below can render
    it in two places — in chronological order, and again for a season whose
    dates this screen could not decode — without a second copy of eighty lines
    of grid markup drifting away from the first.
  */
  function renderSeasonCard(season: Season) {
    return (
      <Card key={season.id}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <CardTitle headingLevel={3} className="text-xl">
                {season.name}
              </CardTitle>
              <Badge variant={season.type === "WINTER" ? "default" : "secondary"}>{season.type}</Badge>
              <Badge variant={season.active ? "default" : "outline"}>{season.active ? "Active" : "Inactive"}</Badge>
              {gapsBySeason.has(season.id) && (
                <Badge variant="destructive">Missing rates</Badge>
              )}
            </div>
            {canEdit && (
              <div className="flex space-x-2">
                {/*
                  #2938 review — every one of these names its SEASON.

                  Four identically-named buttons per card means a club with five
                  seasons offers a screen reader five entries reading "New season
                  from this", with nothing to tell them apart; the same holds for
                  a voice-control user saying the label out loud. Each accessible
                  name still STARTS with the visible text, so the visible label
                  remains a valid way to address the control (WCAG 2.5.3).
                  `ViewOnlyActionButton` spreads its caller's props onto `Button`
                  first, so `aria-label` reaches the element untouched.
                */}
                <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" aria-label={`${season.active ? "Deactivate" : "Activate"} ${season.name}`} onClick={() => handleToggleActive(season)}>
                  {season.active ? "Deactivate" : "Activate"}
                </ViewOnlyActionButton>
                <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" aria-label={`Edit ${season.name}`} onClick={() => startEdit(season)}>
                  Edit
                </ViewOnlyActionButton>
                {/* #2938: the label says what it MAKES — a new season — rather
                    than "Copy", which reads as putting something on a clipboard
                    and says nothing about what happens to the season clicked. */}
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  variant="outline"
                  size="sm"
                  aria-label={`New season from this: ${season.name}`}
                  onClick={() => startCopyFrom(season)}
                >
                  New season from this
                </ViewOnlyActionButton>
                <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" aria-label={`Delete ${season.name}`} onClick={() => handleDelete(season.id)}>
                  Delete
                </ViewOnlyActionButton>
              </div>
            )}
          </div>
          <CardDescription>
            {formatSeasonEdge(season.startDate)} &mdash;{" "}
            {formatSeasonEdge(season.endDate)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MissingHutRatesNotice
            gaps={gapsBySeason.get(season.id) ?? []}
            tierLabel={tierLabel}
          />
          {/* #2338: the season's flat whole-lodge rate, shown only
              when one is set. Absence reads as "priced per guest". */}
          <p className="mb-4 text-sm">
            <span className="font-semibold">Flat whole-lodge night rate: </span>
            {season.flatWholeLodgeNightCents != null ? (
              <span className="font-mono">
                {formatCents(season.flatWholeLodgeNightCents)} per night
              </span>
            ) : (
              <span className="text-muted-foreground">
                Not set (whole-lodge bookings priced per guest)
              </span>
            )}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {rateTypes.map((rt) => (
              <div key={rt.id}>
                <h4 className="text-sm font-semibold mb-2">{rt.name}</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Age Group</TableHead>
                      <TableHead className="text-right">Price/Night</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rt.ageGroupsApply ? (
                      ageTiers.map((t) => {
                        const rate = resolvedTierRate(
                          season.membershipTypeRates,
                          rt.id,
                          t.tier,
                        );
                        return (
                          <TableRow key={t.tier}>
                            <TableCell>{t.label}</TableCell>
                            <TableCell className="text-right font-mono">
                              {rate
                                ? `${formatCents(rate.pricePerNightCents)}${rate.fromFlatRate ? " (flat rate)" : ""}`
                                : "Not set"}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    ) : (
                      (() => {
                        const rate = season.membershipTypeRates.find(
                          (r) => r.membershipTypeId === rt.id && r.ageTier === null,
                        );
                        return (
                          <TableRow>
                            <TableCell>All ages (flat)</TableCell>
                            <TableCell className="text-right font-mono">
                              {rate ? formatCents(rate.pricePerNightCents) : "Not set"}
                            </TableCell>
                          </TableRow>
                        );
                      })()
                    )}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
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
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-6` stack so
    the empty wrapper an edit-capable admin gets costs no layout. Still gated on
    `!forbidden`: an admin who cannot even READ this section gets the stronger
    "no permission to view" notice below instead, and showing both would
    contradict itself.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Bookings view access can inspect hut fees. Bookings edit access is required to change nightly rates or seasons.
    </AdminViewOnlySectionBanner>
  );

  return (
    <Card ref={sectionRef}>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          {/*
            #2938: the page's <h1> is "Fees" (`AdminPageHeader` in
            `fees-page-client.tsx`), so this section is level 2 and everything
            this card renders below — the season form, every season card — is
            level 3. Levels are said at the CALL SITE and never skipped;
            `docs/ARCHITECTURE.md` -> "Card titles and heading semantics (#2796)"
            is the convention and is not restated here. Without them the whole
            schedule is a headingless run of cards with note blocks interleaved,
            which removes one of the two ways an assistive-technology user
            navigates it.
          */}
          <CardTitle headingLevel={2}>Hut fees</CardTitle>
          <CardDescription>
            Nightly hut rates per lodge, season, membership type, and age tier. Season windows
            (dates/active) are also editable on <Link href="/admin/seasons" className="underline">Seasons</Link>.
          </CardDescription>
        </div>
        {/* #2701: a season created with no lodge resolved is priced onto the
            club's default lodge, so the create is shut while that is true. */}
        {!forbidden && lodgeScopeReady && !showForm && canEdit && (
          <Button onClick={startCreate}>
            Add season
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!forbidden && viewOnlyBanner}
        <div className="space-y-6">
        {forbidden && (
          <AdminViewOnlyNotice canEdit={false}>
            You don&apos;t have permission to view this section. Hut fees are managed by
            bookings admins; ask a bookings admin if you need to see nightly rates.
          </AdminViewOnlyNotice>
        )}

        {/* #2701: say the lodge list failed, above the lodge-scoped rates it
            silently replaced with the default lodge's. Skipped in the
            `forbidden` branch, which renders no rates and no controls at all —
            two "you cannot see this" statements would contradict each other. */}
        {!forbidden && (
          <LodgeScopeStatusNotice
            scope={lodgeScope}
            onRetry={reloadLodgeOptions}
            what="hut fee rates"
          />
        )}

        {!forbidden && (
        <div className="max-w-xs">
          <LodgeSelect lodges={lodges} value={lodgeId} onChange={handleLodgeChange} loading={lodgesLoading}
            // #2701: an empty list from a FAILED request is not evidence the
            // caller's lodge is gone, so the ADR-002 normaliser must not wipe a
            // ?lodgeId= hub link (ADR-003) while the outage lasts.
            deferDefaultSelection={lodgeOptionsFailed || lodgeOptionsForbidden}
          />
        </div>
        )}

        {!forbidden && lodgeScopeReady && (
          <FocusedActionError
            id="hut-fees-error"
            error={error}
            attentionKey={errorAttention}
            className="scroll-mt-20"
          />
        )}

        {forbidden || !lodgeScopeReady ? null : loading ? (
          <p className="text-sm text-muted-foreground">Loading seasons…</p>
        ) : (
          <>
            {showForm && canEdit && (
              <Card>
                <CardHeader>
                  <CardTitle headingLevel={3}>
                    {editingId ? "Edit Season" : "New Season"}
                  </CardTitle>
                  <CardDescription>
                    Configure the season period and set rates for each membership type
                  </CardDescription>
                  {copiedFrom !== null && editingId === null && (
                    /*
                      #2938 review — what a copy carried, said where the officer
                      can act on it.

                      The heading above says "New Season" and nothing else on
                      the screen says it was pre-filled, from WHICH season, or
                      what did and did not cross. That matters most for the
                      officer who cannot see the list: the copy deliberately
                      carries no name and no dates — which is what stops it
                      overwriting its source — so without this line there is no
                      confirmation of which season was copied, and picking the
                      wrong button produces a season carrying last summer's
                      rates under a name the officer types themselves.

                      It takes FOCUS rather than a live region. Opening the form
                      scrolled the section, which moves no focus and speaks
                      nothing, leaving a keyboard user on the button at the
                      bottom of the list; a Tab from there lands on the next
                      season's card, not in the form that just opened. Focusing
                      this paragraph announces it, puts the caret at the top of
                      the form, and makes the next Tab reach Season Name — the
                      one field the officer must fill in. A live region ON TOP
                      of that would announce the same sentence twice.
                    */
                    <p
                      ref={copyNoticeRef}
                      tabIndex={-1}
                      className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground outline-none"
                    >
                      Pre-filled from <strong>{copiedFrom}</strong>. Its type,
                      Active setting, flat whole-lodge rate and every nightly
                      rate came across exactly as they stand. Its name and dates
                      did not — give this season its own below. A rate{" "}
                      {copiedFrom} does not set arrives blank here rather than as
                      0.00. Saving creates a new season and does not change{" "}
                      {copiedFrom}.
                    </p>
                  )}
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="name">Season Name</Label>
                        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required {...nameHint.fieldProps} />
                        <FieldHint {...nameHint.hintProps}>Example: Winter 2026</FieldHint>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="type">Type</Label>
                        <select
                          id="type"
                          value={type}
                          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setType(e.target.value as "WINTER" | "SUMMER")}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                        >
                          <option value="WINTER">Winter</option>
                          <option value="SUMMER">Summer</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="startDate">Start Date</Label>
                        <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="endDate">End Date</Label>
                        <Input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <Label className="text-base font-semibold">Nightly Rates ({APP_CURRENCY})</Label>
                      <p className="text-sm text-muted-foreground">
                        Set the price per night for each membership type. Types with age
                        groups get a rate per age tier; flat types get a single rate.
                      </p>

                      {rateTypes.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No rate-bearing membership types found. Configure membership types first.
                        </p>
                      ) : (
                        <div className="space-y-6">
                          {rateTypes.map((rt) => (
                            <div key={rt.id}>
                              <h4 className="text-sm font-semibold mb-2">{rt.name}</h4>
                              {rt.ageGroupsApply ? (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                                  {ageTiers.map((t) => {
                                    const key = rateKey(rt.id, t.tier);
                                    return (
                                      <div key={key} className="space-y-1">
                                        <Label htmlFor={`rate-${key}`} className="text-sm">{t.label}</Label>
                                        <div className="relative">
                                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                                          <Input
                                            id={`rate-${key}`}
                                            {...MONEY_INPUT_PROPS}
                                            className="pl-7"
                                            value={amountFieldValue(rateDrafts[key], rates[key])}
                                            onChange={(e) => handleRateChange(key, e.target.value)}
                                            aria-invalid={rateErrors[key] ? true : undefined}
                                            /*
                                              #2685: the error id FIRST, then the
                                              hint — both, always. Pointing only
                                              at the error dropped "Example:
                                              45.00" for a screen-reader user at
                                              exactly the moment the example is
                                              what they need.
                                            */
                                            aria-describedby={describedByFieldHint(
                                              rateHintId(rt.id),
                                              rateErrors[key] ? rateErrorId(key) : undefined,
                                            )}
                                          />
                                        </div>
                                        {rateErrors[key] && (
                                          <p
                                            id={rateErrorId(key)}
                                            role="alert"
                                            className="text-destructive text-sm"
                                          >
                                            {rateErrors[key]}
                                          </p>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="max-w-xs space-y-1">
                                  <Label htmlFor={`rate-${rateKey(rt.id, FLAT_KEY)}`} className="text-sm">Flat rate (all ages)</Label>
                                  <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                                    <Input
                                      id={`rate-${rateKey(rt.id, FLAT_KEY)}`}
                                      {...MONEY_INPUT_PROPS}
                                      className="pl-7"
                                      value={amountFieldValue(
                                        rateDrafts[rateKey(rt.id, FLAT_KEY)],
                                        rates[rateKey(rt.id, FLAT_KEY)],
                                      )}
                                      onChange={(e) => handleRateChange(rateKey(rt.id, FLAT_KEY), e.target.value)}
                                      aria-invalid={rateErrors[rateKey(rt.id, FLAT_KEY)] ? true : undefined}
                                      aria-describedby={describedByFieldHint(
                                        rateHintId(rt.id),
                                        rateErrors[rateKey(rt.id, FLAT_KEY)]
                                          ? rateErrorId(rateKey(rt.id, FLAT_KEY))
                                          : undefined,
                                      )}
                                    />
                                  </div>
                                  {rateErrors[rateKey(rt.id, FLAT_KEY)] && (
                                    <p
                                      id={rateErrorId(rateKey(rt.id, FLAT_KEY))}
                                      role="alert"
                                      className="text-destructive text-sm"
                                    >
                                      {rateErrors[rateKey(rt.id, FLAT_KEY)]}
                                    </p>
                                  )}
                                </div>
                              )}
                              <FieldHint id={rateHintId(rt.id)} className="mt-1">
                                Example: 45.00 per night
                              </FieldHint>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/*
                      #2338: the season's flat whole-lodge night rate. Optional —
                      leaving it blank keeps whole-lodge approvals priced per
                      guest. When set, a booking officer can choose "price as
                      whole lodge" on a member's whole-lodge approval to charge
                      nights x this rate regardless of headcount.
                    */}
                    <div className="space-y-2">
                      <Label htmlFor="flat-whole-lodge-rate" className="text-base font-semibold">
                        Flat whole-lodge night rate ({APP_CURRENCY}, optional)
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        A single price per night for the whole building, regardless of how many
                        people come. Leave blank to price whole-lodge bookings per guest. When set,
                        a booking officer can choose &quot;price as whole lodge&quot; when they
                        approve a member&apos;s whole-lodge request, and the booking is charged this
                        rate per night instead of per guest.
                      </p>
                      <div className="relative max-w-xs">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                        <Input
                          id="flat-whole-lodge-rate"
                          {...MONEY_INPUT_PROPS}
                          className="pl-7"
                          // The same absence-versus-zero display rule the rate
                          // boxes above use, from its one home: a draft wins,
                          // absent cents render as an EMPTY box, and a stored
                          // zero renders as "0.00" (#2938 review). `??
                          // undefined` only bridges this field's `string |
                          // null` draft to the shared `string | undefined`.
                          value={amountFieldValue(
                            flatWholeLodgeDraft ?? undefined,
                            flatWholeLodgeCents,
                          )}
                          onChange={(e) => handleFlatWholeLodgeChange(e.target.value)}
                          aria-invalid={flatWholeLodgeError ? true : undefined}
                          aria-describedby={describedByFieldHint(
                            "flat-whole-lodge-rate-hint",
                            flatWholeLodgeError
                              ? "flat-whole-lodge-rate-error"
                              : undefined,
                          )}
                        />
                      </div>
                      {flatWholeLodgeError && (
                        <p
                          id="flat-whole-lodge-rate-error"
                          role="alert"
                          className="text-destructive text-sm"
                        >
                          {flatWholeLodgeError}
                        </p>
                      )}
                      <FieldHint id="flat-whole-lodge-rate-hint" className="mt-1">
                        Example: 600.00 per night for the whole lodge
                      </FieldHint>
                    </div>

                    <div className="flex items-center space-x-2">
                      <input type="checkbox" id="active" checked={active} onChange={(e) => setActive(e.target.checked)} className="rounded border-input" />
                      <Label htmlFor="active">Active</Label>
                    </div>

                    <div className="flex space-x-3">
                      {/* #2701: an edit is safe (the route ignores lodgeId on
                          update), but a create with no lodge lands on the
                          default lodge — so the shared button stays shut. */}
                      <Button type="submit" disabled={saving}>
                        {saving ? "Saving..." : editingId ? "Update Season" : "Create Season"}
                      </Button>
                      <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}

            {/*
              #2933: the count, before the officer scrolls. Each season below
              then names exactly which rates it is missing.
            */}
            {gapsBySeason.size > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <span className="font-semibold text-destructive">
                  {gapsBySeason.size === 1
                    ? "One season is missing required nightly rates."
                    : `${gapsBySeason.size} seasons are missing required nightly rates.`}
                </span>{" "}
                A booking that needs one of them is refused until it is set —
                nothing is priced at zero and no other rate is substituted.
              </div>
            )}

            {/*
              #2938: the nights nothing prices, counted before the officer
              scrolls, beside the missing-rates count above. A booking is
              refused either way, so the two belong together.
            */}
            <SeasonCoverageGapSummary gaps={coverageGaps} />

            {seasons.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  No seasons configured yet{canEdit ? '. Click "Add season" to get started.' : "."}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {timeline.map((entry) =>
                  entry.kind === "gap" ? (
                    <SeasonCoverageGapNotice
                      key={`gap-${entry.gap.afterSeasonId}-${entry.gap.beforeSeasonId}`}
                      gap={entry.gap}
                    />
                  ) : (
                    renderSeasonCard(entry.season)
                  ),
                )}
                {/* Dates this screen could not read: listed, never judged. */}
                {undatedSeasons.map((season) => renderSeasonCard(season))}
              </div>
            )}
          </>
        )}
        </div>
      </CardContent>
    </Card>
  );
}
