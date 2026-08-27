"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { auditAndPaymentsDateRangePresets } from "@/lib/date-range-presets";
import { APP_LOCALE } from "@/config/operational";
import { useClubTime } from "@/components/club-time-provider";
import {
  formatClubDate,
  parseCalendarDate,
  parseInstant,
  type BoundClubTime,
} from "@/lib/club-time";
import { formatCents } from "@/lib/utils";
import { useLodgeOptions } from "@/components/lodge-select";
import { buildPromoRedemptionsCsvContent } from "@/lib/promo-redemptions-csv";

/**
 * A redemption's "Redeemed" stamp — a real INSTANT, read in the club's
 * PERSISTED zone (`INV-CONFIG-002`) rather than `APP_TIME_ZONE`.
 *
 * KNOWN SPLIT, and it is deliberate rather than an oversight. The CSV export
 * below renders the same field through `@/lib/promo-redemptions-csv`, which
 * formats it internally against the environment's zone and cannot be told a
 * different one from here. The two agree on any deployment whose `TZ` matches
 * its persisted zone — every deployment today — and diverge for one that does
 * not. Zoning the CSV builder is a `src/lib` signature change, tracked on
 * #2870 for the group that owns that surface; the screen is fixed here because
 * the screen is this file's to fix.
 */
function redeemedAtLabel(clubTime: BoundClubTime, value: string): string {
  const instant = parseInstant(value);
  return instant === null ? value : clubTime.instantDateTime(instant);
}

const TYPE_LABELS: Record<string, string> = {
  PERCENTAGE: "Percentage",
  FIXED_AMOUNT: "Fixed Amount",
  FREE_NIGHTS: "Free Nights",
  FIXED_NIGHTLY_PRICE: "Fixed Price per Night",
};

const PAGE_SIZE = 50;

interface Totals {
  // PromoRedemption rows — applications of the code, one per booking.
  redemptions: number;
  // Distinct BOOKERS across those applications (not beneficiaries).
  uniqueMembers: number;
  discountCents: number;
  freeNightsUsed: number;
  // Applications that gave nobody a benefit and so consumed no allowance
  // (#2299). Counted on the server, never derived by subtraction.
  benefitFreeRedemptions: number;
}

interface RedemptionAllocation {
  memberId: string;
  name: string;
  discountCents: number;
  freeNightsUsed: number;
}

interface RedemptionRow {
  id: string;
  createdAt: string;
  member: { id: string; name: string; email: string };
  booking: {
    id: string;
    reference: string;
    lodgeId: string;
    lodgeName: string;
    checkIn: string;
    checkOut: string;
    nights: number;
  };
  eligibleGuestCount: number | null;
  discountCents: number;
  // Signed: negative is money off, positive is a fixed nightly price ABOVE the
  // guest's normal rate. A raising application still counts as a use (#2299),
  // which is why a $0.00 discount is not by itself a "no benefit" marker.
  priceAdjustmentCents: number;
  freeNightsUsed: number;
  // Whether this application consumed any usage allowance at all.
  gaveBenefit: boolean;
  memberUseIndex: number;
  allocations: RedemptionAllocation[];
}

interface RedemptionsResponse {
  code: {
    id: string;
    code: string;
    description: string | null;
    type: string;
    active: boolean;
    archived: boolean;
    internal: boolean;
    // What the usage caps count: applications that actually gave a benefit
    // (#2299). The tiles below report every application, so the cap progress
    // has to be driven from here or a fruitlessly-applied code reads as over
    // its cap while still being usable.
    capUsage: { redemptions: number; uniqueMembers: number };
    caps: {
      maxRedemptionsTotal: number | null;
      maxUniqueMembersTotal: number | null;
      maxUsesPerMember: number | null;
      lifetimeFreeNightsCap: number | null;
    };
  };
  totals: { all: Totals; filtered: Totals };
  pagination: { page: number; pageSize: number; total: number };
  // Present only on an `?export=1` response (#2244). The server caps an export
  // at `limit` rows, so `truncated` says the rows below are only the newest
  // `limit` of `matchedRowCount` and the CSV built from them is partial.
  export: {
    truncated: boolean;
    limit: number;
    rowCount: number;
    matchedRowCount: number;
  } | null;
  rows: RedemptionRow[];
}

