"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface Preferences {
  bookingConfirmation: boolean;
  bookingReminder: boolean;
  bookingBumped: boolean;
  bookingCancelled: boolean;
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
      <div className="text-sm text-red-500 py-4">
        Failed to load notification preferences.
      </div>
    );
  }

  const displayPrefs = editing ? editPrefs : prefs;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Manage your email notification preferences</h3>
        {!editing && (
          <Button variant="outline" size="sm" onClick={handleEdit}>
            Edit
          </Button>
        )}
      </div>

      {(Object.keys(PREFERENCE_LABELS) as Array<keyof Preferences>).map((key) => (
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
            className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
              editing ? "cursor-pointer" : ""
            } ${displayPrefs[key] ? "bg-blue-600" : "bg-gray-200"}`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                displayPrefs[key] ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      ))}

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

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
