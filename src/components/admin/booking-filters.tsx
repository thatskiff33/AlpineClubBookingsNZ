"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useClubTime } from "@/components/club-time-provider";
import { calendarDateParts } from "@/lib/club-time";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import {
  AdminFilterBar,
  type AdminFilterChip,
} from "@/components/admin/admin-filter-bar";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { bookingFilterDateRangePresets } from "@/lib/date-range-presets";
import { bookingStatusLabel } from "@/lib/status-colors";

interface BookingFiltersProps {
  showBedAllocation?: boolean;
  // Active lodges for the lodge filter (multi-lodge phase 8). The control
  // only renders once a second lodge exists (ADR-002 presentation rule).
  lodgeOptions?: Array<{ id: string; name: string }>;
}

const KNOWN_BOOKING_FILTER_QUERY_KEYS = [
  "status",
  "lodgeId",
  "updatedFrom",
  "updatedTo",
  "checkInFrom",
  "checkInTo",
  "checkOutFrom",
  "checkOutTo",
  "from",
  "to",
  "search",
  "sort",
  "sortBy",
  "sortDir",
  "month",
  "deleted",
  "paymentSource",
  "xeroState",
  "bedState",
  "changeState",
  "additionalOwed",
  "page",
] as const;

const BOOKING_RESET_QUERY_KEYS = [
  ...KNOWN_BOOKING_FILTER_QUERY_KEYS.filter((key) => key !== "lodgeId"),
  "consentState",
  "upcoming",
] as const;

// Chip display labels — mirror the SelectItem copy for each filter so an active
// filter reads the same on its chip as in its control. Presentation only.
const DELETED_CHIP_LABELS: Record<string, string> = {
  include: "Include deleted",
  only: "Deleted only",
};
const PAYMENT_SOURCE_CHIP_LABELS: Record<string, string> = {
  STRIPE: "Stripe",
  INTERNET_BANKING: "Internet Banking",
  NONE: "No payment",
};
const XERO_STATE_CHIP_LABELS: Record<string, string> = {
  invoiceLinked: "Invoice linked",
  invoiceMissing: "Invoice missing",
  operationFailed: "Failed activity",
  operationPartial: "Partial activity",
  operationPending: "Pending activity",
};
const BED_STATE_CHIP_LABELS: Record<string, string> = {
  unallocated: "Unallocated",
  partial: "Partial",
  complete: "Complete",
  warning: "Warning",
};
const CHANGE_STATE_CHIP_LABELS: Record<string, string> = {
  requiresReview: "Requires review",
  pendingRequest: "Pending request",
  hasModification: "Has modification",
  creditGenerated: "Credit generated",
};

// A date range summarised for a chip: "from → to", or a single open bound.
function dateRangeChipValue(from: string, to: string): string {
  if (from && to) return `${from} → ${to}`;
  if (from) return `From ${from}`;
  return `Until ${to}`;
}