interface PromoSummary {
  id: string;
  code: string;
  description: string | null;
  type: string;
  archived: boolean;
}

// `value` is a yyyy-MM-dd lodge night from the API — a CALENDAR DATE, which
// takes no timezone at all (CT-4, #2870). The hand-rolled parts-to-UTC-midnight
// dance existed only to stop the INSTANT formatter shifting the day; the
// calendar-date formatter has no zone to shift by. A malformed value still
// renders as itself rather than throwing inside a table row.
function formatStayDate(value: string): string {
  const day = parseCalendarDate(value);
  return day ? formatClubDate(day) : value;
}

// The truncation notice asks an operator to compare two five-figure counts, so
// they are grouped the way the rest of the site groups numbers (and the way the
// operator guide states the cap): "10,000 of 12,345", not "10000 of 12345".
function formatCount(value: number): string {
  return value.toLocaleString(APP_LOCALE);
}

// A downloaded file outlives the on-screen notice, so a capped export (#2244)
// says so in its own name. The suffix is the only truncation marker outside the
// UI: the CSV body stays a plain row set, since a trailing "truncated" line
// would corrupt every spreadsheet and parser that reads it.
// The club's PERSISTED day, not the build's `NEXT_PUBLIC_TZ`. Two admins never
// disagreed about this filename — that constant is fixed at build time, so they
// already shared an answer. The defect was that the shared answer could be the
// wrong day for the club, and is `Pacific/Auckland` for everyone on a deployment
// that sets only `TZ` (CT-4, #2870).
function csvFilename(
  clubTime: BoundClubTime,
  code: string,
  truncated: boolean,
): string {
  const dateStr = clubTime.today();
  return `promo-${code}-redemptions-${dateStr}${truncated ? "-partial" : ""}.csv`;
}

