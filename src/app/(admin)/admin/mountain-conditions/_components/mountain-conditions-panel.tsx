"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Download,
  Eye,
  LoaderCircle,
  RotateCcw,
  Save,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  coerceWhakapapaSourceConfig,
  emptyWhakapapaCurlData,
  emptyWhakapapaSectionVisibility,
  emptyWhakapapaSourceConfig,
  resolveWhakapapaSelectors,
  validateWhakapapaSourceUrl,
  WHAKAPAPA_DEFAULT_SELECTORS,
  WHAKAPAPA_SELECTOR_KEYS,
  WHAKAPAPA_SELECTOR_LABELS,
  type WhakapapaCurlData,
  type WhakapapaSectionVisibility,
  type WhakapapaSelectorKey,
  type WhakapapaSourceConfig,
} from "@/lib/whakapapa-report";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

const VISIBILITY_SECTIONS: {
  key: keyof WhakapapaSectionVisibility;
  label: string;
}[] = [
  { key: "roadStatus", label: "Road Status" },
  { key: "lifts", label: "Lifts" },
  { key: "facilities", label: "Facilities" },
  { key: "foodAndDrink", label: "Food & Drink" },
  { key: "conditions", label: "Mountain Conditions" },
  { key: "trails", label: "Trails" },
];

type AdminMountainConditionsRecord = {
  source: string;
  payload: WhakapapaCurlData;
  config: WhakapapaSourceConfig;
  fetchedAt: string;
  frozenUntil: string | null;
  updatedAt: string;
};

type ApiResponse = {
  record: AdminMountainConditionsRecord | null;
  message?: string;
  error?: string;
};

type PreviewResponse = {
  preview?: WhakapapaCurlData;
  message?: string;
  error?: string;
};

function configToForm(config: WhakapapaSourceConfig | undefined) {
  const base = config ?? emptyWhakapapaSourceConfig();
  const overrides = {} as Record<WhakapapaSelectorKey, string>;
  for (const key of WHAKAPAPA_SELECTOR_KEYS) {
    overrides[key] = base.selectorOverrides[key] ?? "";
  }
  return { sourceUrl: base.sourceUrl, overrides };
}

// Fetch, freeze and update stamps are real INSTANTS, shown in the club's
// persisted zone rather than the viewer's (CT-4, #2870; INV-CONFIG-002).
function formatDateTime(
  clubTime: BoundClubTime,
  value: string | null | undefined,
) {
  const instant = value ? parseInstant(value) : null;
  if (instant === null) {
    return "Not set";
  }

  return clubTime.instantDateTime(instant);
}

function prettyJson(value: WhakapapaCurlData) {
  return JSON.stringify(value, null, 2);
}

