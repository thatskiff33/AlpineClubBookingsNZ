"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  ADMIN_NOTIFICATION_PREFERENCE_META,
  type AdminNotificationPreferenceKey,
  type AdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";

interface AdminNotificationUser {
  id: string;
  name: string;
  email: string;
  preferences: AdminNotificationPreferences;
}

export function AdminNotificationSettings({
  initialAdmins,
}: {
  initialAdmins: AdminNotificationUser[];
}) {
  const [admins, setAdmins] = useState(initialAdmins);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const updatePreference = async (
    memberId: string,
    key: AdminNotificationPreferenceKey,
    value: boolean
  ) => {
    const pendingKey = `${memberId}:${key}`;
    const currentAdmin = admins.find((admin) => admin.id === memberId);
    if (!currentAdmin) return;

    const previousValue = currentAdmin.preferences[key];
    setSavingKey(pendingKey);
    setAdmins((current) =>
      current.map((admin) =>
        admin.id === memberId
          ? {
              ...admin,
              preferences: { ...admin.preferences, [key]: value },
            }
          : admin
      )
    );

    try {
      const response = await fetch("/api/admin/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId,
          preferences: { [key]: value },
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error ?? "Failed to update notification preferences");
      }

      setAdmins((current) =>
        current.map((admin) =>
          admin.id === memberId
            ? {
                ...admin,
                preferences: data.preferences as AdminNotificationPreferences,
              }
            : admin
        )
      );
    } catch (error) {
      setAdmins((current) =>
        current.map((admin) =>
          admin.id === memberId
            ? {
                ...admin,
                preferences: { ...admin.preferences, [key]: previousValue },
              }
            : admin
        )
      );
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update notification preferences"
      );
    } finally {
      setSavingKey(null);
    }
  };

  if (admins.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
        No active admin users found.
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {admins.map((admin) => {
        const adminSaving = savingKey?.startsWith(`${admin.id}:`);

        return (
          <Card key={admin.id} className="border-slate-200 shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">{admin.name}</CardTitle>
              <CardDescription className="flex items-center justify-between gap-2">
                <span>{admin.email}</span>
                {adminSaving && (
                  <span className="text-xs font-medium text-blue-600">Saving...</span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {ADMIN_NOTIFICATION_PREFERENCE_KEYS.map((key) => {
                const meta = ADMIN_NOTIFICATION_PREFERENCE_META[key];
                const controlId = `${admin.id}-${key}`;

                return (
                  <div
                    key={key}
                    className="flex items-start gap-3 rounded-lg border border-slate-200 p-3"
                  >
                    <Checkbox
                      id={controlId}
                      checked={admin.preferences[key]}
                      disabled={savingKey === controlId}
                      onCheckedChange={(checked) =>
                        updatePreference(admin.id, key, checked === true)
                      }
                    />
                    <div className="space-y-1">
                      <Label htmlFor={controlId} className="cursor-pointer text-sm font-medium">
                        {meta.label}
                      </Label>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {meta.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
