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

  function applyFilters() {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (search) params.set("search", search);
    router.push(`/admin/bookings?${params.toString()}`);
  }

  function clearFilters() {
    setStatus("all");
    setFrom("");
    setTo("");
    setSearch("");
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
          <option value="PENDING">Pending</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="BUMPED">Bumped</option>
          <option value="COMPLETED">Completed</option>
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
      <Button onClick={applyFilters} size="sm">
        Filter
      </Button>
      <Button onClick={clearFilters} variant="outline" size="sm">
        Clear
      </Button>
    </div>
  );
}
