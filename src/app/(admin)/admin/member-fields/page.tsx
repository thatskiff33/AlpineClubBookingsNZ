"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Save, UserCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MEMBER_FIELD_DEFINITIONS,
  MEMBER_FIELD_KEYS,
  type MemberFieldKey,
  type MemberFieldsSettingsValues,
} from "@/config/member-fields";

interface FieldsResponse {
  settings: MemberFieldsSettingsValues;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

function cloneSettings(
  settings: MemberFieldsSettingsValues,
): MemberFieldsSettingsValues {
  return Object.fromEntries(
    MEMBER_FIELD_KEYS.map((key) => [key, settings[key]]),
  ) as MemberFieldsSettingsValues;
}

export default function AdminMemberFieldsPage() {
  const [payload, setPayload] = useState<FieldsResponse | null>(null);
  const [draft, setDraft] = useState<MemberFieldsSettingsValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  async function loadSettings() {
    setLoading(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/member-fields", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as
        | FieldsResponse
        | { error?: string };
      if (!response.ok || !("settings" in body)) {
        throw new Error(responseErrorMessage(body, "Failed to load settings"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load settings",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  const dirty =
    payload !== null &&
    draft !== null &&
    MEMBER_FIELD_KEYS.some((key) => payload.settings[key] !== draft[key]);

  function setFieldEnabled(key: MemberFieldKey, enabled: boolean) {
    setDraft((current) =>
      current ? { ...current, [key]: enabled } : current,
    );
    setSavedMessage("");
  }

  async function saveSettings() {
    if (!draft) return;

    setSaving(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/member-fields", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: draft }),
      });
      const body = (await response.json()) as
        | FieldsResponse
        | { error?: string };
      if (!response.ok || !("settings" in body)) {
        throw new Error(responseErrorMessage(body, "Failed to save settings"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
      setSavedMessage("Member field settings saved.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save settings",
      );
    } finally {
      setSaving(false);
    }
  }

  const fields = useMemo(
    () => MEMBER_FIELD_KEYS.map((key) => MEMBER_FIELD_DEFINITIONS[key]),
    [],
  );

  if (loading && !payload) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Member fields</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Choose which optional member fields the club collects and displays.
            Turn a field off to avoid collecting data the club does not need.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadSettings()}
            disabled={loading || saving}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button
            type="button"
            onClick={() => void saveSettings()}
            disabled={!dirty || saving || draft === null}
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save
          </Button>
        </div>
      </div>

      {(error || savedMessage) && (
        <div
          className={
            error
              ? "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              : "rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          }
        >
          {error || savedMessage}
        </div>
      )}

      <div className="rounded-md border border-slate-200 bg-white px-4 py-3">
        <div className="flex items-start gap-3">
          <UserCog className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
          <p className="text-sm text-slate-600">
            When a field is off it is hidden from the member editor, member
            onboarding and profile, and is excluded from CSV import and export.
            Existing data already stored is not deleted.
          </p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {fields.map((field) => {
          const checkboxId = `member-field-${field.key}`;
          const enabled = draft?.[field.key] ?? false;

          return (
            <Card key={field.key}>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <Checkbox
                    id={checkboxId}
                    checked={enabled}
                    onCheckedChange={(checked) =>
                      setFieldEnabled(field.key, checked === true)
                    }
                    disabled={saving}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">
                        <label htmlFor={checkboxId}>{field.label}</label>
                      </CardTitle>
                      <Badge variant={enabled ? "success" : "secondary"}>
                        {enabled ? "On" : "Off"}
                      </Badge>
                    </div>
                    <CardDescription className="mt-1">
                      {field.description}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent />
            </Card>
          );
        })}
      </div>
    </div>
  );
}