export function BookingFilters({
  showBedAllocation = true,
  lodgeOptions = [],
}: BookingFiltersProps) {
  const clubTime = useClubTime();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState(searchParams.get("status") || "all");
  const [updatedFrom, setUpdatedFrom] = useState(searchParams.get("updatedFrom") || "");
  const [updatedTo, setUpdatedTo] = useState(searchParams.get("updatedTo") || "");
  // Legacy `from` is a check-in lower bound server-side
  // (admin-bookings-service: `query.checkInFrom ?? query.from`), so it seeds
  // the Check In From control.
  const [checkInFrom, setCheckInFrom] = useState(searchParams.get("checkInFrom") || searchParams.get("from") || "");
  const [checkInTo, setCheckInTo] = useState(searchParams.get("checkInTo") || "");
  const [checkOutFrom, setCheckOutFrom] = useState(searchParams.get("checkOutFrom") || "");
  // Legacy `to` is a CHECK-OUT upper bound server-side, and the service
  // ignores it whenever an explicit checkInTo/checkOutTo param is present.
  // Mirror that precedence exactly so rewriting a legacy link into named
  // params keeps the same result set (#1720).
  const [checkOutTo, setCheckOutTo] = useState(() => {
    const explicitCheckOutTo = searchParams.get("checkOutTo");
    if (explicitCheckOutTo) return explicitCheckOutTo;
    if (searchParams.get("checkInTo")) return "";
    return searchParams.get("to") || "";
  });
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [month, setMonth] = useState(searchParams.get("month") || "all");
  const [deleted, setDeleted] = useState(searchParams.get("deleted") || "hide");
  const [paymentSource, setPaymentSource] = useState(searchParams.get("paymentSource") || "all");
  const [xeroState, setXeroState] = useState(searchParams.get("xeroState") || "all");
  const [bedState, setBedState] = useState(
    showBedAllocation ? searchParams.get("bedState") || "all" : "all"
  );
  const [changeState, setChangeState] = useState(searchParams.get("changeState") || "all");
  const [additionalOwed, setAdditionalOwed] = useState(searchParams.get("additionalOwed") || "all");
  const [lodgeId, setLodgeId] = useState(searchParams.get("lodgeId") || "all");
  const showLodgeFilter = lodgeOptions.length > 1;
  const bookingStatuses = ["PAYMENT_PENDING", "CONFIRMED", "PAID", "PENDING", "WAITLISTED", "WAITLIST_OFFERED", "CANCELLED", "BUMPED", "COMPLETED", "DRAFT"] as const;
  function statusFilterLabel(value: string) {
    if (value === "all") return "All";

    const statuses = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (statuses.length === 0) return "Custom status filter";
    return statuses.map((item) => bookingStatusLabel(item)).join(" + ");
  }

  const hasCustomStatusValue =
    status !== "all" &&
    !bookingStatuses.includes(status as (typeof bookingStatuses)[number]);

  // Generate month options: current year ±1. The CLUB's year (CT-4, #2870;
  // INV-CONFIG-002), not the browser's - `new Date().getFullYear()` reads the
  // admin's own clock, so for the hours either side of New Year an admin abroad
  // was offered a different three-year window from the one beside them, and the
  // months the server can actually filter on.
  const monthOptions: Array<{ value: string; label: string }> = [];
  const currentYear = calendarDateParts(clubTime.today()).year;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let y = currentYear - 1; y <= currentYear + 1; y++) {
    for (let m = 0; m < 12; m++) {
      const val = `${y}-${String(m + 1).padStart(2, "0")}`;
      monthOptions.push({ value: val, label: `${monthNames[m]} ${y}` });
    }
  }

  // Filters apply automatically (debounced so typing in search doesn't push a
  // navigation per keystroke) while keeping the URL-driven server model:
  // filtered views stay shareable links.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mount-time snapshot of the URL-seeded filter values (#1732). A legacy
  // bookmark like `?from=A&to=B&page=3` encodes the SAME result set the
  // canonical params do, so the one auto-apply push that renames legacy params
  // to their canonical form must keep the URL's `page`. Every real filter
  // change instead resets to page 1 (#1738).
  //
  // The snapshot alone is not enough: it never refreshes, so a
  // change-then-revert sequence (change a filter → paginate the NEW result set
  // → revert the filter back to the seeded values) would once again equal the
  // snapshot and re-attach a stale page onto a different result set. The
  // `filtersDivergedRef` latch closes that trap — once any filter has ever
  // differed from the mount snapshot, the run is never treated as a pure
  // rewrite again, even after reverting.
  const initialFilterSnapshotRef = useRef<string | null>(null);
  const filtersDivergedRef = useRef(false);
  useEffect(() => {
    // Sort (sortBy/sortDir/sort) is deliberately excluded: it is owned by the
    // server sort-header links, carried through this component verbatim, and
    // must not participate in the divergence/canonical comparison (#1738).
    const filterSnapshot = JSON.stringify([
      status, updatedFrom, updatedTo, checkInFrom, checkInTo, checkOutFrom,
      checkOutTo, search, month, deleted, paymentSource,
      xeroState, bedState, changeState, additionalOwed, lodgeId,
    ]);
    if (initialFilterSnapshotRef.current === null) {
      initialFilterSnapshotRef.current = filterSnapshot;
    }
    if (filterSnapshot !== initialFilterSnapshotRef.current) {
      filtersDivergedRef.current = true;
    }
    const isPureRewrite =
      filterSnapshot === initialFilterSnapshotRef.current &&
      !filtersDivergedRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      for (const key of KNOWN_BOOKING_FILTER_QUERY_KEYS) {
        params.delete(key);
      }
      if (status !== "all") params.set("status", status);
      if (updatedFrom) params.set("updatedFrom", updatedFrom);
      if (updatedTo) params.set("updatedTo", updatedTo);
      if (checkInFrom) params.set("checkInFrom", checkInFrom);
      if (checkInTo) params.set("checkInTo", checkInTo);
      if (checkOutFrom) params.set("checkOutFrom", checkOutFrom);
      if (checkOutTo) params.set("checkOutTo", checkOutTo);
      if (search) params.set("search", search);
      if (month !== "all") params.set("month", month);
      if (deleted !== "hide") params.set("deleted", deleted);
      if (paymentSource !== "all") params.set("paymentSource", paymentSource);
      if (xeroState !== "all") params.set("xeroState", xeroState);
      if (showBedAllocation && bedState !== "all") params.set("bedState", bedState);
      if (changeState !== "all") params.set("changeState", changeState);
      if (additionalOwed !== "all") params.set("additionalOwed", additionalOwed);
      if (showLodgeFilter && lodgeId !== "all") params.set("lodgeId", lodgeId);
      const next = params.toString();
      // Compare against the live URL so the initial render is a no-op. Sort and
      // page are excluded from BOTH sides: sort is owned by the server
      // sort-header links (whose per-column default direction this component
      // must not second-guess — member/status default to asc, so an explicit
      // sortDir=desc is a real choice), and page is decided by the
      // rewrite/reset logic below. Both are re-attached verbatim on any push.
      const current = new URLSearchParams(window.location.search);
      const livePage = current.get("page");
      const liveSort = {
        sort: current.get("sort"),
        sortBy: current.get("sortBy"),
        sortDir: current.get("sortDir"),
      };
      current.delete("page");
      current.delete("sort");
      current.delete("sortBy");
      current.delete("sortDir");
      if (next !== current.toString()) {
        // A pure legacy→canonical rewrite (e.g. a bookmarked
        // ?from=A&to=B&page=3) keeps the URL's `page` param — same result set,
        // same page; a real filter change drops it, resetting to page 1 (see
        // the snapshot/latch note above).
        if (isPureRewrite && livePage) params.set("page", livePage);
        // Carry the current sort verbatim so a desc-landing sort click is
        // never rewritten (e.g. member/status flipped back to asc) or stripped.
        if (liveSort.sort) params.set("sort", liveSort.sort);
        if (liveSort.sortBy) params.set("sortBy", liveSort.sortBy);
        if (liveSort.sortDir) params.set("sortDir", liveSort.sortDir);
        const target = params.toString();
        router.replace(target ? `/admin/bookings?${target}` : "/admin/bookings");
      }
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [status, updatedFrom, updatedTo, checkInFrom, checkInTo, checkOutFrom, checkOutTo, search, month, deleted, paymentSource, xeroState, bedState, changeState, additionalOwed, showBedAllocation, lodgeId, showLodgeFilter, router]);

  const requestedSortBy = searchParams.get("sortBy") ?? searchParams.get("sort");
  const requestedSortDir = searchParams.get("sortDir");
  const hasDefaultSort =
    (requestedSortBy === null || requestedSortBy === "lastUpdated") &&
    (requestedSortDir === null || requestedSortDir === "desc");
  const requestedPage = searchParams.get("page");
  const isDatasetDefault =
    status === "all" &&
    updatedFrom === "" &&
    updatedTo === "" &&
    checkInFrom === "" &&
    checkInTo === "" &&
    checkOutFrom === "" &&
    checkOutTo === "" &&
    search === "" &&
    month === "all" &&
    deleted === "hide" &&
    paymentSource === "all" &&
    xeroState === "all" &&
    (!showBedAllocation || bedState === "all") &&
    changeState === "all" &&
    additionalOwed === "all" &&
    (searchParams.get("consentState") === null || searchParams.get("consentState") === "all") &&
    searchParams.get("upcoming") === null &&
    hasDefaultSort &&
    (requestedPage === null || requestedPage === "1");

  function resetDataset() {
    setStatus("all");
    setUpdatedFrom("");
    setUpdatedTo("");
    setCheckInFrom("");
    setCheckInTo("");
    setCheckOutFrom("");
    setCheckOutTo("");
    setSearch("");
    setMonth("all");
    setDeleted("hide");
    setPaymentSource("all");
    setXeroState("all");
    setBedState("all");
    setChangeState("all");
    setAdditionalOwed("all");

    const params = new URLSearchParams(window.location.search);
    for (const key of BOOKING_RESET_QUERY_KEYS) params.delete(key);
    const target = params.toString();
    router.replace(target ? `/admin/bookings?${target}` : "/admin/bookings", {
      scroll: false,
    });
  }

  // Count of active filters that live under "More filters" (Status, Month,
  // Payment and Search stay in the always-visible primary row). Drives the
  // disclosure count badge and the mount-time auto-open. Presentation only —
  // derived from the same state that already builds the URL.
  const advancedActiveCount =
    (updatedFrom || updatedTo ? 1 : 0) +
    (checkInFrom || checkInTo ? 1 : 0) +
    (checkOutFrom || checkOutTo ? 1 : 0) +
    (deleted !== "hide" ? 1 : 0) +
    (xeroState !== "all" ? 1 : 0) +
    (showBedAllocation && bedState !== "all" ? 1 : 0) +
    (changeState !== "all" ? 1 : 0) +
    (additionalOwed !== "all" ? 1 : 0) +
    (showLodgeFilter && lodgeId !== "all" ? 1 : 0);

  // Active-filter chips. Each × resets the same state a control would, so the
  // debounced URL update is identical to clearing that control by hand. Search
  // is intentionally omitted (it stays in the primary row, showing its value).
  const chips: AdminFilterChip[] = [];
  if (status !== "all") {
    chips.push({
      key: "status",
      label: "Status",
      value: statusFilterLabel(status),
      onRemove: () => setStatus("all"),
    });
  }
  if (showLodgeFilter && lodgeId !== "all") {
    chips.push({
      key: "lodgeId",
      label: "Lodge",
      value: lodgeOptions.find((lodge) => lodge.id === lodgeId)?.name ?? lodgeId,
      onRemove: () => setLodgeId("all"),
    });
  }
  if (month !== "all") {
    chips.push({
      key: "month",
      label: "Month",
      value: monthOptions.find((opt) => opt.value === month)?.label ?? month,
      onRemove: () => setMonth("all"),
    });
  }
  if (deleted !== "hide") {
    chips.push({
      key: "deleted",
      label: "Deleted",
      value: DELETED_CHIP_LABELS[deleted] ?? deleted,
      onRemove: () => setDeleted("hide"),
    });
  }
  if (paymentSource !== "all") {
    chips.push({
      key: "paymentSource",
      label: "Payment",
      value: PAYMENT_SOURCE_CHIP_LABELS[paymentSource] ?? paymentSource,
      onRemove: () => setPaymentSource("all"),
    });
  }
  if (xeroState !== "all") {
    chips.push({
      key: "xeroState",
      label: "Xero",
      value: XERO_STATE_CHIP_LABELS[xeroState] ?? xeroState,
      onRemove: () => setXeroState("all"),
    });
  }
  if (showBedAllocation && bedState !== "all") {
    chips.push({
      key: "bedState",
      label: "Beds",
      value: BED_STATE_CHIP_LABELS[bedState] ?? bedState,
      onRemove: () => setBedState("all"),
    });
  }
  if (changeState !== "all") {
    chips.push({
      key: "changeState",
      label: "Changes",
      value: CHANGE_STATE_CHIP_LABELS[changeState] ?? changeState,
      onRemove: () => setChangeState("all"),
    });
  }
  if (additionalOwed !== "all") {
    chips.push({
      key: "additionalOwed",
      label: "Additional Payment",
      value: "Still owing",
      onRemove: () => setAdditionalOwed("all"),
    });
  }
  if (updatedFrom || updatedTo) {
    chips.push({
      key: "updated",
      label: "Updated",
      value: dateRangeChipValue(updatedFrom, updatedTo),
      onRemove: () => {
        setUpdatedFrom("");
        setUpdatedTo("");
      },
    });
  }
  if (checkInFrom || checkInTo) {
    chips.push({
      key: "checkIn",
      label: "Check In",
      value: dateRangeChipValue(checkInFrom, checkInTo),
      onRemove: () => {
        setCheckInFrom("");
        setCheckInTo("");
      },
    });
  }
  if (checkOutFrom || checkOutTo) {
    chips.push({
      key: "checkOut",
      label: "Check Out",
      value: dateRangeChipValue(checkOutFrom, checkOutTo),
      onRemove: () => {
        setCheckOutFrom("");
        setCheckOutTo("");
      },
    });
  }

  return (
    <AdminFilterBar
      idPrefix="bookings-filters"
      advancedActiveCount={advancedActiveCount}
      chips={chips}
      search={
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Search member</label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or email..."
          />
        </div>
      }
      primary={
        <>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {hasCustomStatusValue ? (
                  <SelectItem value={status}>{statusFilterLabel(status)}</SelectItem>
                ) : null}
                {bookingStatuses.map((bookingStatus) => (
                  <SelectItem key={bookingStatus} value={bookingStatus}>
                    {bookingStatusLabel(bookingStatus)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Month</label>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All months</SelectItem>
                {monthOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Payment</label>
            <Select value={paymentSource} onValueChange={setPaymentSource}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All payments</SelectItem>
                <SelectItem value="STRIPE">Stripe</SelectItem>
                <SelectItem value="INTERNET_BANKING">Internet Banking</SelectItem>
                <SelectItem value="NONE">No payment</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      }
      actions={
        <DatasetResetButton disabled={isDatasetDefault} onReset={resetDataset} />
      }
      advanced={
        <>
          {showLodgeFilter && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Lodge</label>
              <select
                value={lodgeId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLodgeId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">All lodges</option>
                {lodgeOptions.map((lodge) => (
                  <option key={lodge.id} value={lodge.id}>{lodge.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Deleted</label>
            <Select value={deleted} onValueChange={setDeleted}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hide">Hide deleted</SelectItem>
                <SelectItem value="include">Include deleted</SelectItem>
                <SelectItem value="only">Deleted only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Xero</label>
            <Select value={xeroState} onValueChange={setXeroState}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Xero states</SelectItem>
                <SelectItem value="invoiceLinked">Invoice linked</SelectItem>
                <SelectItem value="invoiceMissing">Invoice missing</SelectItem>
                <SelectItem value="operationFailed">Failed activity</SelectItem>
                <SelectItem value="operationPartial">Partial activity</SelectItem>
                <SelectItem value="operationPending">Pending activity</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {showBedAllocation ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Beds</label>
              <Select value={bedState} onValueChange={setBedState}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All bed states</SelectItem>
                  <SelectItem value="unallocated">Unallocated</SelectItem>
                  <SelectItem value="partial">Partial</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Changes</label>
            <Select value={changeState} onValueChange={setChangeState}>
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All change states</SelectItem>
                <SelectItem value="requiresReview">Requires review</SelectItem>
                <SelectItem value="pendingRequest">Pending request</SelectItem>
                <SelectItem value="hasModification">Has modification</SelectItem>
                <SelectItem value="creditGenerated">Credit generated</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Additional Payment
            </label>
            <Select value={additionalOwed} onValueChange={setAdditionalOwed}>
              <SelectTrigger className="w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="owed">Still owing</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DateRangeControls
            presets={bookingFilterDateRangePresets}
            from={updatedFrom}
            to={updatedTo}
            presetLabel="Updated Range"
            fromLabel="Updated From"
            toLabel="Updated To"
            idPrefix="bookings-updated"
            onFromChange={setUpdatedFrom}
            onToChange={setUpdatedTo}
          />
          <DateRangeControls
            presets={bookingFilterDateRangePresets}
            from={checkInFrom}
            to={checkInTo}
            presetLabel="Check In Range"
            fromLabel="Check In From"
            toLabel="Check In To"
            idPrefix="bookings-check-in"
            onFromChange={setCheckInFrom}
            onToChange={setCheckInTo}
          />
          <DateRangeControls
            presets={bookingFilterDateRangePresets}
            from={checkOutFrom}
            to={checkOutTo}
            presetLabel="Check Out Range"
            fromLabel="Check Out From"
            toLabel="Check Out To"
            idPrefix="bookings-check-out"
            onFromChange={setCheckOutFrom}
            onToChange={setCheckOutTo}
          />
        </>
      }
    />
  );
}
