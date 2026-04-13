"use client";

import { useState, useEffect, useCallback } from "react";
import type { KioskTier } from "@/lib/kiosk-access";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  phone: string | null;
  isMember: boolean;
  isArriving: boolean;
  isDeparting: boolean;
  arrivedAt: string | null;
  departedAt: string | null;
}

interface BookingGroup {
  bookingId: string;
  memberName: string;
  expectedArrivalTime: string | null;
  guests: Guest[];
}

interface Assignment {
  id: string;
  choreTemplateId: string;
  choreTemplateName: string;
  choreDescription: string | null;
  choreSortOrder: number;
  choreTimeOfDay: string;
  bookingGuestId: string | null;
  guestName: string | null;
  guestAgeTier: string | null;
  bookingId: string;
  status: string;
  completedAt: string | null;
  completedVia: string | null;
}

interface AccessInfo {
  tier: KioskTier;
  dateRange: { minDate: string; maxDate: string } | null;
  canManageRoster: boolean;
  canMarkAttendance: boolean;
  canCompleteChores: boolean;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatArrivalTime(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export default function KioskPage() {
  const [date, setDate] = useState(() => formatDate(new Date()));
  const [bookings, setBookings] = useState<BookingGroup[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [viewAs, setViewAs] = useState<KioskTier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [failCount, setFailCount] = useState(0);
  const [showPinForm, setShowPinForm] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinLoading, setPinLoading] = useState(false);

  // Effective tier (admin can preview other tiers)
  const effectiveTier = viewAs ?? access?.tier ?? "none";
  const canMarkAttendance = effectiveTier === "admin" || effectiveTier === "hut-leader" || effectiveTier === "lodge";
  const canCompleteChores = canMarkAttendance;
  const canManageRoster = effectiveTier === "admin" || effectiveTier === "hut-leader";

  const fetchData = useCallback(async () => {
    try {
      const [guestsRes, rosterRes, accessRes] = await Promise.all([
        fetch(`/api/lodge/guests/${date}`),
        fetch(`/api/lodge/roster/${date}`),
        fetch(`/api/lodge/access?date=${date}`),
      ]);

      if (guestsRes.ok) {
        const guestsData = await guestsRes.json();
        setBookings(guestsData.bookings);
      }

      if (rosterRes.ok) {
        const rosterData = await rosterRes.json();
        setAssignments(rosterData.assignments);
      }

      if (accessRes.ok) {
        const accessData = await accessRes.json();
        setAccess(accessData);
      }

      setError(null);
      setFailCount(0);
    } catch {
      setError("Failed to load data");
      setFailCount((c) => c + 1);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // Auto-refresh: backs off to 5 min after 3 consecutive failures
  useEffect(() => {
    const interval = failCount >= 3 ? 300000 : 60000;
    const timer = setInterval(fetchData, interval);
    return () => clearInterval(timer);
  }, [failCount, fetchData]);

  const canNavigateBack = () => {
    if (!access?.dateRange) return true;
    const prev = new Date(date + "T00:00:00");
    prev.setDate(prev.getDate() - 1);
    return formatDate(prev) >= access.dateRange.minDate;
  };

  const canNavigateForward = () => {
    if (!access?.dateRange) return true;
    const next = new Date(date + "T00:00:00");
    next.setDate(next.getDate() + 1);
    return formatDate(next) <= access.dateRange.maxDate;
  };

  const changeDate = (delta: number) => {
    const d = new Date(date + "T00:00:00");
    d.setDate(d.getDate() + delta);
    const newDate = formatDate(d);

    // Enforce date range for restricted tiers
    if (access?.dateRange) {
      if (newDate < access.dateRange.minDate || newDate > access.dateRange.maxDate) {
        return;
      }
    }

    setDate(newDate);
  };

  const showActionError = (message: string) => {
    setActionError(message);
    setTimeout(() => setActionError(null), 3000);
  };

  const submitPin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPinError(null);
    setPinLoading(true);

    try {
      const res = await fetch("/api/lodge/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setPinError(data?.error || "PIN login failed");
        return;
      }

      setPin("");
      setShowPinForm(false);
      setLoading(true);
      await fetchData();
    } catch {
      setPinError("PIN login failed");
    } finally {
      setPinLoading(false);
    }
  };

  const toggleChore = async (assignmentId: string, currentStatus: string) => {
    if (!canCompleteChores) return;
    const action = currentStatus === "COMPLETED" ? "uncomplete" : "complete";
    try {
      const res = await fetch(`/api/lodge/roster/${date}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, assignmentId }),
      });
      if (!res.ok) {
        showActionError("Failed to update chore");
        return;
      }
      setAssignments((prev) =>
        prev.map((a) =>
          a.id === assignmentId
            ? {
                ...a,
                status: action === "complete" ? "COMPLETED" : "CONFIRMED",
                completedAt: action === "complete" ? new Date().toISOString() : null,
                completedVia: action === "complete" ? "KIOSK" : null,
              }
            : a
        )
      );
    } catch {
      showActionError("Failed to update chore");
    }
  };

  const toggleArrival = async (guestId: string) => {
    if (!canMarkAttendance) return;
    try {
      const res = await fetch(`/api/lodge/guests/${date}/arrive`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingGuestId: guestId }),
      });
      if (!res.ok) {
        showActionError("Failed to update arrival");
        return;
      }
      const data = await res.json();
      setBookings((prev) =>
        prev.map((b) => ({
          ...b,
          guests: b.guests.map((g) =>
            g.id === guestId ? { ...g, arrivedAt: data.arrivedAt } : g
          ),
        }))
      );
    } catch {
      showActionError("Failed to update arrival");
    }
  };

  const toggleDeparture = async (guestId: string) => {
    if (!canMarkAttendance) return;
    try {
      const res = await fetch(`/api/lodge/guests/${date}/depart`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingGuestId: guestId }),
      });
      if (!res.ok) {
        showActionError("Failed to update departure");
        return;
      }
      const data = await res.json();
      setBookings((prev) =>
        prev.map((b) => ({
          ...b,
          guests: b.guests.map((g) =>
            g.id === guestId ? { ...g, departedAt: data.departedAt } : g
          ),
        }))
      );
    } catch {
      showActionError("Failed to update departure");
    }
  };

  const totalGuests = bookings.reduce((sum, b) => sum + b.guests.length, 0);

  // Group assignments by time of day
  const timeGroups = ["MORNING", "EVENING", "ANYTIME"] as const;
  const groupedAssignments = timeGroups.map((tod) => ({
    label: tod === "MORNING" ? "Morning" : tod === "EVENING" ? "Evening" : "Anytime",
    assignments: assignments.filter((a) => a.choreTimeOfDay === tod),
  }));

  const hasAssignments = assignments.length > 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 select-none">
      {actionError && (
        <div className="bg-red-600 text-white text-center py-2 text-sm font-medium">
          {actionError}
        </div>
      )}

      {/* Admin tier preview dropdown */}
      {access?.tier === "admin" && (
        <div className="flex items-center justify-end mb-3 gap-2">
          <span className="text-sm text-slate-400">Viewing as:</span>
          <select
            value={viewAs ?? "admin"}
            onChange={(e) => {
              const val = e.target.value as KioskTier;
              setViewAs(val === access.tier ? null : val);
            }}
            className="bg-slate-700 text-white text-sm rounded px-3 py-1.5 border border-slate-600"
          >
            <option value="admin">Admin</option>
            <option value="hut-leader">Hut Leader</option>
            <option value="lodge">Lodge</option>
            <option value="staying-guest">Staying Guest</option>
          </select>
        </div>
      )}

      {/* Header with date navigation */}
      <header className="flex items-center justify-between mb-6">
        <button
          onClick={() => changeDate(-1)}
          disabled={!canNavigateBack()}
          className={`text-white text-2xl font-bold rounded-xl px-6 py-4 min-w-[64px] min-h-[56px] ${
            canNavigateBack()
              ? "bg-slate-700 hover:bg-slate-600 active:bg-slate-500"
              : "bg-slate-800 text-slate-600 cursor-not-allowed"
          }`}
          aria-label="Previous day"
        >
          &lsaquo;
        </button>
        <div className="text-center">
          <h1 className="text-2xl font-bold">{displayDate(date)}</h1>
          <p className="text-slate-400 text-lg">
            {totalGuests} guest{totalGuests !== 1 ? "s" : ""} staying
          </p>
          {(effectiveTier === "staying-guest" || effectiveTier === "none") && (
            <p className="text-blue-400 text-sm mt-1">Read-only view</p>
          )}
        </div>
        <button
          onClick={() => changeDate(1)}
          disabled={!canNavigateForward()}
          className={`text-white text-2xl font-bold rounded-xl px-6 py-4 min-w-[64px] min-h-[56px] ${
            canNavigateForward()
              ? "bg-slate-700 hover:bg-slate-600 active:bg-slate-500"
              : "bg-slate-800 text-slate-600 cursor-not-allowed"
          }`}
          aria-label="Next day"
        >
          &rsaquo;
        </button>
      </header>

      {error && (
        <div className="bg-red-900/50 text-red-200 rounded-xl p-4 mb-4 text-lg">
          {error}
        </div>
      )}

      {effectiveTier === "lodge" && (
        <section className="bg-slate-800 rounded-2xl p-4 mb-4 border border-slate-700">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">
                Hut leader controls
              </h2>
              <p className="text-sm text-slate-300 mt-1">
                Enter the 6-digit hut leader PIN to unlock hut leader controls on
                this kiosk, including roster management.
              </p>
            </div>
            {!showPinForm && (
              <button
                onClick={() => {
                  setShowPinForm(true);
                  setPinError(null);
                }}
                className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 active:bg-blue-400"
              >
                Enter PIN
              </button>
            )}
          </div>

          {showPinForm && (
            <form
              onSubmit={submitPin}
              className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1">
                <label
                  htmlFor="hut-leader-pin"
                  className="block text-sm font-medium text-slate-300 mb-2"
                >
                  Hut leader PIN
                </label>
                <input
                  id="hut-leader-pin"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={pin}
                  onChange={(event) =>
                    setPin(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  className="w-full rounded-xl border border-slate-600 bg-slate-900 px-4 py-3 text-lg tracking-[0.35em] text-white outline-none transition-colors focus:border-blue-400"
                  placeholder="123456"
                  autoComplete="one-time-code"
                  required
                />
                {pinError && (
                  <p className="mt-2 text-sm text-red-300">{pinError}</p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={pinLoading || pin.length !== 6}
                  className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 active:bg-blue-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  {pinLoading ? "Checking..." : "Unlock"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowPinForm(false);
                    setPin("");
                    setPinError(null);
                  }}
                  className="rounded-xl bg-slate-700 px-4 py-3 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-600 active:bg-slate-500"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Lodge List Panel */}
        <section>
          <h2 className="text-xl font-semibold mb-3 text-slate-300">
            Lodge List
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
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-slate-400">
                      Booked by {booking.memberName}
                    </p>
                    {booking.expectedArrivalTime && booking.guests.some((g) => g.isArriving) && (
                      <span className="text-sm text-blue-300 font-medium">
                        Arriving {formatArrivalTime(booking.expectedArrivalTime)}
                      </span>
                    )}
                    {!booking.expectedArrivalTime && booking.guests.some((g) => g.isArriving) && (
                      <span className="text-sm text-slate-500">
                        Arrival time: Not specified
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">
                    {booking.guests.map((guest) => (
                      <div
                        key={guest.id}
                        className={`flex items-center justify-between rounded-lg px-4 py-3 min-h-[56px] ${
                          guest.departedAt
                            ? "bg-slate-700/30 opacity-60"
                            : guest.arrivedAt
                              ? "bg-green-900/30 border border-green-700/50"
                              : "bg-slate-700/50"
                        }`}
                      >
                        <div>
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-lg font-medium">
                              {guest.firstName} {guest.lastName}
                            </span>
                            <span className="text-sm text-slate-400">
                              {guest.ageTier}
                            </span>
                          </div>
                          <p className="text-sm text-slate-400 mt-1">
                            {guest.phone
                              ? `Phone ${guest.phone}`
                              : "Phone not available"}
                          </p>
                        </div>
                        <div className="flex gap-2 items-center">
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
                          {!guest.isMember && (
                            <span className="bg-slate-600 text-slate-300 text-sm px-3 py-1 rounded-full">
                              Non-member
                            </span>
                          )}
                          {/* Arrival/Departure toggle buttons - hidden for staying-guest tier */}
                          {canMarkAttendance && !guest.departedAt && (
                            <button
                              onClick={() => toggleArrival(guest.id)}
                              className={`text-sm font-medium px-4 py-2 rounded-lg min-h-[44px] transition-colors ${
                                guest.arrivedAt
                                  ? "bg-green-600 text-white"
                                  : "bg-slate-600 hover:bg-slate-500 active:bg-slate-400 text-slate-200"
                              }`}
                            >
                              {guest.arrivedAt ? "Arrived" : "Mark Arrived"}
                            </button>
                          )}
                          {canMarkAttendance && (guest.arrivedAt || guest.departedAt) && (
                            <button
                              onClick={() => toggleDeparture(guest.id)}
                              className={`text-sm font-medium px-4 py-2 rounded-lg min-h-[44px] transition-colors ${
                                guest.departedAt
                                  ? "bg-amber-600 text-white"
                                  : "bg-slate-600 hover:bg-slate-500 active:bg-slate-400 text-slate-200"
                              }`}
                            >
                              {guest.departedAt ? "Departed" : "Mark Departed"}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Chore Roster Panel */}
        <section>
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-xl font-semibold text-slate-300">
              Chore Roster
            </h2>
            {canManageRoster && (
              <a
                href={`/lodge/roster/${date}/setup`}
                className="inline-block bg-blue-600 hover:bg-blue-500 active:bg-blue-400 text-white text-sm font-semibold px-4 py-2 rounded-xl min-h-[44px] transition-colors whitespace-nowrap"
              >
                {hasAssignments ? "Manage Today&apos;s Roster" : "Set Up Today&apos;s Roster"}
              </a>
            )}
          </div>
          {!hasAssignments ? (
            <div className="bg-slate-800 rounded-xl p-6 text-center">
              <p className="text-slate-400 text-lg mb-4">
                No roster set up for this date
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {groupedAssignments
                .filter((g) => g.assignments.length > 0)
                .map((group) => (
                  <div key={group.label}>
                    <h3 className="text-base font-medium text-slate-400 mb-2">
                      {group.label}
                    </h3>
                    <div className="space-y-2">
                      {/* Group by chore template */}
                      {Object.values(
                        group.assignments.reduce(
                          (acc, a) => {
                            if (!acc[a.choreTemplateId]) {
                              acc[a.choreTemplateId] = {
                                name: a.choreTemplateName,
                                assignments: [],
                              };
                            }
                            acc[a.choreTemplateId].assignments.push(a);
                            return acc;
                          },
                          {} as Record<
                            string,
                            { name: string; assignments: Assignment[] }
                          >
                        )
                      ).map((chore) => (
                        <div
                          key={chore.name}
                          className="bg-slate-800 rounded-xl p-4"
                        >
                          <h4 className="font-semibold text-lg mb-2">
                            {chore.name}
                          </h4>
                          <div className="space-y-1">
                            {chore.assignments.map((a) =>
                              canCompleteChores ? (
                                <button
                                  key={a.id}
                                  onClick={() => toggleChore(a.id, a.status)}
                                  className={`w-full flex items-center gap-3 rounded-lg px-4 py-3 min-h-[56px] text-left transition-colors ${
                                    a.status === "COMPLETED"
                                      ? "bg-green-800/40 text-green-200"
                                      : "bg-slate-700/50 hover:bg-slate-600/50 active:bg-slate-500/50"
                                  }`}
                                >
                                  <div
                                    className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center flex-shrink-0 ${
                                      a.status === "COMPLETED"
                                        ? "border-green-400 bg-green-600"
                                        : "border-slate-500"
                                    }`}
                                  >
                                    {a.status === "COMPLETED" && (
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
                                  <span className="text-lg">
                                    {a.guestName ?? "Unassigned"}
                                  </span>
                                </button>
                              ) : (
                                <div
                                  key={a.id}
                                  className={`w-full flex items-center gap-3 rounded-lg px-4 py-3 min-h-[56px] ${
                                    a.status === "COMPLETED"
                                      ? "bg-green-800/40 text-green-200"
                                      : "bg-slate-700/30"
                                  }`}
                                >
                                  <div
                                    className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center flex-shrink-0 ${
                                      a.status === "COMPLETED"
                                        ? "border-green-400 bg-green-600"
                                        : "border-slate-500"
                                    }`}
                                  >
                                    {a.status === "COMPLETED" && (
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
                                  <span className="text-lg">
                                    {a.guestName ?? "Unassigned"}
                                  </span>
                                </div>
                              )
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </section>
      </div>

      {/* Last refresh indicator */}
      <footer className="mt-6 text-center text-sm text-slate-600">
        Auto-refreshes every {failCount >= 3 ? "5m" : "60s"}
      </footer>
    </div>
  );
}
