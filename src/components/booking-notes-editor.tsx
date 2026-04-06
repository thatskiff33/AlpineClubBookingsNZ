"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function BookingNotesEditor({
  bookingId,
  initialNotes,
  canEdit,
}: {
  bookingId: string;
  initialNotes: string;
  canEdit: boolean;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const hasChanged = notes !== initialNotes;

  async function handleSave() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to save notes");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save notes");
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit) {
    return <p className="text-gray-600">{initialNotes || "No notes"}</p>;
  }

  return (
    <div className="space-y-3">
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={500}
        rows={3}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
        placeholder="Add notes about this booking..."
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {notes.length}/500 characters
        </span>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-red-600">{error}</span>}
          {saved && <span className="text-xs text-green-600">Saved</span>}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !hasChanged}
          >
            {saving ? "Saving..." : "Save Notes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