export function MountainConditionsPanel() {
  const clubTime = useClubTime();
  const canEdit = useAdminAreaEditAccess("content");
  const [forbidden, setForbidden] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [rawJson, setRawJson] = useState("");
  const [record, setRecord] = useState<AdminMountainConditionsRecord | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [visibility, setVisibility] = useState<WhakapapaSectionVisibility>(
    emptyWhakapapaSectionVisibility(),
  );
  const [sourceUrl, setSourceUrl] = useState(
    emptyWhakapapaSourceConfig().sourceUrl,
  );
  const [selectorOverrides, setSelectorOverrides] = useState<
    Record<WhakapapaSelectorKey, string>
  >(() => configToForm(undefined).overrides);
  const [savingConfig, setSavingConfig] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [showSelectors, setShowSelectors] = useState(false);
  const [previewJson, setPreviewJson] = useState<string | null>(null);
  const [exportingConfig, setExportingConfig] = useState(false);
  const [importingConfig, setImportingConfig] = useState(false);
  const [error, setError] = useState<string>("");
  const importInputRef = useRef<HTMLInputElement>(null);
  // Sampled whenever the record is (re)loaded so the frozen check below can
  // stay pure during render (Date.now() must not run mid-render).
  const [recordSyncedAt, setRecordSyncedAt] = useState(0);

  const loadRecord = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/mountain-conditions");
      const body = (await response.json()) as ApiResponse;
      if (!response.ok) {
        throw new Error(body.error || "Failed to load mountain conditions");
      }

      const nextRecord = body.record;
      setRecord(nextRecord);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(nextRecord?.payload ?? emptyWhakapapaCurlData()));
      setVisibility(
        nextRecord?.payload.visibility ?? emptyWhakapapaSectionVisibility(),
      );
      const form = configToForm(nextRecord?.config);
      setSourceUrl(form.sourceUrl);
      setSelectorOverrides(form.overrides);
    } catch (loadError) {
      setRecord(null);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(emptyWhakapapaCurlData()));
      setVisibility(emptyWhakapapaSectionVisibility());
      const form = configToForm(undefined);
      setSourceUrl(form.sourceUrl);
      setSelectorOverrides(form.overrides);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load mountain conditions",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecord();
  }, [loadRecord]);

  async function saveRecord() {
    setSaving(true);
    setError("");
    setForbidden(false);
    try {
      const response = await fetch("/api/admin/mountain-conditions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawJson }),
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok) {
        if (response.status === 403) setForbidden(true);
        throw new Error(body.error || "Failed to save mountain conditions");
      }

      setRecord(body.record);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(body.record?.payload ?? emptyWhakapapaCurlData()));
      setVisibility(
        body.record?.payload.visibility ?? emptyWhakapapaSectionVisibility(),
      );
      toast.success(body.message || "Mountain conditions saved");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save mountain conditions",
      );
      toast.error("Mountain conditions save failed");
    } finally {
      setSaving(false);
    }
  }

  async function refreshFromUpstream() {
    setRefreshing(true);
    setError("");
    setForbidden(false);
    try {
      const response = await fetch("/api/admin/mountain-conditions", {
        method: "POST",
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok) {
        if (response.status === 403) setForbidden(true);
        throw new Error(body.error || "Failed to refresh mountain conditions");
      }

      setRecord(body.record);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(body.record?.payload ?? emptyWhakapapaCurlData()));
      setVisibility(
        body.record?.payload.visibility ?? emptyWhakapapaSectionVisibility(),
      );
      toast.success(body.message || "Mountain conditions refreshed");
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Failed to refresh mountain conditions",
      );
      toast.error("Mountain conditions refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function saveVisibility() {
    setSavingVisibility(true);
    setError("");
    setForbidden(false);
    try {
      const response = await fetch("/api/admin/mountain-conditions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok) {
        if (response.status === 403) setForbidden(true);
        throw new Error(body.error || "Failed to save section visibility");
      }

      setRecord(body.record);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(body.record?.payload ?? emptyWhakapapaCurlData()));
      setVisibility(
        body.record?.payload.visibility ?? emptyWhakapapaSectionVisibility(),
      );
      toast.success(body.message || "Section visibility saved");
    } catch (visibilityError) {
      setError(
        visibilityError instanceof Error
          ? visibilityError.message
          : "Failed to save section visibility",
      );
      toast.error("Section visibility save failed");
    } finally {
      setSavingVisibility(false);
    }
  }

  function buildConfigPayload(): WhakapapaSourceConfig {
    const overrides: Partial<Record<WhakapapaSelectorKey, string>> = {};
    for (const key of WHAKAPAPA_SELECTOR_KEYS) {
      const value = selectorOverrides[key]?.trim();
      if (value) {
        overrides[key] = value;
      }
    }
    return { sourceUrl: sourceUrl.trim(), selectorOverrides: overrides };
  }

  async function exportConfig() {
    setExportingConfig(true);
    setError("");
    try {
      // Read the current config straight from the database so the export
      // reflects what is stored, not any unsaved edits in the form.
      const response = await fetch("/api/admin/mountain-conditions");
      const body = (await response.json()) as ApiResponse;
      if (!response.ok) {
        throw new Error(
          body.error || "Failed to read the stored configuration",
        );
      }

      const config = body.record?.config ?? emptyWhakapapaSourceConfig();
      // Export the FULL resolved selector set (defaults filled in for any key
      // not overridden), so the file is a complete, self-contained vocabulary.
      const file = {
        type: "whakapapa-mountain-conditions-selectors",
        version: 1,
        exportedAt: new Date().toISOString(),
        sourceUrl: config.sourceUrl,
        selectorOverrides: resolveWhakapapaSelectors(config.selectorOverrides),
      };
      const blob = new Blob([JSON.stringify(file, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "whakapapa-mountain-conditions-selectors.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success("Selector configuration exported from the database.");
    } catch (exportError) {
      setError(
        exportError instanceof Error
          ? exportError.message
          : "Failed to export configuration",
      );
      toast.error("Export failed");
    } finally {
      setExportingConfig(false);
    }
  }

  async function importConfigFromFile(file: File) {
    setImportingConfig(true);
    setError("");
    setForbidden(false);
    try {
      const parsed = JSON.parse(await file.text());

      // Reuse the shared coercion so only known selector keys with non-empty
      // string values are accepted (unknown/garbage keys are dropped).
      const coerced = coerceWhakapapaSourceConfig(parsed);
      const importedCount = Object.keys(coerced.selectorOverrides).length;
      if (importedCount === 0) {
        toast.error("No recognised selector fields were found in that file.");
        return;
      }

      // Persist the FULL set (imported values, with defaults filling any gap),
      // so importing writes the complete selector vocabulary to the database.
      const fullSelectors = resolveWhakapapaSelectors(
        coerced.selectorOverrides,
      );
      // Only take the file's URL when it explicitly carries a valid one; a
      // selectors-only file keeps the currently stored Report URL.
      const rawUrl =
        parsed && typeof parsed === "object"
          ? (parsed as { sourceUrl?: unknown }).sourceUrl
          : undefined;
      const urlCheck = validateWhakapapaSourceUrl(rawUrl);
      const sourceUrlToUse = urlCheck.ok ? urlCheck.url : sourceUrl.trim();

      await persistConfig({
        sourceUrl: sourceUrlToUse,
        selectorOverrides: fullSelectors,
      });

      setShowSelectors(true);
      toast.success(
        `Imported ${importedCount} selector${importedCount === 1 ? "" : "s"} and saved to the database.`,
      );
    } catch (importError) {
      if (importError instanceof SyntaxError) {
        toast.error("Could not import selectors: the file is not valid JSON.");
      } else {
        setError(
          importError instanceof Error
            ? importError.message
            : "Failed to import selectors",
        );
        toast.error("Import failed");
      }
    } finally {
      setImportingConfig(false);
    }
  }

  function handleImportFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so selecting the same file again still fires onChange.
    event.target.value = "";
    if (file) {
      void importConfigFromFile(file);
    }
  }

  // Writes a config to the database (the SSRF-guarded PATCH) and mirrors the
  // saved row back into the form. Shared by Save, Import, and any DB write.
  async function persistConfig(config: WhakapapaSourceConfig): Promise<string> {
    const response = await fetch("/api/admin/mountain-conditions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    const body = (await response.json()) as ApiResponse;
    if (!response.ok) {
      if (response.status === 403) setForbidden(true);
      throw new Error(body.error || "Failed to save source configuration");
    }

    setRecord(body.record);
    setRecordSyncedAt(Date.now());
    const form = configToForm(body.record?.config);
    setSourceUrl(form.sourceUrl);
    setSelectorOverrides(form.overrides);
    return body.message || "Source configuration saved";
  }

  async function saveConfig() {
    setSavingConfig(true);
    setError("");
    setForbidden(false);
    try {
      const message = await persistConfig(buildConfigPayload());
      toast.success(message);
    } catch (configError) {
      setError(
        configError instanceof Error
          ? configError.message
          : "Failed to save source configuration",
      );
      toast.error("Source configuration save failed");
    } finally {
      setSavingConfig(false);
    }
  }

  async function previewConfig() {
    setPreviewing(true);
    setError("");
    setForbidden(false);
    setPreviewJson(null);
    try {
      const response = await fetch("/api/admin/mountain-conditions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preview: true, config: buildConfigPayload() }),
      });
      const body = (await response.json()) as PreviewResponse;
      if (!response.ok) {
        if (response.status === 403) setForbidden(true);
        throw new Error(body.error || "Preview failed");
      }

      setPreviewJson(body.preview ? prettyJson(body.preview) : "");
      toast.success(body.message || "Preview generated");
    } catch (previewError) {
      setError(
        previewError instanceof Error ? previewError.message : "Preview failed",
      );
      toast.error("Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  const frozenUntil = record?.frozenUntil ?? null;
  const isFrozen = Boolean(
    frozenUntil && new Date(frozenUntil).getTime() > recordSyncedAt,
  );

  /*
    #2160: the view-only explanation lives here, once, at the top of the panel —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. That is why it is hoisted above the
    loading early-return and rendered in both branches. The wrapper itself
    renders no box and takes no layout, so an edit-capable admin pays nothing.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view mountain conditions but cannot change them.
    </AdminViewOnlySectionBanner>
  );

  if (loading) {
    return (
      <>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">
          Loading mountain conditions...
        </p>
      </>
    );
  }

  return (
    <>
      {viewOnlyBanner}
      {forbidden ? <AdminForbiddenSaveNotice className="mb-4" /> : null}
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setHelpOpen(true)}
          aria-label="Mountain Conditions help"
          title="Mountain Conditions help"
        >
          <CircleHelp className="h-4 w-4" />
        </Button>
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          type="button"
          variant="outline"
          onClick={refreshFromUpstream}
          disabled={refreshing || saving}
        >
          {refreshing ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          {refreshing ? "Refreshing..." : "Update from upstream"}
        </ViewOnlyActionButton>
      </div>

      {error ? (
        <div className="mb-4 rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
          {error}
        </div>
      ) : null}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Section visibility</CardTitle>
          <CardDescription>
            Choose which articles appear on the public Whakapapa Conditions
            widget. Unticked sections are hidden from visitors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {VISIBILITY_SECTIONS.map((section) => (
              <label
                key={section.key}
                htmlFor={`visibility-${section.key}`}
                className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
              >
                <Checkbox
                  id={`visibility-${section.key}`}
                  checked={visibility[section.key]}
                  onCheckedChange={(checked) =>
                    setVisibility((current) => ({
                      ...current,
                      [section.key]: checked,
                    }))
                  }
                  disabled={savingVisibility || !canEdit}
                />
                {section.label}
              </label>
            ))}
          </div>

          <div className="flex justify-end">
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              onClick={saveVisibility}
              disabled={savingVisibility}
            >
              {savingVisibility ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {savingVisibility ? "Saving..." : "Save visibility"}
            </ViewOnlyActionButton>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Raw JSON</CardTitle>
              <CardDescription>
                Edit the stored Whakapapa JSON payload directly, then save it to
                pause automatic refreshes for 12 hours.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              {isFrozen ? (
                <Badge className="border-warning-6 bg-warning-3 text-warning-11">
                  Auto refresh paused
                </Badge>
              ) : (
                <Badge variant="outline">Auto refresh active</Badge>
              )}
              <Badge variant="outline">
                Last fetched: {formatDateTime(clubTime, record?.fetchedAt)}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={rawJson}
            onChange={(event) => setRawJson(event.target.value)}
            className="min-h-[520px] font-mono text-xs"
            spellCheck={false}
            readOnly={!canEdit}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <div className="space-y-1">
              <p>Frozen until: {formatDateTime(clubTime, frozenUntil)}</p>
              <p>Last updated in DB: {formatDateTime(clubTime, record?.updatedAt)}</p>
            </div>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              onClick={saveRecord}
              disabled={saving || refreshing}
            >
              {saving ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? "Saving..." : "Save"}
            </ViewOnlyActionButton>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Source &amp; selectors</CardTitle>
          <CardDescription>
            The report URL the site scrapes, plus optional selector overrides
            for when the upstream page structure changes. Leave a selector blank
            to use the built-in default. Use <b>Preview</b> to test before
            saving — nothing is stored until you click <b>Save configuration</b>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="whakapapa-source-url">Report URL</Label>
            <Input
              id="whakapapa-source-url"
              type="url"
              inputMode="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder={emptyWhakapapaSourceConfig().sourceUrl}
              readOnly={!canEdit}
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Must be an https URL on whakapapa.com or snow.nz.
            </p>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowSelectors((open) => !open)}
              className="flex items-center gap-1 text-sm font-medium text-foreground"
              aria-expanded={showSelectors}
            >
              {showSelectors ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              Advanced: element selectors
            </button>
            {showSelectors ? (
              <>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {WHAKAPAPA_SELECTOR_KEYS.map((key) => (
                    <div key={key} className="space-y-1">
                      <Label
                        htmlFor={`selector-${key}`}
                        className="text-xs text-muted-foreground"
                      >
                        {WHAKAPAPA_SELECTOR_LABELS[key]}
                      </Label>
                      <Input
                        id={`selector-${key}`}
                        value={selectorOverrides[key] ?? ""}
                        onChange={(event) =>
                          setSelectorOverrides((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                        placeholder={WHAKAPAPA_DEFAULT_SELECTORS[key]}
                        readOnly={!canEdit}
                        spellCheck={false}
                        className="font-mono text-xs"
                      />
                    </div>
                  ))}
                </div>

                <div className="mt-3 rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={exportConfig}
                      disabled={exportingConfig || importingConfig}
                    >
                      {exportingConfig ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      Export selectors
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => importInputRef.current?.click()}
                      disabled={!canEdit || importingConfig || exportingConfig}
                    >
                      {importingConfig ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      Import selectors
                    </Button>
                    <input
                      ref={importInputRef}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={handleImportFileChange}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Export reads the stored Report URL and full selector set
                    from the database and saves them to a JSON file. Import
                    loads such a file and <b>saves it to the database</b>, so
                    another site&rsquo;s admin does not have to re-enter the
                    values by hand.
                  </p>
                </div>
              </>
            ) : null}
          </div>

          {previewJson !== null ? (
            <div className="space-y-2">
              <Label htmlFor="whakapapa-preview">Preview result</Label>
              <Textarea
                id="whakapapa-preview"
                value={previewJson || "No data parsed with these settings."}
                readOnly
                className="min-h-[240px] font-mono text-xs"
                spellCheck={false}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              variant="outline"
              onClick={previewConfig}
              disabled={previewing || savingConfig}
            >
              {previewing ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
              {previewing ? "Previewing..." : "Preview"}
            </ViewOnlyActionButton>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              type="button"
              onClick={saveConfig}
              disabled={savingConfig || previewing}
            >
              {savingConfig ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {savingConfig ? "Saving..." : "Save configuration"}
            </ViewOnlyActionButton>
          </div>
        </CardContent>
      </Card>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Mountain Conditions help</DialogTitle>
            <DialogDescription>
              This screen edits the cached Whakapapa JSON payload that powers
              the public mountain conditions display.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm leading-6 text-muted-foreground">
            <p>
              <i>
                <b>Save</b>
              </i>{" "}
              stores the raw JSON from the editor into the database and pauses
              automatic upstream updates for 12 hours.
            </p>
            <p>
              <i>
                <b>Update from upstream</b>
              </i>{" "}
              ignores the freeze window, fetches the latest JSON from Whakapapa,
              stores it in the database, and resumes normal automatic refresh
              behaviour.
            </p>
            <p>
              The public page uses the same cached data, so changes here will
              flow through to the website immediately after saving or
              refreshing.
            </p>
            <p>
              <i>
                <b>Section visibility</b>
              </i>{" "}
              controls which articles appear on the public widget. Unticked
              sections are hidden from visitors, and the choices are preserved
              across automatic and manual upstream refreshes.
            </p>
            <p>
              <i>
                <b>Source &amp; selectors</b>
              </i>{" "}
              sets the report URL the site scrapes (locked to whakapapa.com /
              snow.nz) and, under <b>Advanced</b>, optional selector overrides
              for when the upstream page structure changes. Blank selectors use
              the built-in defaults, which already ignore the rotating
              style-name suffixes. <b>Preview</b> tests the current URL and
              selectors without saving; <b>Save configuration</b> stores them
              separately from the cached data, so an upstream refresh never
              wipes them.
            </p>
            <p>
              Under <b>Advanced</b>, <i>Export selectors</i> reads the stored
              URL and the full selector set from the database and downloads them
              as a JSON file, and <i>Import selectors</i> loads such a file and
              saves it straight to the database — so another site&rsquo;s admin
              can reuse a known-good configuration instead of re-entering it.
              The built-in defaults are seeded into the database, so a fresh
              site already has the complete set.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
