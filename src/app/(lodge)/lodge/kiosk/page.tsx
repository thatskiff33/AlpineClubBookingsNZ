"use client";

import { useState, useEffect, useCallback } from "react";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  isArriving: boolean;
  isDeparting: boolean;
  arrivedAt: string | null;
  departedAt: string | null;
}

interface BookingGroup {
  bookingId: string;
  memberName: string;
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

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
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

export default function KioskPage() {
  const [date, setDate] = useState(() => formatDate(new Date()));
  const [bookings, setBookings] = useState<BookingGroup[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [failCount, setFailCount] = useState(0);

  const fetchData = useCallback(async () => {
    try {
      const [guestsRes, rosterRes] = await Promise.all([
        fetch(`/api/lodge/guests/${date}`),
        fetch(`/api/lodge/roster/${date}`),
      ]);

      if (guestsRes.ok) {
        const guestsData = await guestsRes.json();
        setBookings(guestsData.bookings);
      }

      if (rosterRes.ok) {
        const rosterData = await rosterRes.json();
        setAssignments(rosterData.assignments);
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

  const changeDate = (delta: number) => {
    const d = new Date(date + "T00:00:00");
    d.setDate(d.getDate() + delta);
    setDate(formatDate(d));
  };

  const toggleChore = async (assignmentId: string, currentStatus: string) => {
    const action = currentStatus === "COMPLETED" ? "uncomplete" : "complete";
    try {
      const res = await fetch(`/api/lodge/roster/${date}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, assignmentId }),
      });
      if (res.ok) {
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
      }
    } catch {
      setActionError("Failed to update chore");
      setTimeout(() => setActionError(null), 3000);
    }
  };

  const toggleArrival = async (guestId: string) => {
    try {
      const res = await fetch(`/api/lodge/guests/${date}/arrive`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingGuestId: guestId }),
      });
      if (res.ok) {
        const data = await res.json();
        setBookings((prev) =>
          prev.map((b) => ({
            ...b,
            guests: b.guests.map((g) =>
              g.id === guestId ? { ...g, arrivedAt: data.arrivedAt } : g
            ),
          }))
        );
      }
    } catch {
      setActionError("Failed to update arrival");
      setTimeout(() => setActionError(null), 3000);
    }
  };

  const toggleDeparture = async (guestId: string) => {
    try {
      const res = await fetch(`/api/lodge/guests/${date}/depart`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingGuestId: guestId }),
      });
      if (res.ok) {
        const data = await res.json();
        setBookings((prev) =>
          prev.map((b) => ({
            ...b,
            guests: b.guests.map((g) =>
              g.id === guestId ? { ...g, departedAt: data.departedAt } : g
            ),
          }))
        );
      }
    } catch {
      setActionError("Failed to update departure");
      setTimeout(() => setActionError(null), 3000);
    }
  };

  const totalGuests = bookings.reduce((sum, b) => sum + b.guests.length, 0);

  // Group assignments by time of day
  const timeGroups = ["MORNING", "EVENING", "ANYTIME"] as const;
  const groupedAssignments = timeGroups.map((tod) => ({
    label: tod === "MORNING" ? "Morning" : tod === "EVENING" ? "Evening" : "Anytime",
    assignments: assignments.filter((a) => a.choreTimeOfDay === tod),
  }));

  const hasRoster = assignments.some(
    (a) => a.status === "CONFIRMED" || a.status === "COMPLETED"
  );

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
      {/* Header with date navigation */}
      <header className="flex items-center justify-between mb-6">
        <button
          onClick={() => changeDate(-1)}
          className="bg-slate-700 hover:bg-slate-600 active:bg-slate-500 text-white text-2xl font-bold rounded-xl px-6 py-4 min-w-[64px] min-h-[56px]"
          aria-label="Previous day"
        >
          ‹
        </button>
        <div className="text-center">
          <h1 className="text-2xl font-bold">{displayDate(date)}</h1>
          <p className="text-slate-400 text-lg">
            {totalGuests} guest{totalGuests !== 1 ? "s" : ""} staying
          </p>
        </div>
        <button
          onClick={() => changeDate(1)}
          className="bg-slate-700 hover:bg-slate-600 active:bg-slate-500 text-white text-2xl font-bold rounded-xl px-6 py-4 min-w-[64px] min-h-[56px]"
          aria-label="Next day"
        >
          ›
        </button>
      </header>

      {error && (
        <div className="bg-red-900/50 text-red-200 rounded-xl p-4 mb-4 text-lg">
          {error}
        </div>
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
                  <p className="text-sm text-slate-400 mb-2">
                    Booked by {booking.memberName}
                  </p>
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
                        <div className="flex items-center gap-3">
                          <span className="text-lg font-medium">
                            {guest.firstName} {guest.lastName}
                          </span>
                          <span className="text-sm text-slate-400">
                            {guest.ageTier}
                          </span>
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
                          {/* Arrival/Departure toggle buttons */}
                          {guest.isArriving && !guest.departedAt && (
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
                          {guest.isDeparting && (
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
          <h2 className="text-xl font-semibold mb-3 text-slate-300">
            Chore Roster
          </h2>
          {!hasRoster && assignments.length === 0 ? (
            <div className="bg-slate-800 rounded-xl p-6 text-center">
              <p className="text-slate-400 text-lg mb-4">
                No roster set up for this date
              </p>
              <a
                href={`/lodge/roster/${date}/setup`}
                className="inline-block bg-blue-600 hover:bg-blue-500 active:bg-blue-400 text-white text-lg font-semibold px-8 py-4 rounded-xl min-h-[56px] transition-colors"
              >
                Set Up Today&apos;s Roster
              </a>
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
                            {chore.assignments.map((a) => (
                              <button
                                key={a.id}
                                onClick={() => toggleChore(a.id, a.status)}
                                disabled={a.status === "SUGGESTED"}
                                className={`w-full flex items-center gap-3 rounded-lg px-4 py-3 min-h-[56px] text-left transition-colors ${
                                  a.status === "COMPLETED"
                                    ? "bg-green-800/40 text-green-200"
                                    : a.status === "CONFIRMED"
                                      ? "bg-slate-700/50 hover:bg-slate-600/50 active:bg-slate-500/50"
                                      : "bg-slate-700/30 text-slate-500 cursor-default"
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
                            ))}
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
