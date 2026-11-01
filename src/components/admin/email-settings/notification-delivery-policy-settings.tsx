"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { AdminViewOnlyNotice } from "@/components/admin/view-only-action";
import type { NotificationDeliveryModeValue } from "@/lib/email-message-registry";

interface Policy {
  templateName: string;
  label: string;
  mode: NotificationDeliveryModeValue;
  defaultMode: NotificationDeliveryModeValue;
  deliveryEditable: boolean;
}

const modeLabels: Record<NotificationDeliveryModeValue, string> = {
  always: "Always send",
  content_only: "Only when content exists",
  disabled: "Do not email",
};

export function NotificationDeliveryPolicySettings({
  initialPolicies,
  initialStalePolicyCount = 0,
}: {
  initialPolicies: Policy[];
  initialStalePolicyCount?: number;
}) {
  const [policies, setPolicies] = useState(initialPolicies);
  const [stalePolicyCount] = useState(initialStalePolicyCount);
  const [savingTemplate, setSavingTemplate] = useState<string | null>(null);
  // Delivery policies live under Support & System (the write route enforces
  // support:edit). The mode Select autosaves on change, so it must be disabled
  // for a support:view admin or it would silently 403 (#1940).
  const canEdit = useAdminAreaEditAccess("support");

  async function updatePolicy(
    templateName: string,
    mode: NotificationDeliveryModeValue,
  ) {
    const previous = policies;
    setPolicies((current) =>
      current.map((policy) =>
        policy.templateName === templateName ? { ...policy, mode } : policy,
      ),
    );
    setSavingTemplate(templateName);
    try {
      const response = await fetch("/api/admin/notification-delivery-policies", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateName, mode }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to update delivery policy");
      }
      toast.success("Delivery policy updated");
    } catch (error) {
      setPolicies(previous);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update delivery policy",
      );
    } finally {
      setSavingTemplate(null);
    }
  }

  return (
    <div className="space-y-4">
      {!canEdit ? (
        <AdminViewOnlyNotice canEdit={canEdit}>
          Your admin role can view notification delivery rules but cannot change
          them. Support &amp; System edit access is required.
        </AdminViewOnlyNotice>
      ) : null}
      {stalePolicyCount > 0 ? (
        <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          {stalePolicyCount} stale delivery rule
          {stalePolicyCount === 1 ? "" : "s"} need database cleanup.
        </div>
      ) : null}
      <div className="divide-y divide-border">
        {policies.map((policy) => (
          <div
            key={policy.templateName}
            className="py-4 first:pt-0 last:pb-0"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Label className="text-sm font-medium text-foreground">
                  {policy.label}
                </Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Default: {modeLabels[policy.defaultMode]}
                </p>
              </div>
              {policy.deliveryEditable ? (
                <Select
                  value={policy.mode}
                  disabled={savingTemplate === policy.templateName || !canEdit}
                  onValueChange={(value) =>
                    updatePolicy(
                      policy.templateName,
                      value as NotificationDeliveryModeValue,
                    )
                  }
                >
                  <SelectTrigger className="w-full sm:w-56" aria-label={`Delivery for ${policy.label}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">Always send</SelectItem>
                    <SelectItem value="content_only">
                      Only when content exists
                    </SelectItem>
                    <SelectItem value="disabled">Do not email</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  Locked
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
