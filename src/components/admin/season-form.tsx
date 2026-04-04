"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface RateInput {
  ageTier: "ADULT" | "YOUTH" | "CHILD";
  isMember: boolean;
  pricePerNight: string; // dollars as string for input
}

const defaultRates: RateInput[] = [
  { ageTier: "ADULT", isMember: true, pricePerNight: "" },
  { ageTier: "ADULT", isMember: false, pricePerNight: "" },
  { ageTier: "YOUTH", isMember: true, pricePerNight: "" },
  { ageTier: "YOUTH", isMember: false, pricePerNight: "" },
  { ageTier: "CHILD", isMember: true, pricePerNight: "" },
  { ageTier: "CHILD", isMember: false, pricePerNight: "" },
];

export function SeasonForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [type, setType] = useState<"WINTER" | "SUMMER">("WINTER");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [rates, setRates] = useState<RateInput[]>(defaultRates);

  function updateRate(index: number, price: string) {
    setRates((prev) => prev.map((r, i) => (i === index ? { ...r, pricePerNight: price } : r)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const ratesData = rates.map((r) => ({
      ageTier: r.ageTier,
      isMember: r.isMember,
      pricePerNightCents: Math.round(parseFloat(r.pricePerNight || "0") * 100),
    }));

    const res = await fetch("/api/seasons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        type,
        startDate,
        endDate,
        rates: ratesData,
      }),
    });

    if (res.ok) {
      setOpen(false);
      setName("");
      setStartDate("");
      setEndDate("");
      setRates(defaultRates);
      router.refresh();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to create season");
    }
    setLoading(false);
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>Create Season</Button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New Season</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Season Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Winter 2026"
                required
              />
            </div>
            <div className="space-y-1">
              <Label>Type</Label>
              <select
                value={type}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setType(e.target.value as "WINTER" | "SUMMER")}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
              >
                <option value="WINTER">Winter</option>
                <option value="SUMMER">Summer</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Start Date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label>End Date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
            </div>
          </div>

          <div>
            <Label className="mb-2 block">Rates (per night)</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {rates.map((rate, i) => (
                <div key={i} className="flex items-center gap-2 rounded border p-2">
                  <span className="text-sm font-medium w-24">
                    {rate.ageTier} {rate.isMember ? "(M)" : "(NM)"}
                  </span>
                  <span className="text-sm text-gray-400">$</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={rate.pricePerNight}
                    onChange={(e) => updateRate(i, e.target.value)}
                    placeholder="0.00"
                    className="w-24"
                    required
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <Button type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create Season"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
