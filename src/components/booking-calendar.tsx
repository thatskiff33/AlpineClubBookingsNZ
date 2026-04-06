"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { LODGE_CAPACITY } from "@/lib/capacity";

interface SeasonInfo {
  name: string;
  type: string;
}

interface BookingCalendarProps {
  onDateSelect: (checkIn: Date, checkOut: Date) => void;
  selectedCheckIn?: Date | null;
  selectedCheckOut?: Date | null;
}

export function BookingCalendar({ onDateSelect, selectedCheckIn, selectedCheckOut }: BookingCalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [availability, setAvailability] = useState<Record<string, number>>({});
  const [seasons, setSeasons] = useState<Record<string, SeasonInfo>>({});
  const [selecting, setSelecting] = useState<"checkIn" | "checkOut">("checkIn");
  const [checkIn, setCheckIn] = useState<Date | null>(selectedCheckIn || null);
  const [checkOut, setCheckOut] = useState<Date | null>(selectedCheckOut || null);

  const fetchAvailability = useCallback(async () => {
    const res = await fetch(
      `/api/availability?year=${currentMonth.year}&month=${currentMonth.month}`
    );
    if (res.ok) {
      const data = await res.json();
      setAvailability(data.availability ?? {});
      setSeasons(data.seasons ?? {});
    }
  }, [currentMonth.year, currentMonth.month]);

  useEffect(() => {
    fetchAvailability();
  }, [fetchAvailability]);

  const daysInMonth = new Date(currentMonth.year, currentMonth.month + 1, 0).getDate();
  const firstDay = new Date(currentMonth.year, currentMonth.month, 1).getDay();
  // Adjust for Monday start (0=Mon, 6=Sun)
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  function handleDayClick(day: number) {
    const date = new Date(currentMonth.year, currentMonth.month, day);
    date.setHours(0, 0, 0, 0);

    if (date < today) return;

    if (selecting === "checkIn") {
      setCheckIn(date);
      setCheckOut(null);
      setSelecting("checkOut");
    } else {
      if (checkIn && date > checkIn) {
        setCheckOut(date);
        setSelecting("checkIn");
        onDateSelect(checkIn, date);
      } else {
        // If selected date is before checkIn, treat as new checkIn
        setCheckIn(date);
        setCheckOut(null);
        setSelecting("checkOut");
      }
    }
  }

  function getDayClass(day: number, available: number, isPast: boolean, dateStr: string) {
    const date = new Date(currentMonth.year, currentMonth.month, day);
    date.setHours(0, 0, 0, 0);

    const season = seasons[dateStr];

    let classes = "flex flex-col items-center justify-center h-12 w-10 rounded-md text-sm font-medium transition-colors ";

    // Season top-border indicator
    if (season?.type === "WINTER") {
      classes += "border-t-2 border-blue-400 ";
    } else if (season?.type === "SUMMER") {
      classes += "border-t-2 border-amber-400 ";
    }

    if (isPast) {
      classes += "text-gray-300 cursor-not-allowed ";
    } else if (available <= 0) {
      classes += "bg-red-100 text-red-400 cursor-not-allowed ";
    } else if (available <= 5) {
      classes += "bg-yellow-100 text-yellow-800 hover:bg-yellow-200 cursor-pointer ";
    } else {
      classes += "bg-green-100 text-green-800 hover:bg-green-200 cursor-pointer ";
    }

    // Highlight selected range
    if (checkIn && date.getTime() === checkIn.getTime()) {
      classes += "!bg-blue-600 !text-white !border-blue-600 ";
    } else if (checkOut && date.getTime() === checkOut.getTime()) {
      classes += "!bg-blue-600 !text-white !border-blue-600 ";
    } else if (checkIn && checkOut && date > checkIn && date < checkOut) {
      classes += "!bg-blue-100 ";
    }

    return classes;
  }

  function prevMonth() {
    setCurrentMonth((prev) => {
      if (prev.month === 0) return { year: prev.year - 1, month: 11 };
      return { ...prev, month: prev.month - 1 };
    });
  }

  function nextMonth() {
    setCurrentMonth((prev) => {
      if (prev.month === 11) return { year: prev.year + 1, month: 0 };
      return { ...prev, month: prev.month + 1 };
    });
  }

  const monthName = new Date(currentMonth.year, currentMonth.month).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });

  // Unique seasons visible in the current month for the legend
  const uniqueSeasons = [...new Map(Object.values(seasons).map((s) => [s.name, s])).values()];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={prevMonth}>
          &lsaquo; Prev
        </Button>
        <h3 className="text-lg font-semibold">{monthName}</h3>
        <Button variant="outline" size="sm" onClick={nextMonth}>
          Next &rsaquo;
        </Button>
      </div>

      <div className="text-sm text-gray-600">
        {selecting === "checkIn" ? "Select check-in date" : "Select check-out date"}
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="text-xs font-medium text-gray-500 py-2">
            {d}
          </div>
        ))}

        {Array.from({ length: startOffset }).map((_, i) => (
          <div key={`empty-${i}`} />
        ))}

        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
          const date = new Date(currentMonth.year, currentMonth.month, day);
          date.setHours(0, 0, 0, 0);
          const dateStr = date.toISOString().split("T")[0];
          const occupied = availability[dateStr] ?? 0;
          const available = LODGE_CAPACITY - occupied;
          const isPast = date < today;

          return (
            <button
              key={day}
              onClick={() => handleDayClick(day)}
              className={getDayClass(day, available, isPast, dateStr)}
              disabled={isPast || available <= 0}
            >
              <span className="leading-none">{day}</span>
              {!isPast && (
                <span className="text-[9px] leading-none mt-0.5 opacity-70">
                  {available}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Availability legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-green-100" /> Available
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-yellow-100" /> Limited (&le;5 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-red-100" /> Full
        </span>
      </div>

      {/* Season legend — only shown when season data is available */}
      {uniqueSeasons.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
          {uniqueSeasons.map((s) => (
            <span key={s.name} className="flex items-center gap-1">
              <span
                className={`h-3 w-3 rounded border-t-2 ${
                  s.type === "WINTER" ? "border-blue-400" : "border-amber-400"
                }`}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
