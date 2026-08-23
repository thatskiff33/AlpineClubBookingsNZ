"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
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
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope";
import {
  calendarDayFromPayload,
  formatPayloadCalendarDay,
} from "../../_lib/calendar-day";

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

const FLAT_KEY = "FLAT";

// CT-4 (#2870): a season edge is a CALENDAR DATE and calendar dates take no
// timezone — the API serialises the `@db.Date` column as UTC midnight, and the
// kernel's calendar-date formatter pins "UTC" over that encoding, so the
// projection is the identity for every club. It used to be read through
// APP_TIME_ZONE, which for a club behind UTC named the previous day.
function formatSeasonEdge(value: string): string {
  return formatPayloadCalendarDay(value, value);
}

function rateKey(membershipTypeId: string, ageTier: AgeTier | typeof FLAT_KEY): string {
  return `${membershipTypeId}::${ageTier}`;
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

/** The text an amount box shows: what was typed, else the stored cents. */
function amountFieldValue(draft: string | undefined, cents: number | undefined): string {
  if (draft !== undefined) return draft;
  return cents ? (cents / 100).toFixed(2) : "";
}

function cellsForType(type: RateType, tiers: AgeTierSetting[]): Array<AgeTier | typeof FLAT_KEY> {
  return type.ageGroupsApply ? tiers.map((t) => t.tier) : [FLAT_KEY];
}

function emptyRates(types: RateType[], tiers: AgeTierSetting[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const type of types) {
    for (const cell of cellsForType(type, tiers)) {
      rates[rateKey(type.id, cell)] = 0;
    }
  }
  return rates;
}

function seasonToRatesMap(
  rows: MembershipTypeRate[],
  types: RateType[],
  tiers: AgeTierSetting[],
): Record<string, number> {
  const map = emptyRates(types, tiers);
  for (const row of rows) {
    map[rateKey(row.membershipTypeId, row.ageTier ?? FLAT_KEY)] = row.pricePerNightCents;
  }
  return map;
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
  const [rates, setRates] = useState<Record<string, number>>({});
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
      const types: RateType[] = (data.membershipTypes ?? [])
        .filter(
          (t: RateType & { isActive: boolean }) =>
            t.isActive &&
            (t.bookingBehavior === "MEMBER_RATE" || t.key === "NON_MEMBER"),
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

  function resetForm() {
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
  }

  function startCreate() {
    if (!lodgeScopeReady) return;
    setRates(emptyRates(rateTypes, ageTiers));
    clearAmountDrafts();
    setFlatWholeLodgeCents(null);
    setShowForm(true);
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

    setSaving(true);

    const membershipTypeRates: MembershipTypeRate[] = Object.entries(rates).map(
      ([key, price]) => {
        const [membershipTypeId, tierPart] = key.split("::");
        return {
          membershipTypeId,
          ageTier: tierPart === FLAT_KEY ? null : (tierPart as AgeTier),
          pricePerNightCents: price,
        };
      },
    );

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

    An empty box is still a deliberate clear, not an error: it means no rate.
  */
  function handleRateChange(key: string, value: string) {
    setRateDrafts((prev) => ({ ...prev, [key]: value }));

    if (value.trim() === "") {
      setRates((prev) => ({ ...prev, [key]: 0 }));
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
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle>Hut fees</CardTitle>
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
                  <CardTitle>{editingId ? "Edit Season" : "New Season"}</CardTitle>
                  <CardDescription>
                    Configure the season period and set rates for each membership type
                  </CardDescription>
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
                          value={
                            flatWholeLodgeDraft ??
                            (flatWholeLodgeCents != null
                              ? (flatWholeLodgeCents / 100).toFixed(2)
                              : "")
                          }
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

            {seasons.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  No seasons configured yet{canEdit ? '. Click "Add season" to get started.' : "."}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {seasons.map((season) => (
                  <Card key={season.id}>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <CardTitle className="text-xl">{season.name}</CardTitle>
                          <Badge variant={season.type === "WINTER" ? "default" : "secondary"}>{season.type}</Badge>
                          <Badge variant={season.active ? "default" : "outline"}>{season.active ? "Active" : "Inactive"}</Badge>
                        </div>
                        {canEdit && (
                          <div className="flex space-x-2">
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => handleToggleActive(season)}>
                              {season.active ? "Deactivate" : "Activate"}
                            </ViewOnlyActionButton>
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEdit(season)}>
                              Edit
                            </ViewOnlyActionButton>
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" onClick={() => handleDelete(season.id)}>
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
                                    const rate = season.membershipTypeRates.find(
                                      (r) => r.membershipTypeId === rt.id && r.ageTier === t.tier,
                                    );
                                    return (
                                      <TableRow key={t.tier}>
                                        <TableCell>{t.label}</TableCell>
                                        <TableCell className="text-right font-mono">
                                          {rate ? formatCents(rate.pricePerNightCents) : "Not set"}
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
                ))}
              </div>
            )}
          </>
        )}
        </div>
      </CardContent>
    </Card>
  );
}
