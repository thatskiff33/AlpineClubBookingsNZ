"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { FocusedActionError } from "@/components/focused-action-error";

interface Preferences {
  bookingConfirmation: boolean;
  bookingReminder: boolean;
  bookingBumped: boolean;
  bookingCancelled: boolean;
  bookingAddedByFamily: boolean;
  choreRoster: boolean;
  marketingEmails: boolean;
}

const PREFERENCE_LABELS: Record<keyof Preferences, { label: string; description: string }> = {
  bookingConfirmation: {
    label: "Booking Confirmations",
    description: "Emails when your booking is confirmed or pending",
  },
  bookingReminder: {
    label: "Check-in Reminders",
    description: "Reminder email the day before your check-in",
  },
  bookingBumped: {
    label: "Booking Updates",
    description: "Notifications if your pending booking is bumped",
  },
  bookingAddedByFamily: {
    label: "Added to a Booking by Family",
    description:
      "A heads-up when someone in your family group puts you (or a family member you look after) on a booking",
  },
  bookingCancelled: {
    label: "Cancellation Notices",
    description: "Emails when your booking is cancelled",
  },
  choreRoster: {
    label: "Chore Roster",
    description: "Your assigned chores during your stay",
  },
  marketingEmails: {
    label: "Club Communications",
    description: "General club news and updates",
  },
};

// #1285: Which categories a member can actually switch off. Check-in reminders
// and chore rosters are optional/operational and are honored on the send path;
// Club Communications (marketing) is honored by the bulk-send recipient filter.
const TOGGLEABLE_KEYS: Array<keyof Preferences> = [
  "bookingReminder",
  // #2284 (S2): an FYI, not an essential transactional email, so it is
  // genuinely toggleable and honoured on the send path (the dispatcher checks
  // it before sending).
  "bookingAddedByFamily",
  "choreRoster",
  "marketingEmails",
];

// #1285: Must-send transactional categories. These are essential updates about
// a booking the member owns (confirmation, pending-booking bumps, cancellation
// and refund notices) and are ALWAYS sent — the send path never gates them.
// They are listed here for transparency but are intentionally not toggleable,
// because previously showing an on/off switch promised control that was never
// honored and could hide a cancellation/refund from the person affected.
const ALWAYS_SENT_KEYS: Array<keyof Preferences> = [
  "bookingConfirmation",
  "bookingBumped",
  "bookingCancelled",
];

export function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [editPrefs, setEditPrefs] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/notifications/preferences")
      .then((res) => res.json())
      .then((data) => {
        setPrefs(data);
        setEditPrefs(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function handleEdit() {
    setEditPrefs(prefs ? { ...prefs } : null);
    setEditing(true);
    setError(null);
  }

  function handleCancel() {
    setEditPrefs(prefs ? { ...prefs } : null);
    setEditing(false);
    setError(null);
  }

  function togglePref(key: keyof Preferences) {
    if (!editPrefs) return;
    setEditPrefs({ ...editPrefs, [key]: !editPrefs[key] });
  }

  async function handleSave() {
    if (!editPrefs) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editPrefs),
      });
      if (res.ok) {
        const updated = await res.json();
        setPrefs(updated);
        setEditPrefs(updated);
        setEditing(false);
      } else {
        setError("Failed to save preferences");
      }
    } catch {
      setError("Failed to save preferences");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        Loading preferences...
      </div>
    );
  }

  if (!prefs || !editPrefs) {
    return (
      <div className="text-sm text-danger-11 py-4">
        Failed to load notification preferences.
      </div>
    );
  }

  const displayPrefs = editing ? editPrefs : prefs;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Manage your email notification preferences</h2>
        {!editing && (
          <Button variant="outline" size="sm" onClick={handleEdit}>
            Edit
          </Button>
        )}
      </div>

      {TOGGLEABLE_KEYS.map((key) => (
        <div key={key} className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor={key} className="text-sm font-medium">
              {PREFERENCE_LABELS[key].label}
            </Label>
            <p className="text-xs text-muted-foreground">
              {PREFERENCE_LABELS[key].description}
            </p>
          </div>
          <button
            id={key}
            role="switch"
            aria-checked={displayPrefs[key]}
            onClick={() => editing && togglePref(key)}
            disabled={!editing}
            className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
              editing ? "cursor-pointer" : ""
            } ${displayPrefs[key] ? "bg-brand-gold" : "bg-muted"}`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-card shadow ring-0 transition duration-200 ease-in-out ${
                displayPrefs[key] ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      ))}

      <div className="space-y-3 border-t pt-4">
        <p className="text-xs text-muted-foreground">
          Essential booking emails are always sent so you never miss an update
          about a stay you have booked. These cannot be turned off.
        </p>
        {ALWAYS_SENT_KEYS.map((key) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {PREFERENCE_LABELS[key].label}
              </p>
              <p className="text-xs text-muted-foreground">
                {PREFERENCE_LABELS[key].description}
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-input px-3 py-1 text-xs font-medium text-muted-foreground">
              Always sent
            </span>
          </div>
        ))}
      </div>

      <FocusedActionError id="notification-preferences-error" error={error ?? ""} />

      {editing && (
        <div className="flex gap-3 pt-2">
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? "Saving..." : "Save Changes"}
          </Button>
          <Button variant="outline" onClick={handleCancel} disabled={saving} size="sm">
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
