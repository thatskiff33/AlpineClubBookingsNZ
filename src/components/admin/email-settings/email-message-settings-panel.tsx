"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface EmailSettings {
  clubName: string;
  bookingsName: string;
  lodgeName: string;
  emailFromName: string;
  supportEmail: string;
  contactEmail: string;
  publicUrl: string;
  lodgeTravelNote: string;
  doorCode: string | null;
}

interface TemplateOverride {
  subject: string | null;
  bodyText: string | null;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

interface TemplateDefinition {
  key: string;
  label: string;
  audience: string;
  defaultSubject: string;
  defaultBody: string;
  allowedTokens: string[];
  requiredTokens: string[];
  triggerSummary: string;
  frequency: string;
  override: TemplateOverride | null;
}

const settingFields: Array<{
  key: keyof EmailSettings;
  label: string;
  multiline?: boolean;
}> = [
  { key: "clubName", label: "Club name" },
  { key: "bookingsName", label: "Bookings name" },
  { key: "lodgeName", label: "Lodge name" },
  { key: "emailFromName", label: "Sender display name" },
  { key: "supportEmail", label: "Support email" },
  { key: "contactEmail", label: "Contact email" },
  { key: "publicUrl", label: "Public URL" },
  { key: "lodgeTravelNote", label: "Lodge travel note", multiline: true },
  { key: "doorCode", label: "Door code" },
];

export function EmailMessageSettingsPanel() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [templates, setTemplates] = useState<TemplateDefinition[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewSubject, setPreviewSubject] = useState("");
  const [staleOverrideCount, setStaleOverrideCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const currentTemplate = useMemo(
    () => templates.find((template) => template.key === selectedTemplate) ?? null,
    [selectedTemplate, templates],
  );

  async function load() {
    setLoading(true);
    try {
      const [settingsResponse, templatesResponse] = await Promise.all([
        fetch("/api/admin/email-settings", { credentials: "same-origin" }),
        fetch("/api/admin/email-templates", { credentials: "same-origin" }),
      ]);
      const settingsBody = await settingsResponse.json();
      const templatesBody = await templatesResponse.json();
      if (!settingsResponse.ok) {
        throw new Error(settingsBody?.error ?? "Failed to load email settings");
      }
      if (!templatesResponse.ok) {
        throw new Error(templatesBody?.error ?? "Failed to load email templates");
      }
      const nextTemplates = templatesBody.templates as TemplateDefinition[];
      setSettings(settingsBody.settings);
      setTemplates(nextTemplates);
      setStaleOverrideCount(templatesBody.staleOverrideCount ?? 0);
      const firstTemplate = selectedTemplate || nextTemplates[0]?.key || "";
      setSelectedTemplate(firstTemplate);
      const selected = nextTemplates.find((template) => template.key === firstTemplate);
      if (selected) {
        setSubject(selected.override?.subject ?? selected.defaultSubject);
        setBodyText(selected.override?.bodyText ?? selected.defaultBody);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load email settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectTemplate(key: string) {
    const template = templates.find((entry) => entry.key === key);
    setSelectedTemplate(key);
    setSubject(template?.override?.subject ?? template?.defaultSubject ?? "");
    setBodyText(template?.override?.bodyText ?? template?.defaultBody ?? "");
    setPreviewHtml("");
    setPreviewSubject("");
  }

  async function saveSettings() {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const response = await fetch("/api/admin/email-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to save email settings");
      }
      setSettings(body.settings);
      toast.success("Email settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save email settings");
    } finally {
      setSavingSettings(false);
    }
  }

  async function saveTemplate() {
    if (!currentTemplate) return;
    setSavingTemplate(true);
    try {
      const response = await fetch("/api/admin/email-templates", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateName: currentTemplate.key,
          subject,
          bodyText,
        }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(responseBody?.error ?? "Failed to save email template");
      }
      toast.success("Email template saved");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save email template");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function resetTemplate() {
    if (!currentTemplate) return;
    setSavingTemplate(true);
    try {
      const response = await fetch("/api/admin/email-templates/reset", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateName: currentTemplate.key }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(responseBody?.error ?? "Failed to reset email template");
      }
      setSubject(currentTemplate.defaultSubject);
      setBodyText(currentTemplate.defaultBody);
      toast.success("Email template reset");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reset email template");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function previewTemplate() {
    if (!currentTemplate) return;
    try {
      const response = await fetch("/api/admin/email-templates/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateName: currentTemplate.key,
          subject,
          bodyText,
        }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(responseBody?.error ?? "Failed to preview email template");
      }
      setPreviewSubject(responseBody.subject);
      setPreviewHtml(responseBody.html);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to preview email template");
    }
  }

  if (loading || !settings) {
    return <p className="text-sm text-slate-500">Loading email settings</p>;
  }

  return (
    <div className="space-y-8">
      {staleOverrideCount > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {staleOverrideCount} stale template override
          {staleOverrideCount === 1 ? "" : "s"} need database cleanup.
        </div>
      ) : null}
      <section className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {settingFields.map((field) => (
            <div key={field.key} className={field.multiline ? "md:col-span-2" : ""}>
              <Label htmlFor={`email-setting-${field.key}`}>{field.label}</Label>
              {field.multiline ? (
                <Textarea
                  id={`email-setting-${field.key}`}
                  className="mt-1 min-h-24"
                  value={settings[field.key] ?? ""}
                  onChange={(event) =>
                    setSettings((current) =>
                      current
                        ? { ...current, [field.key]: event.target.value }
                        : current,
                    )
                  }
                />
              ) : (
                <Input
                  id={`email-setting-${field.key}`}
                  className="mt-1"
                  value={settings[field.key] ?? ""}
                  onChange={(event) =>
                    setSettings((current) =>
                      current
                        ? { ...current, [field.key]: event.target.value }
                        : current,
                    )
                  }
                />
              )}
            </div>
          ))}
        </div>
        <Button onClick={saveSettings} disabled={savingSettings}>
          <Save className="h-4 w-4" />
          {savingSettings ? "Saving" : "Save Email Settings"}
        </Button>
      </section>

      <section className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <div>
            <Label htmlFor="email-template-select">Template</Label>
            <Select value={selectedTemplate} onValueChange={selectTemplate}>
              <SelectTrigger id="email-template-select" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {templates.map((template) => (
                  <SelectItem key={template.key} value={template.key}>
                    {template.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {currentTemplate ? (
            <div className="space-y-2 text-sm text-slate-600">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{currentTemplate.audience}</Badge>
                <Badge variant="outline">{currentTemplate.key}</Badge>
              </div>
              <p>{currentTemplate.triggerSummary}</p>
              <p>{currentTemplate.frequency}</p>
            </div>
          ) : null}
        </div>

        {currentTemplate ? (
          <div className="space-y-2">
            <Label>Tokens</Label>
            <div className="flex flex-wrap gap-2">
              {currentTemplate.allowedTokens.map((token) => (
                <Badge
                  key={token}
                  variant={
                    currentTemplate.requiredTokens.includes(token)
                      ? "default"
                      : "outline"
                  }
                >
                  {`{{${token}}}`}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <Label htmlFor="email-template-subject">Subject</Label>
          <Input
            id="email-template-subject"
            className="mt-1"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="email-template-body">Body</Label>
          <Textarea
            id="email-template-body"
            className="mt-1 min-h-72 font-mono text-sm"
            value={bodyText}
            onChange={(event) => setBodyText(event.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={saveTemplate} disabled={savingTemplate || !currentTemplate}>
            <Save className="h-4 w-4" />
            {savingTemplate ? "Saving" : "Save Template"}
          </Button>
          <Button
            variant="outline"
            onClick={previewTemplate}
            disabled={!currentTemplate}
          >
            <Eye className="h-4 w-4" />
            Preview
          </Button>
          <Button
            variant="outline"
            onClick={resetTemplate}
            disabled={savingTemplate || !currentTemplate}
          >
            <RotateCcw className="h-4 w-4" />
            Restore Default
          </Button>
        </div>

        {previewHtml ? (
          <div className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
            <p className="text-sm font-medium text-slate-900">
              Subject: {previewSubject}
            </p>
            <iframe
              title="Email preview"
              className="h-[520px] w-full rounded-md border border-slate-200 bg-white"
              sandbox=""
              srcDoc={previewHtml}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
