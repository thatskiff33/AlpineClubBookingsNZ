"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FocusedActionError } from "@/components/focused-action-error";

/** Name one accepted adult at a time, preserving the accepted quote and hold. */
export function ResolvePendingSchoolAdults({
  requestId,
  expectedVersion,
  pendingAdultCount,
  canEdit,
  onResolved,
}: {
  requestId: string;
  expectedVersion: number;
  pendingAdultCount: number;
  canEdit: boolean;
  onResolved: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attentionKey, setAttentionKey] = useState(0);
  const [refreshNeeded, setRefreshNeeded] = useState(false);

  function clearDraft() {
    setEditing(false);
    setFirstName("");
    setLastName("");
    setEmail("");
  }

  if (pendingAdultCount <= 0) return null;
  async function save() {
    if (!canEdit || saving || refreshNeeded) return;
    setSaving(true);
    setError("");
    let saved = false;
    try {
      const response = await fetch(`/api/admin/booking-requests/${encodeURIComponent(requestId)}/resolve-pending-adults`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion,
          teachers: [{ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() || null }],
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || "The adult could not be named. Reload this request and try again.");
      saved = true;
      clearDraft();
      await onResolved();
    } catch (cause) {
      if (saved) setRefreshNeeded(true);
      setError(saved
        ? "The name was saved, but this page could not refresh. Reload it before naming anyone else."
        : cause instanceof Error ? cause.message : "The adult could not be named.");
      setAttentionKey((key) => key + 1);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-warning-6 bg-background p-3">
      <p className="text-sm font-medium">
        {pendingAdultCount} adult {pendingAdultCount === 1 ? "name is" : "names are"} pending
      </p>
      <p className="text-sm text-muted-foreground">
        These adults have held beds and are included in the accepted price. Enter each real name before approving the booking.
      </p>
      <FocusedActionError id={`pending-adult-error-${requestId}`} error={error} attentionKey={attentionKey} />
      {!editing ? (
        <Button size="sm" variant="outline" disabled={!canEdit || refreshNeeded} onClick={() => setEditing(true)}>
          Name one pending adult
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label htmlFor={`pending-first-${requestId}`}>First name</Label><Input id={`pending-first-${requestId}`} value={firstName} onChange={(event) => setFirstName(event.target.value)} /></div>
            <div><Label htmlFor={`pending-last-${requestId}`}>Last name</Label><Input id={`pending-last-${requestId}`} value={lastName} onChange={(event) => setLastName(event.target.value)} /></div>
            <div><Label htmlFor={`pending-email-${requestId}`}>Email, if known</Label><Input id={`pending-email-${requestId}`} type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={!canEdit || saving || !firstName.trim() || !lastName.trim()} onClick={save}>
              {saving ? "Saving…" : "Save real name"}
            </Button>
            <Button size="sm" variant="outline" disabled={saving} onClick={() => { clearDraft(); setError(""); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
