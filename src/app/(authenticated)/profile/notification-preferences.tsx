"use client";

import { useEffect, useState, useCallback } from "react";
import { Label } from "@/components/ui/label";

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/notifications/preferences")
      .then((res) => res.json())
      .then((data) => {
        setPrefs(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const toggle = useCallback(
    async (key: keyof Preferences) => {
      if (!prefs) return;
      const newValue = !prefs[key];
      // Optimistic update
      setPrefs({ ...prefs, [key]: newValue });
      setSaving(key);

      try {
        const res = await fetch("/api/notifications/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: newValue }),
        });
        if (res.ok) {
          const updated = await res.json();
          setPrefs(updated);
        } else {
          // Revert on error
          setPrefs({ ...prefs, [key]: !newValue });
        }
      } catch {
        // Revert on error
        setPrefs({ ...prefs, [key]: !newValue });
      } finally {
        setSaving(null);
      }
    },
    [prefs]
  );

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        Loading preferences...
      </div>
    );
  }

  if (!prefs) {
    return (
      <div className="text-sm text-red-500 py-4">
        Failed to load notification preferences.
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
            aria-checked={prefs[key]}
            onClick={() => toggle(key)}
            disabled={saving === key}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
              prefs[key] ? "bg-blue-600" : "bg-gray-200"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                prefs[key] ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      ))}
    </div>
  );
}
