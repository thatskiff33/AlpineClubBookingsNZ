"use client";

import type { AgeTier } from "@prisma/client";
import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { formatClubLongWeekdayDate, parseCalendarDate } from "@/lib/club-time";
import {
  computeFrequencyInfo,
  type FrequencyInfo,
} from "@/lib/chore-frequency-preview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Guest {
  id: string;
  bookingId: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isArriving: boolean;
  isDeparting: boolean;
}

interface BookingGroup {
  bookingId: string;
  memberName: string;
  guests: Guest[];
}

interface ChoreTemplate {
  id: string;
  name: string;
  description: string | null;
  timeOfDay: string;
  sortOrder: number;
  isEssential: boolean;
  frequencyMode: string;
  frequencyDays: number | null;
  frequencyDaysOfWeek: number[];
  recommendedPeopleMin: number;
  recommendedPeopleMax: number;
  ageRestriction: string;
  minAge: number;
}

interface Allocation {
  choreTemplateId: string;
  choreTemplateName: string;
  choreTimeOfDay: string;
  choreSortOrder: number;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: AgeTier | null;
  bookingId: string;
}

const MAX_AGE_BY_TIER: Partial<Record<AgeTier, number>> = {
  INFANT: 4,
  CHILD: 9,
  YOUTH: 17,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The roster header names the DAY OF THE WEEK in full ("Wednesday, 15 April
// 2026") because that is what a hut leader scans for. A CALENDAR DAY, SO NO
// TIMEZONE AT ALL (CT-4, #2870): the kernel's `longWeekdayDate` shape is that
// exact bag, pinned to `UTC` over the UTC-midnight encoding, which is provably
// the identity for every club.

function displayDate(dateStr: string): string {
  // `parseCalendarDate`, not `requireCalendarDate`: this comes off the URL
  // segment, so a hand-typed `/lodge/roster/banana/setup` would otherwise throw
  // and blank the page. The fallback is NEW rather than preserved — the previous
  // `new Date(dateStr + "T00:00:00Z")` produced an invalid Date and `Intl` threw
  // `Invalid time value` out of the render.
  const date = parseCalendarDate(dateStr);
  return date === null ? dateStr : formatClubLongWeekdayDate(date);
}

// `computeFrequencyInfo` — the "is this chore due tonight?" preview — lives in
// `@/lib/chore-frequency-preview` so it can be unit-tested against the server
// allocator's rules (#2478); a helper defined inside a page component cannot be.

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RosterSetupWizard() {
  const params = useParams();
  const router = useRouter();
  const dateStr = params.date as string;

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Step 1 data
  const [bookings, setBookings] = useState<BookingGroup[]>([]);

  // Step 2 data
  const [templates, setTemplates] = useState<ChoreTemplate[]>([]);
  const [selectedChoreIds, setSelectedChoreIds] = useState<Set<string>>(
    new Set()
  );
  const [frequencyInfoMap, setFrequencyInfoMap] = useState<
    Map<string, FrequencyInfo>
  >(new Map());

  // Step 3 data
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [allGuests, setAllGuests] = useState<Guest[]>([]);
  const [generating, setGenerating] = useState(false);

  // Existing roster check
  const [hasExistingRoster, setHasExistingRoster] = useState(false);

  // ---------------------------------------------------------------------------
  // Fetch initial data
  // ---------------------------------------------------------------------------

  const fetchData = useCallback(async () => {
    try {
      const [guestsRes, rosterRes, templatesRes] = await Promise.all([
        // #2631: the guests route has ONE scope now — the operational day —
        // so this wizard, the kiosk and the generate route all read the same
        // list. Step 1 shows everyone who is in the lodge on this date,
        // including the people who leave this morning, which is exactly who
        // the generate step will roster; its "Departing" badge means "leaves
        // today", the same as the kiosk's. (It used to ask for a separate
        // checkout-inclusive scope by query parameter, and before that it read
        // the night model, which counted nobody on an all-departing morning and
        // dead-ended the wizard on the day the shutdown chores matter most.)
        fetch(`/api/lodge/guests/${dateStr}`),
        fetch(`/api/lodge/roster/${dateStr}`),
        fetch(`/api/lodge/roster/${dateStr}/chores`),
      ]);

      if (!guestsRes.ok || !rosterRes.ok || !templatesRes.ok) {
        throw new Error("Failed to load data");
      }

      const gData = await guestsRes.json();
      setBookings(gData.bookings);

      const rData = await rosterRes.json();
      const confirmed = rData.assignments.some(
        (a: { status: string }) =>
          a.status === "CONFIRMED" || a.status === "COMPLETED"
      );
      setHasExistingRoster(confirmed);

      const tData = await templatesRes.json();
      const activeTemplates = (tData.templates ?? tData).filter(
        (t: ChoreTemplate & { active?: boolean }) => t.active !== false
      );
      setTemplates(activeTemplates);

      // Fetch last rostered dates for frequency info
      const lastRosteredRes = await fetch(
        `/api/lodge/roster/${dateStr}/frequency-info`
      );
      let lrDates: Record<string, string> = {};
      if (lastRosteredRes.ok) {
        const lrData = await lastRosteredRes.json();
        lrDates = lrData.lastRosteredDates ?? {};
      }
      // Compute frequency info and pre-select
      const freqMap = new Map<string, FrequencyInfo>();
      const preSelected = new Set<string>();
      for (const t of activeTemplates) {
        const info = computeFrequencyInfo(t, lrDates, dateStr);
        freqMap.set(t.id, info);
        if (!info.excluded) {
          preSelected.add(t.id);
        }
      }
      setFrequencyInfoMap(freqMap);
      setSelectedChoreIds(preSelected);

      setError(null);
    } catch {
      setError("Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [dateStr]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ---------------------------------------------------------------------------
  // Step 2: Toggle chore selection
  // ---------------------------------------------------------------------------

  const toggleChore = (choreId: string) => {
    setSelectedChoreIds((prev) => {
      const next = new Set(prev);
      if (next.has(choreId)) {
        next.delete(choreId);
      } else {
        next.add(choreId);
      }
      return next;
    });
  };

  // ---------------------------------------------------------------------------
  // Step 3: Generate roster
  // ---------------------------------------------------------------------------

  const generateRoster = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/lodge/roster/${dateStr}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          choreTemplateIds: Array.from(selectedChoreIds),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to generate roster");
        return;
      }

      const data = await res.json();
      setAllocations(data.allocations);
      setAllGuests(data.guests);
      setStep(3);
    } catch {
      setError("Failed to generate roster");
    } finally {
      setGenerating(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Step 3: Reassign guest
  // ---------------------------------------------------------------------------

  const reassignGuest = (
    allocationIndex: number,
    newGuestId: string
  ) => {
    const guest = allGuests.find((g) => g.id === newGuestId);
    if (!guest) return;
    setAllocations((prev) =>
      prev.map((a, i) =>
        i === allocationIndex
          ? {
              ...a,
              bookingGuestId: guest.id,
              guestName: `${guest.firstName} ${guest.lastName}`,
              guestAgeTier: guest.ageTier,
              bookingId: guest.bookingId,
            }
          : a
      )
    );
  };

  const removeAllocation = (allocationIndex: number) => {
    setAllocations((prev) => prev.filter((_, index) => index !== allocationIndex));
  };

  const isGuestEligible = (guest: typeof allGuests[0], ageRestriction: string, minAge: number | null) => {
    if (ageRestriction === "ADULTS_ONLY" && guest.ageTier !== "ADULT") return false;
    if (minAge !== null) {
      const tierMaxAge = MAX_AGE_BY_TIER[guest.ageTier];
      if (tierMaxAge !== undefined && minAge > tierMaxAge) return false;
    }
    return true;
  };

  const getEligibleGuests = (choreTemplateId: string) => {
    const template = templates.find((t) => t.id === choreTemplateId);
    return allGuests.filter((guest) =>
      isGuestEligible(
        guest,
        template?.ageRestriction ?? "NONE",
        template?.minAge ?? null
      )
    );
  };

  const addAllocation = (choreTemplateId: string) => {
    const template = templates.find((t) => t.id === choreTemplateId);
    if (!template) return;

    const eligibleGuests = getEligibleGuests(choreTemplateId);
    if (eligibleGuests.length === 0) return;

    const assignedGuestIds = new Set(
      allocations
        .filter((allocation) => allocation.choreTemplateId === choreTemplateId)
        .map((allocation) => allocation.bookingGuestId)
    );
    const guest =
      eligibleGuests.find((candidate) => !assignedGuestIds.has(candidate.id)) ??
      eligibleGuests[0];

    setAllocations((prev) => [
      ...prev,
      {
        choreTemplateId: template.id,
        choreTemplateName: template.name,
        choreTimeOfDay: template.timeOfDay,
        choreSortOrder: template.sortOrder,
        bookingGuestId: guest.id,
        guestName: `${guest.firstName} ${guest.lastName}`,
        guestAgeTier: guest.ageTier,
        bookingId: guest.bookingId,
      },
    ]);
  };

  // ---------------------------------------------------------------------------
  // Step 4: Confirm roster
  // ---------------------------------------------------------------------------

  const confirmRoster = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/lodge/roster/${dateStr}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allocations: allocations.map((a) => ({
            choreTemplateId: a.choreTemplateId,
            bookingGuestId: a.bookingGuestId,
            bookingId: a.bookingId,
          })),
          overwrite: hasExistingRoster,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to confirm roster");
        return;
      }

      router.push("/lodge/kiosk");
    } catch {
      setError("Failed to confirm roster");
    } finally {
      setSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Group helpers
  // ---------------------------------------------------------------------------

  const timeGroups = ["MORNING", "EVENING", "ANYTIME"] as const;
  const timeGroupLabel = (tod: string) =>
    tod === "MORNING" ? "Morning" : tod === "EVENING" ? "Evening" : "Anytime";

  const groupedTemplates = timeGroups.map((tod) => ({
    label: timeGroupLabel(tod),
    tod,
    templates: templates
      .filter((t) => t.timeOfDay === tod)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  }));

  const groupedAllocations = timeGroups.map((tod) => ({
    label: timeGroupLabel(tod),
    tod,
    allocations: allocations.filter((a) => a.choreTimeOfDay === tod),
  }));

  const totalGuests = bookings.reduce((sum, b) => sum + b.guests.length, 0);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="theme-aware-kiosk min-h-screen bg-kiosk-page text-kiosk-fg flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  return (
    <div className="theme-aware-kiosk min-h-screen bg-kiosk-page text-kiosk-fg p-4 select-none max-w-4xl mx-auto">
      {/* Header */}
      <header className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => router.push("/lodge/kiosk")}
            className="text-kiosk-muted-fg hover:text-kiosk-fg text-lg px-4 py-2 rounded-lg"
          >
            &larr; Back to Kiosk
          </button>
          <h1 className="text-xl font-bold">{displayDate(dateStr)}</h1>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 justify-center mt-4">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold ${
                  s === step
                    ? "bg-kiosk-accent text-kiosk-accent-fg"
                    : s < step
                      ? "bg-kiosk-success-solid text-kiosk-success-solid-fg"
                      : "bg-kiosk-inset text-kiosk-muted-fg"
                }`}
              >
                {s < step ? "\u2713" : s}
              </div>
              {s < 4 && (
                <div
                  className={`w-8 h-0.5 ${s < step ? "bg-kiosk-success-solid" : "bg-kiosk-inset"}`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="text-center mt-2 text-kiosk-muted-fg">
          {step === 1 && "Review Guests"}
          {step === 2 && "Select Chores"}
          {step === 3 && "Review Roster"}
          {step === 4 && "Confirm"}
        </div>
      </header>

      {error && (
        <div className="bg-kiosk-danger-bg text-kiosk-danger-fg rounded-xl p-4 mb-4 text-lg">
          {error}
        </div>
      )}

      {hasExistingRoster && step === 1 && (
        <div className="bg-kiosk-warning-bg text-kiosk-warning-fg rounded-xl p-4 mb-4 text-lg">
          A confirmed roster already exists for this date. Completing this wizard
          will replace it.
        </div>
      )}

      {/* Step 1: Review Guests */}
      {step === 1 && (
        <div>
          {/* #2631: "in the lodge", not "staying". This list is the guests
              route's operational day, so it holds the people who leave this
              morning as well as the people sleeping here tonight — "staying"
              reads as the night model and made a changeover day look wrong.
              Unlike the printed sheet, this list DOES include a booking held by
              a pending admin review (#1422 flags rather than hides it), so
              "in the lodge" is the accurate phrase here. */}
          <h2 className="text-xl font-semibold mb-4">
            Guests in the lodge ({totalGuests})
          </h2>
          {bookings.length === 0 ? (
            <div className="bg-kiosk-card rounded-xl p-6 text-center text-kiosk-muted-fg text-lg">
              No guests in the lodge on this date
            </div>
          ) : (
            <div className="space-y-3">
              {bookings.map((booking) => (
                <div
                  key={booking.bookingId}
                  className="bg-kiosk-card rounded-xl p-4"
                >
                  <p className="text-sm text-kiosk-muted-fg mb-2">
                    Booked by {booking.memberName}
                  </p>
                  <div className="space-y-2">
                    {booking.guests.map((guest) => (
                      <div
                        key={guest.id}
                        className="flex items-center justify-between bg-kiosk-inset rounded-lg px-4 py-3 min-h-[48px]"
                      >
                        <span className="text-lg">
                          {guest.firstName} {guest.lastName}
                          <span className="text-sm text-kiosk-muted-fg ml-2">
                            {guest.ageTier}
                          </span>
                        </span>
                        <div className="flex gap-2">
                          {guest.isArriving && (
                            <span className="bg-kiosk-success-solid text-kiosk-success-solid-fg text-sm font-medium px-3 py-1 rounded-full">
                              Arriving
                            </span>
                          )}
                          {guest.isDeparting && (
                            <span className="bg-kiosk-warning-solid text-kiosk-warning-solid-fg text-sm font-medium px-3 py-1 rounded-full">
                              Departing
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 flex justify-end">
            <button
              onClick={() => setStep(2)}
              disabled={totalGuests === 0}
              className="bg-kiosk-accent hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active disabled:bg-kiosk-chip disabled:text-kiosk-faint-fg text-kiosk-accent-fg text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              Next: Select Chores
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Select Chores */}
      {step === 2 && (
        <div>
          <h2 className="text-xl font-semibold mb-4">
            Select Chores ({selectedChoreIds.size} selected)
          </h2>
          <div className="space-y-4">
            {groupedTemplates
              .filter((g) => g.templates.length > 0)
              .map((group) => (
                <div key={group.tod}>
                  <h3 className="text-base font-medium text-kiosk-muted-fg mb-2">
                    {group.label}
                  </h3>
                  <div className="space-y-2">
                    {group.templates.map((t) => {
                      const freqInfo = frequencyInfoMap.get(t.id);
                      const isSelected = selectedChoreIds.has(t.id);
                      return (
                        <button
                          key={t.id}
                          onClick={() => toggleChore(t.id)}
                          className={`w-full flex items-center gap-3 rounded-xl px-4 py-3 min-h-[56px] text-left transition-colors ${
                            isSelected
                              ? "bg-kiosk-accent-bg border border-kiosk-accent-border"
                              : freqInfo?.excluded
                                ? "bg-kiosk-card border border-kiosk-border"
                                : "bg-kiosk-card border border-kiosk-border hover:bg-kiosk-hover"
                          }`}
                        >
                          <div
                            className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center flex-shrink-0 ${
                              isSelected
                                ? "border-kiosk-accent bg-kiosk-accent"
                                : "border-kiosk-border"
                            }`}
                          >
                            {isSelected && (
                              <svg
                                className="w-5 h-5 text-kiosk-accent-fg"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M5 13l4 4L19 7"
                                />
                              </svg>
                            )}
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-lg font-medium">
                                {t.name}
                              </span>
                              {t.isEssential && (
                                <span className="bg-kiosk-warning-solid text-kiosk-warning-solid-fg text-xs font-medium px-2 py-0.5 rounded-full">
                                  Essential
                                </span>
                              )}
                            </div>
                            {freqInfo?.excluded && freqInfo.reason && (
                              <p className="text-sm text-kiosk-warning-fg mt-1">
                                {freqInfo.reason}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
          </div>

          <div className="mt-6 flex justify-between">
            <button
              onClick={() => setStep(1)}
              className="bg-kiosk-inset hover:bg-kiosk-hover text-kiosk-fg text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              Back
            </button>
            <button
              onClick={generateRoster}
              disabled={selectedChoreIds.size === 0 || generating}
              className="bg-kiosk-accent hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active disabled:bg-kiosk-chip disabled:text-kiosk-faint-fg text-kiosk-accent-fg text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              {generating ? "Generating..." : "Next: Generate Roster"}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Review Roster */}
      {step === 3 && (
        <div>
          <h2 className="text-xl font-semibold mb-4">
            Review Roster ({allocations.length} assignment
            {allocations.length !== 1 ? "s" : ""})
          </h2>

          <div className="space-y-4">
            {groupedTemplates
              .map((group) => ({
                ...group,
                templates: group.templates.filter((template) =>
                  selectedChoreIds.has(template.id)
                ),
              }))
              .filter((g) => g.templates.length > 0)
              .map((group) => (
                <div key={group.tod}>
                  <h3 className="text-base font-medium text-kiosk-muted-fg mb-2">
                    {group.label}
                  </h3>
                  <div className="space-y-2">
                    {group.templates.map((template) => {
                      const items = allocations
                        .map((allocation, index) => ({ allocation, globalIndex: index }))
                        .filter(
                          ({ allocation }) =>
                            allocation.choreTemplateId === template.id
                        );
                      const eligibleGuests = getEligibleGuests(template.id);

                      return (
                        <div
                          key={template.id}
                          className="bg-kiosk-card rounded-xl p-4"
                        >
                          <div className="flex items-center justify-between gap-3 mb-2">
                            <h4 className="font-semibold text-lg">
                              {template.name}
                            </h4>
                            <button
                              type="button"
                              onClick={() => addAllocation(template.id)}
                              disabled={eligibleGuests.length === 0}
                              className="bg-kiosk-inset hover:bg-kiosk-hover disabled:bg-kiosk-chip disabled:text-kiosk-faint-fg text-kiosk-fg text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                            >
                              + Add Person
                            </button>
                          </div>
                          <div className="space-y-2">
                            {items.length === 0 ? (
                              <div className="bg-kiosk-inset rounded-lg px-4 py-3 text-kiosk-muted-fg">
                                No one assigned yet. Add someone to keep this chore on the roster.
                              </div>
                            ) : (
                              items.map(({ allocation, globalIndex }) => (
                              <div
                                key={`${allocation.choreTemplateId}-${allocation.bookingGuestId}-${globalIndex}`}
                                className="flex items-center gap-3 bg-kiosk-inset rounded-lg px-4 py-3 min-h-[56px]"
                              >
                                <select
                                  value={allocation.bookingGuestId}
                                  onChange={(e) =>
                                    reassignGuest(globalIndex, e.target.value)
                                  }
                                  className="flex-1 bg-kiosk-chip text-kiosk-fg rounded-lg px-3 py-2 text-lg min-h-[44px]"
                                >
                                  {eligibleGuests.map((g) => (
                                    <option key={g.id} value={g.id}>
                                      {g.firstName} {g.lastName} ({g.ageTier})
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  onClick={() => removeAllocation(globalIndex)}
                                  className="bg-kiosk-inset hover:bg-kiosk-hover text-kiosk-fg text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                                >
                                  Remove
                                </button>
                              </div>
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
          </div>

          <div className="mt-6 flex justify-between gap-2 flex-wrap">
            <button
              onClick={() => setStep(2)}
              className="bg-kiosk-inset hover:bg-kiosk-hover text-kiosk-fg text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              Back
            </button>
            <div className="flex gap-2">
              <button
                onClick={generateRoster}
                disabled={generating}
                className="bg-kiosk-inset hover:bg-kiosk-hover text-kiosk-fg text-lg font-semibold px-6 py-4 rounded-xl min-h-[56px] transition-colors"
              >
                {generating ? "Regenerating..." : "Regenerate"}
              </button>
              <button
                onClick={() => setStep(4)}
                disabled={allocations.length === 0}
                className="bg-kiosk-accent hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active disabled:bg-kiosk-chip disabled:text-kiosk-faint-fg text-kiosk-accent-fg text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
              >
                Next: Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 4: Confirm */}
      {step === 4 && (
        <div>
          <h2 className="text-xl font-semibold mb-4">Confirm Roster</h2>

          <div className="bg-kiosk-card rounded-xl p-6 mb-6">
            <p className="text-lg text-kiosk-fg mb-4">
              You are about to confirm {allocations.length} chore assignment
              {allocations.length !== 1 ? "s" : ""} for{" "}
              {displayDate(dateStr)}.
            </p>

            {hasExistingRoster && (
              <p className="text-kiosk-warning-fg text-lg mb-4">
                This will replace the existing confirmed roster.
              </p>
            )}

            {/* Summary */}
            <div className="space-y-2">
              {groupedAllocations
                .filter((g) => g.allocations.length > 0)
                .map((group) => (
                  <div key={group.tod}>
                    <h3 className="text-base font-medium text-kiosk-muted-fg mb-1">
                      {group.label}
                    </h3>
                    {Object.values(
                      group.allocations.reduce(
                        (acc, a) => {
                          if (!acc[a.choreTemplateId]) {
                            acc[a.choreTemplateId] = {
                              name: a.choreTemplateName,
                              guests: [],
                            };
                          }
                          acc[a.choreTemplateId].guests.push(a.guestName);
                          return acc;
                        },
                        {} as Record<
                          string,
                          { name: string; guests: string[] }
                        >
                      )
                    ).map((chore) => (
                      <div
                        key={chore.name}
                        className="bg-kiosk-inset rounded-lg px-4 py-2 mb-1"
                      >
                        <span className="font-medium">{chore.name}</span>
                        <span className="text-kiosk-muted-fg ml-2">
                          {chore.guests.join(", ")}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          </div>

          <div className="flex justify-between">
            <button
              onClick={() => setStep(3)}
              className="bg-kiosk-inset hover:bg-kiosk-hover text-kiosk-fg text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              Back
            </button>
            <button
              onClick={confirmRoster}
              disabled={submitting}
              className="bg-kiosk-success-solid hover:bg-kiosk-success-solid-hover active:bg-kiosk-success-solid-active disabled:bg-kiosk-chip disabled:text-kiosk-faint-fg text-kiosk-success-solid-fg text-lg font-bold px-10 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              {submitting ? "Confirming..." : "Confirm Roster"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