function StatTile({
  title,
  value,
  subtitle,
  progress,
}: {
  title: string;
  value: string;
  subtitle?: string;
  progress?: { current: number; cap: number } | null;
}) {
  const pct =
    progress && progress.cap > 0
      ? Math.min(100, Math.round((progress.current / progress.cap) * 100))
      : null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-foreground">{value}</div>
        {subtitle ? (
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
        {pct != null ? (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PromoRedemptionsPanel({
  promo,
  onBack,
}: {
  promo: PromoSummary;
  onBack: () => void;
}) {
  const clubTime = useClubTime();
  const { lodges } = useLodgeOptions("admin");
  const multiLodge = lodges.length > 1;

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lodgeId, setLodgeId] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RedemptionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  // Set when the last export came back capped (#2244): the downloaded CSV is
  // short, so it must never be read as a complete discount reconciliation.
  const [exportTruncation, setExportTruncation] = useState<{
    limit: number;
    rowCount: number;
    matchedRowCount: number;
  } | null>(null);

  const buildQuery = useCallback(
    (nextPage: number, nextPageSize: number) => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (lodgeId) params.set("lodgeId", lodgeId);
      params.set("page", String(nextPage));
      params.set("pageSize", String(nextPageSize));
      return params.toString();
    },
    [from, to, lodgeId]
  );

  const fetchRedemptions = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/promo-codes/${promo.id}/redemptions?${buildQuery(page, PAGE_SIZE)}`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load redemptions");
      }
      const json = (await res.json()) as RedemptionsResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load redemptions");
    } finally {
      setLoading(false);
    }
  }, [promo.id, buildQuery, page]);

  useEffect(() => {
    void fetchRedemptions();
  }, [fetchRedemptions]);

  // What EVERY change to the filtered set invalidates, whether it came from a
  // filter control or from Reset. Page 1 because the row set is different; the
  // truncation notice because it describes the file the PREVIOUS filter
  // produced, and left up it would quote a matched count for a set that is no
  // longer on screen (#2244). Open rows are deliberately NOT included — Reset
  // keeps them, and that distinction is pinned by
  // `promo-redemptions-reset.test.tsx`.
  function resetDatasetView() {
    setPage(1);
    setExportTruncation(null);
  }

  // A filter control additionally collapses open rows, since the expanded
  // splits belong to rows the new filter may not return.
  function applyFilterChange(mutator: () => void) {
    mutator();
    resetDatasetView();
    setExpanded(new Set());
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totals = data?.totals;
  const caps = data?.code.caps;
  // Cap progress counts BENEFICIARIES — members whose price actually changed,
  // one per member per booking (#2299) — and is always all-time. It lives on
  // its own tiles, never as the subtitle of an application count.
  const capUsage = data?.code.capUsage;
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const resultStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const resultEnd = Math.min(page * PAGE_SIZE, total);

  const filterActive = Boolean(from || to || lodgeId);

  // The all-time application count stays visible whatever the filter or the
  // caps, because it is what an operator reconciles the cap tiles against; the
  // benefit-free count is appended so a fruitlessly-applied code is legible
  // here and not only on the promo-codes list card.
  const benefitFreeAllTime = totals?.all.benefitFreeRedemptions ?? 0;
  const applicationsSubtitle = [
    filterActive || benefitFreeAllTime > 0
      ? `${totals?.all.redemptions ?? 0} all-time`
      : "One per booking",
    benefitFreeAllTime > 0
      ? `${benefitFreeAllTime} gave no benefit (no allowance used)`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  async function exportCSV() {
    setExporting(true);
    setError("");
    setExportTruncation(null);
    try {
      // A single server-side export request returns the full filtered row set
      // (bounded server-side) and writes the privacy audit entry — no client
      // page-walk, so the O(N²/page) memberUseIndex rescan is avoided.
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (lodgeId) params.set("lodgeId", lodgeId);
      params.set("export", "1");
      const res = await fetch(
        `/api/admin/promo-codes/${promo.id}/redemptions?${params.toString()}`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to export redemptions");
      }
      const json = (await res.json()) as RedemptionsResponse;

      // The server caps an export at `export.limit` rows (#2244). The file is
      // still downloaded — a partial export is more useful than none — but the
      // shortfall is surfaced on screen and stamped into the filename, because
      // the CSV body stays exactly the machine-parseable row set it claims to
      // be and cannot carry the warning itself.
      const truncation = json.export?.truncated ? json.export : null;
      if (truncation) {
        setExportTruncation({
          limit: truncation.limit,
          rowCount: truncation.rowCount,
          matchedRowCount: truncation.matchedRowCount,
        });
      }

      // The "Redeemed" column is a real instant, so the club's persisted zone
      // decides its day (#3123) — the same binding the filename below uses.
      const csvContent = buildPromoRedemptionsCsvContent(
        clubTime,
        promo.code,
        json.rows,
      );

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = csvFilename(clubTime, promo.code, truncation != null);
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export redemptions");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <button
            onClick={onBack}
            className="mb-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className="h-4 w-4 rotate-180" />
            Back to promo codes
          </button>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl font-bold">{promo.code}</h1>
            <Badge variant="outline">{TYPE_LABELS[promo.type] ?? promo.type}</Badge>
            {promo.archived ? (
              <Badge
                variant="outline"
                className="border-warning-7 text-warning-11"
              >
                Archived
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Redemptions{promo.description ? ` · ${promo.description}` : ""}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={exportCSV}
          disabled={exporting || total === 0}
        >
          <Download className="mr-1 h-4 w-4" />
          {exporting ? "Exporting..." : "CSV"}
        </Button>
      </div>

      {error ? (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-destructive">
          {error}
        </div>
      ) : null}

      {/*
        A capped export (#2244) is stated in the reading order, not left for the
        operator to notice by counting rows. The `role="status"` wrapper is
        mounted unconditionally and only its CONTENT is gated — the house rule
        (PolicyFeedback, AdminViewOnlySectionBanner): a polite live region
        injected already-populated is silently dropped by some
        screen-reader/browser pairings, so the region has to be registered
        before the message lands in it.
      */}
      <div role="status">
        {exportTruncation ? (
          <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
            <p className="font-medium">
              Incomplete export: {formatCount(exportTruncation.rowCount)} of{" "}
              {formatCount(exportTruncation.matchedRowCount)} matching
              redemptions
            </p>
            <p className="mt-1">
              A single export is capped at {formatCount(exportTruncation.limit)}{" "}
              rows, so the downloaded file holds only the{" "}
              {formatCount(exportTruncation.rowCount)} most recent. Do not
              reconcile discounts from it as though it were complete — narrow
              the redeemed-date range (or the lodge) and export each window
              separately to cover every row.
            </p>
          </div>
        ) : null}
      </div>

      {/*
        Every tile shows ONE population, and says which (#2299).

        The first four count APPLICATIONS of the code (PromoRedemption rows) and
        follow the active filter. The last two are the CAP tiles: they count
        BENEFICIARIES — members whose price actually changed, one per member per
        booking — are always all-time, and are the only tiles carrying a
        progress bar, because those are the numbers the caps are enforced
        against. Mixing the two in one tile is what made "2" sit above "6 of 20"
        and read as impossible.
      */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          title="Applications"
          value={String(totals?.filtered.redemptions ?? 0)}
          subtitle={applicationsSubtitle}
        />
        <StatTile
          title="Members who applied it"
          value={String(totals?.filtered.uniqueMembers ?? 0)}
          subtitle={
            filterActive
              ? `${totals?.all.uniqueMembers ?? 0} all-time · bookers, not beneficiaries`
              : "Bookers, not beneficiaries"
          }
        />
        <StatTile
          title="Total discounted"
          value={formatCents(totals?.filtered.discountCents ?? 0)}
          subtitle={
            filterActive
              ? `${formatCents(totals?.all.discountCents ?? 0)} all-time`
              : "Sum of discounts applied"
          }
        />
        <StatTile
          title="Free nights used"
          value={String(totals?.filtered.freeNightsUsed ?? 0)}
          subtitle={
            caps?.lifetimeFreeNightsCap != null
              ? filterActive
                ? `${totals?.all.freeNightsUsed ?? 0} all-time · per-member lifetime cap: ${caps.lifetimeFreeNightsCap}`
                : `Per-member lifetime cap: ${caps.lifetimeFreeNightsCap}`
              : filterActive
                ? `${totals?.all.freeNightsUsed ?? 0} all-time`
                : "Guest-nights subsidised"
          }
        />
        <StatTile
          title="Benefits given"
          value={String(capUsage?.redemptions ?? 0)}
          subtitle={
            caps?.maxRedemptionsTotal != null
              ? `All-time, against a cap of ${caps.maxRedemptionsTotal} · one per member, per booking`
              : "All-time · one per member, per booking · no total cap"
          }
          progress={
            caps?.maxRedemptionsTotal != null
              ? {
                  current: capUsage?.redemptions ?? 0,
                  cap: caps.maxRedemptionsTotal,
                }
              : null
          }
        />
        <StatTile
          title="Members who benefited"
          value={String(capUsage?.uniqueMembers ?? 0)}
          subtitle={
            caps?.maxUniqueMembersTotal != null
              ? `All-time distinct beneficiaries, against a cap of ${caps.maxUniqueMembersTotal}`
              : "All-time distinct beneficiaries · no unique-member cap"
          }
          progress={
            caps?.maxUniqueMembersTotal != null
              ? {
                  current: capUsage?.uniqueMembers ?? 0,
                  cap: caps.maxUniqueMembersTotal,
                }
              : null
          }
        />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <DateRangeControls
            presets={auditAndPaymentsDateRangePresets}
            from={from}
            to={to}
            onFromChange={(value) => applyFilterChange(() => setFrom(value))}
            onToChange={(value) => applyFilterChange(() => setTo(value))}
            fromLabel="Redeemed from"
            toLabel="Redeemed to"
            idPrefix="promo-redemptions"
          />
          {multiLodge ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Lodge
              </label>
              <select
                value={lodgeId}
                onChange={(event) =>
                  applyFilterChange(() => setLodgeId(event.target.value))
                }
                className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
              >
                <option value="">All lodges</option>
                {lodges.map((lodge) => (
                  <option key={lodge.id} value={lodge.id}>
                    {lodge.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {/*
            Reset changes the filtered set, so it goes through
            `resetDatasetView` rather than clearing the fields and page by hand:
            clearing them alone left the truncation notice up, still quoting the
            matched count of the filter just cleared (#2244). It stops short of
            `applyFilterChange` on purpose — Reset keeps open rows expanded,
            pinned by `promo-redemptions-reset.test.tsx`.
          */}
          <DatasetResetButton
            disabled={!filterActive && page === 1}
            onReset={() => {
              setFrom("");
              setTo("");
              setLodgeId("");
              resetDatasetView();
            }}
          />
        </CardContent>
      </Card>

      {loading ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Loading redemptions...
          </CardContent>
        </Card>
      ) : total === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No redemptions{filterActive ? " match the current filters" : " yet"}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Showing {resultStart}-{resultEnd} of {total}
          </p>
          <AdminDataTable>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Redeemed</TableHead>
                <TableHead>Member</TableHead>
                <TableHead>Booking</TableHead>
                <TableHead>Lodge</TableHead>
                <TableHead>Stay</TableHead>
                <TableHead>Guests</TableHead>
                <TableHead>Discount</TableHead>
                <TableHead>Free nights</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.rows ?? []).map((row) => {
                const canExpand = row.allocations.length > 1;
                const isOpen = expanded.has(row.id);
                return (
                  <Fragment key={row.id}>
                    <TableRow>
                      <TableCell>
                        {canExpand ? (
                          <button
                            onClick={() => toggleExpanded(row.id)}
                            aria-label={
                              isOpen ? "Hide member split" : "Show member split"
                            }
                            aria-expanded={isOpen}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        {redeemedAtLabel(clubTime, row.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/admin/members/${row.member.id}`}
                          className="hover:underline"
                        >
                          <div className="font-medium text-primary">
                            {row.member.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {row.member.email}
                          </div>
                        </Link>
                        {row.memberUseIndex > 1 ? (
                          <Badge variant="secondary" className="mt-1 text-xs">
                            Use #{row.memberUseIndex}
                          </Badge>
                        ) : null}
                        {/* The only reliable marker of a benefit-free
                            application: a $0.00 discount alone is not one
                            (#2299). */}
                        {!row.gaveBenefit ? (
                          <Badge variant="outline" className="mt-1 text-xs">
                            No benefit
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/admin/bookings/${row.booking.id}`}
                          className="font-mono text-sm text-primary hover:underline"
                        >
                          {row.booking.reference}
                        </Link>
                      </TableCell>
                      <TableCell>{row.booking.lodgeName}</TableCell>
                      <TableCell>
                        <div>{formatStayDate(row.booking.checkIn)}</div>
                        <div className="text-xs text-muted-foreground">
                          to {formatStayDate(row.booking.checkOut)} ·{" "}
                          {row.booking.nights} night
                          {row.booking.nights === 1 ? "" : "s"}
                        </div>
                      </TableCell>
                      <TableCell>{row.eligibleGuestCount ?? "-"}</TableCell>
                      <TableCell>
                        {formatCents(row.discountCents)}
                        {/* A fixed nightly price ABOVE the guest's normal rate
                            raises the price: a real use with no discount, so
                            it must not be mistaken for a benefit-free row. */}
                        {row.priceAdjustmentCents > 0 ? (
                          <div className="text-xs text-muted-foreground">
                            +{formatCents(row.priceAdjustmentCents)} price
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>{row.freeNightsUsed}</TableCell>
                    </TableRow>
                    {canExpand && isOpen ? (
                      <TableRow>
                        <TableCell />
                        <TableCell colSpan={8} className="bg-muted">
                          <div className="space-y-2 py-1">
                            <p className="text-xs font-medium text-muted-foreground">
                              Per-member split ({row.allocations.length} members)
                            </p>
                            <div className="space-y-1">
                              {row.allocations.map((allocation) => (
                                <div
                                  key={allocation.memberId}
                                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                                >
                                  <span className="font-medium">
                                    {allocation.name}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {formatCents(allocation.discountCents)}
                                    {allocation.freeNightsUsed > 0
                                      ? ` · ${allocation.freeNightsUsed} free night${
                                          allocation.freeNightsUsed === 1 ? "" : "s"
                                        }`
                                      : ""}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </AdminDataTable>

          {totalPages > 1 ? (
            <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => {
                    setExpanded(new Set());
                    setPage((current) => Math.max(1, current - 1));
                  }}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => {
                    setExpanded(new Set());
                    setPage((current) => Math.min(totalPages, current + 1));
                  }}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
