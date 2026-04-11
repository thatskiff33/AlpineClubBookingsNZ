"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";

export function BookingFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState(searchParams.get("status") || "all");
  const [from, setFrom] = useState(searchParams.get("from") || "");
  const [to, setTo] = useState(searchParams.get("to") || "");
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [sort, setSort] = useState(searchParams.get("sort") || "updatedAt");
  const [month, setMonth] = useState(searchParams.get("month") || "");

  // Generate month options: current year ±1
  const monthOptions: Array<{ value: string; label: string }> = [];
  const currentYear = new Date().getFullYear();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let y = currentYear - 1; y <= currentYear + 1; y++) {
    for (let m = 0; m < 12; m++) {
      const val = `${y}-${String(m + 1).padStart(2, "0")}`;
      monthOptions.push({ value: val, label: `${monthNames[m]} ${y}` });
    }
  }

  function applyFilters() {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (search) params.set("search", search);
    if (sort !== "updatedAt") params.set("sort", sort);
    if (month) params.set("month", month);
    router.push(`/admin/bookings?${params.toString()}`);
  }

  function clearFilters() {
    setStatus("all");
    setFrom("");
    setTo("");
    setSearch("");
    setSort("updatedAt");
    setMonth("");
    router.push("/admin/bookings");
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-white p-4">
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Status</label>
        <select
          value={status}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setStatus(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          <option value="all">All</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="PAID">Paid</option>
          <option value="PENDING">Pending</option>
          <option value="WAITLISTED">Waitlisted</option>
          <option value="WAITLIST_OFFERED">Waitlist Offered</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="BUMPED">Bumped</option>
          <option value="COMPLETED">Completed</option>
          <option value="DRAFT">Draft</option>
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Month</label>
        <select
          value={month}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setMonth(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          <option value="">All months</option>
          {monthOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">From</label>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">To</label>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Search member</label>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or email..."
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Sort by</label>
        <select
          value={sort}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSort(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          <option value="updatedAt">Last Updated</option>
          <option value="checkIn">Check-in Date</option>
        </select>
      </div>
      <Button onClick={applyFilters} size="sm">
        Filter
      </Button>
      <Button onClick={clearFilters} variant="outline" size="sm">
        Clear
      </Button>
    </div>
  );
}
