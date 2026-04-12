"use client";

import type { AgeTier } from "@prisma/client";
import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";

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

interface FrequencyInfo {
  choreId: string;
  excluded: boolean;
  reason: string | null;
}

const MAX_AGE_BY_TIER: Partial<Record<AgeTier, number>> = {
  INFANT: 4,
  CHILD: 9,
  YOUTH: 17,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function displayDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function computeFrequencyInfo(
  chore: ChoreTemplate,
  lastRosteredDates: Record<string, string>,
  dateStr: string
): FrequencyInfo {
  const mode = chore.frequencyMode ?? "DAILY";
  if (mode === "DAILY") {
    return { choreId: chore.id, excluded: false, reason: null };
  }

  if (mode === "EVERY_X_DAYS") {
    const interval = chore.frequencyDays;
    if (!interval || interval < 2)
      return { choreId: chore.id, excluded: false, reason: null };
    const lastDateStr = lastRosteredDates[chore.id];
    if (!lastDateStr)
      return { choreId: chore.id, excluded: false, reason: null };
    const lastDate = new Date(lastDateStr + "T00:00:00");
    const currentDate = new Date(dateStr + "T00:00:00");
    const daysSince = Math.floor(
      (currentDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysSince < interval) {
      return {
        choreId: chore.id,
        excluded: true,
        reason: `Last done ${daysSince} day${daysSince !== 1 ? "s" : ""} ago, next due in ${interval - daysSince} day${interval - daysSince !== 1 ? "s" : ""}`,
      };
    }
    return { choreId: chore.id, excluded: false, reason: null };
  }

  if (mode === "SPECIFIC_DAYS") {
    const days = chore.frequencyDaysOfWeek;
    if (!days || days.length === 0)
      return { choreId: chore.id, excluded: false, reason: null };
    const currentDate = new Date(dateStr + "T00:00:00");
    const dow = currentDate.getDay() === 0 ? 7 : currentDate.getDay();
    if (!days.includes(dow)) {
      const dayNames = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const scheduled = days.map((d) => dayNames[d]).join(", ");
      return {
        choreId: chore.id,
        excluded: true,
        reason: `Scheduled for ${scheduled} only`,
      };
    }
    return { choreId: chore.id, excluded: false, reason: null };
  }

  return { choreId: chore.id, excluded: false, reason: null };
}

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
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 select-none max-w-4xl mx-auto">
      {/* Header */}
      <header className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => router.push("/lodge/kiosk")}
            className="text-slate-400 hover:text-white text-lg px-4 py-2 rounded-lg"
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
                    ? "bg-blue-600 text-white"
                    : s < step
                      ? "bg-green-600 text-white"
                      : "bg-slate-700 text-slate-400"
                }`}
              >
                {s < step ? "\u2713" : s}
              </div>
              {s < 4 && (
                <div
                  className={`w-8 h-0.5 ${s < step ? "bg-green-600" : "bg-slate-700"}`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="text-center mt-2 text-slate-400">
          {step === 1 && "Review Guests"}
          {step === 2 && "Select Chores"}
          {step === 3 && "Review Roster"}
          {step === 4 && "Confirm"}
        </div>
      </header>

      {error && (
        <div className="bg-red-900/50 text-red-200 rounded-xl p-4 mb-4 text-lg">
          {error}
        </div>
      )}

      {hasExistingRoster && step === 1 && (
        <div className="bg-amber-900/50 text-amber-200 rounded-xl p-4 mb-4 text-lg">
          A confirmed roster already exists for this date. Completing this wizard
          will replace it.
        </div>
      )}

      {/* Step 1: Review Guests */}
      {step === 1 && (
        <div>
          <h2 className="text-xl font-semibold mb-4">
            Guests Staying ({totalGuests})
          </h2>
          {bookings.length === 0 ? (
            <div className="bg-slate-800 rounded-xl p-6 text-center text-slate-400 text-lg">
              No guests staying on this date
            </div>
          ) : (
            <div className="space-y-3">
              {bookings.map((booking) => (
                <div
                  key={booking.bookingId}
                  className="bg-slate-800 rounded-xl p-4"
                >
                  <p className="text-sm text-slate-400 mb-2">
                    Booked by {booking.memberName}
                  </p>
                  <div className="space-y-2">
                    {booking.guests.map((guest) => (
                      <div
                        key={guest.id}
                        className="flex items-center justify-between bg-slate-700/50 rounded-lg px-4 py-3 min-h-[48px]"
                      >
                        <span className="text-lg">
                          {guest.firstName} {guest.lastName}
                          <span className="text-sm text-slate-400 ml-2">
                            {guest.ageTier}
                          </span>
                        </span>
                        <div className="flex gap-2">
                          {guest.isArriving && (
                            <span className="bg-green-700 text-green-100 text-sm font-medium px-3 py-1 rounded-full">
                              Arriving
                            </span>
                          )}
                          {guest.isDeparting && (
                            <span className="bg-amber-700 text-amber-100 text-sm font-medium px-3 py-1 rounded-full">
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
              className="bg-blue-600 hover:bg-blue-500 active:bg-blue-400 disabled:bg-slate-700 disabled:text-slate-500 text-white text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
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
                  <h3 className="text-base font-medium text-slate-400 mb-2">
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
                              ? "bg-blue-800/40 border border-blue-600/50"
                              : freqInfo?.excluded
                                ? "bg-slate-800/50 border border-slate-700/50"
                                : "bg-slate-800 border border-slate-700/50 hover:bg-slate-700"
                          }`}
                        >
                          <div
                            className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center flex-shrink-0 ${
                              isSelected
                                ? "border-blue-400 bg-blue-600"
                                : "border-slate-500"
                            }`}
                          >
                            {isSelected && (
                              <svg
                                className="w-5 h-5 text-white"
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
                                <span className="bg-yellow-700 text-yellow-100 text-xs font-medium px-2 py-0.5 rounded-full">
                                  Essential
                                </span>
                              )}
                            </div>
                            {freqInfo?.excluded && freqInfo.reason && (
                              <p className="text-sm text-amber-400 mt-1">
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
              className="bg-slate-700 hover:bg-slate-600 text-white text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              Back
            </button>
            <button
              onClick={generateRoster}
              disabled={selectedChoreIds.size === 0 || generating}
              className="bg-blue-600 hover:bg-blue-500 active:bg-blue-400 disabled:bg-slate-700 disabled:text-slate-500 text-white text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
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
                  <h3 className="text-base font-medium text-slate-400 mb-2">
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
                          className="bg-slate-800 rounded-xl p-4"
                        >
                          <div className="flex items-center justify-between gap-3 mb-2">
                            <h4 className="font-semibold text-lg">
                              {template.name}
                            </h4>
                            <button
                              type="button"
                              onClick={() => addAllocation(template.id)}
                              disabled={eligibleGuests.length === 0}
                              className="bg-slate-700 hover:bg-slate-600 disabled:bg-slate-700/50 disabled:text-slate-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                            >
                              + Add Person
                            </button>
                          </div>
                          <div className="space-y-2">
                            {items.length === 0 ? (
                              <div className="bg-slate-700/30 rounded-lg px-4 py-3 text-slate-400">
                                No one assigned yet. Add someone to keep this chore on the roster.
                              </div>
                            ) : (
                              items.map(({ allocation, globalIndex }) => (
                              <div
                                key={`${allocation.choreTemplateId}-${allocation.bookingGuestId}-${globalIndex}`}
                                className="flex items-center gap-3 bg-slate-700/50 rounded-lg px-4 py-3 min-h-[56px]"
                              >
                                <select
                                  value={allocation.bookingGuestId}
                                  onChange={(e) =>
                                    reassignGuest(globalIndex, e.target.value)
                                  }
                                  className="flex-1 bg-slate-600 text-white rounded-lg px-3 py-2 text-lg min-h-[44px]"
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
                                  className="bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
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
              className="bg-slate-700 hover:bg-slate-600 text-white text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              Back
            </button>
            <div className="flex gap-2">
              <button
                onClick={generateRoster}
                disabled={generating}
                className="bg-slate-700 hover:bg-slate-600 text-white text-lg font-semibold px-6 py-4 rounded-xl min-h-[56px] transition-colors"
              >
                {generating ? "Regenerating..." : "Regenerate"}
              </button>
              <button
                onClick={() => setStep(4)}
                disabled={allocations.length === 0}
                className="bg-blue-600 hover:bg-blue-500 active:bg-blue-400 disabled:bg-slate-700 disabled:text-slate-500 text-white text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
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

          <div className="bg-slate-800 rounded-xl p-6 mb-6">
            <p className="text-lg text-slate-300 mb-4">
              You are about to confirm {allocations.length} chore assignment
              {allocations.length !== 1 ? "s" : ""} for{" "}
              {displayDate(dateStr)}.
            </p>

            {hasExistingRoster && (
              <p className="text-amber-400 text-lg mb-4">
                This will replace the existing confirmed roster.
              </p>
            )}

            {/* Summary */}
            <div className="space-y-2">
              {groupedAllocations
                .filter((g) => g.allocations.length > 0)
                .map((group) => (
                  <div key={group.tod}>
                    <h3 className="text-base font-medium text-slate-400 mb-1">
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
                        className="bg-slate-700/50 rounded-lg px-4 py-2 mb-1"
                      >
                        <span className="font-medium">{chore.name}</span>
                        <span className="text-slate-400 ml-2">
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
              className="bg-slate-700 hover:bg-slate-600 text-white text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              Back
            </button>
            <button
              onClick={confirmRoster}
              disabled={submitting}
              className="bg-green-600 hover:bg-green-500 active:bg-green-400 disabled:bg-slate-700 disabled:text-slate-500 text-white text-lg font-bold px-10 py-4 rounded-xl min-h-[56px] transition-colors"
            >
              {submitting ? "Confirming..." : "Confirm Roster"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
