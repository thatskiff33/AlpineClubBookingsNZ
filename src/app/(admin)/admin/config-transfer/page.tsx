"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { ArrowRightLeft, Download, Upload, AlertTriangle, ShieldAlert } from "lucide-react";

import { isFullAdmin } from "@/lib/access-roles";
import { useClubTime } from "@/components/club-time-provider";
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
  CONFIG_TRANSFER_CATEGORIES,
  type ConfigTransferCategory,
} from "@/lib/config-transfer/manifest";
import {
  formatConfigImportTotals,
  visibleImportPlanItems,
} from "@/lib/config-transfer/preview";

// Full-admin Configuration Export & Import page. Export selected categories to a
// portable zip; import a bundle via a mandatory dry-run before applying (the
// server takes a database backup). Validation errors BLOCK
// apply; key-weak renames are resolved via the match picker. docs/config-transfer.

const CATEGORY_LABELS: Record<ConfigTransferCategory, string> = {
  "site-content": "Site content & appearance",
  "club-settings": "Club settings",
  "lodge-config": "Lodge configuration",
  "booking-policies": "Booking policies",
  committee: "Committee (roles)",
  induction: "Induction checklists",
  "membership-fees": "Membership fees (joining & annual)",
  "xero-config": "Xero configuration",
};

type ImportMode = "merge" | "overwrite";

type PlanItem = {
  entity: string;
  key: string;
  action: "create" | "update" | "delete" | "unchanged";
  changedFields?: string[];
  candidates?: Array<{ id: string; label: string }>;
};

// Per-action styling so anything that will actually change stands out against
// the (usually long) list of unchanged rows.
const ACTION_BADGE: Record<PlanItem["action"], { label: string; badge: string }> = {
  create: { label: "New", badge: "bg-success-3 text-success-11" },
  update: { label: "Updated", badge: "bg-warning-3 text-warning-11" },
  delete: { label: "Deleted", badge: "bg-danger-3 text-danger-11" },
  unchanged: { label: "Unchanged", badge: "bg-muted text-muted-foreground" },
};
type CategoryPlan = {
  category: ConfigTransferCategory;
  items: PlanItem[];
  warnings: string[];
  errors: string[];
};
type ImportPlan = {
  categories: CategoryPlan[];
  fingerprint: string;
  doorCodesIncluded: boolean;
  doorCodeChanges: string[];
  selectedCategories: ConfigTransferCategory[];
  integrityWarnings: string[];
  errors: string[];
  xero: { sourceTenantId: string | null; targetTenantId: string | null; mismatch: boolean };
  summary: { create: number; update: number; delete: number; unchanged: number };
};
type Resolution = { entity: string; key: string; matchId: string };

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ConfigTransferPage() {
  // The exported bundle is stamped with the CLUB's PERSISTED day. Two operators
  // in different countries already got the same filename — the build's
  // `NEXT_PUBLIC_TZ` is fixed at build time, not read from the viewer. The
  // defect was that the shared answer could be the wrong day for the club
  // (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  const { data: session } = useSession();
  const fullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  const [selected, setSelected] = useState<Set<ConfigTransferCategory>>(
    () => new Set(["site-content", "club-settings", "lodge-config"]),
  );
  const [includeDoorCodes, setIncludeDoorCodes] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [importCategories, setImportCategories] = useState<ConfigTransferCategory[] | null>(null);
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [resealing, setResealing] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const canExport = useMemo(() => selected.size > 0, [selected]);

  if (session && !fullAdmin) {
    return (
      <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
        Configuration Export &amp; Import is available to full administrators only.
      </div>
    );
  }

  function toggle(category: ConfigTransferCategory) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  async function runExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/admin/config-transfer/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          categories: [...selected],
          includeDoorCodes,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Export failed.");
      }
      downloadBlob(
        await res.blob(),
        `config-transfer-${clubTime.today()}.zip`,
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  /** The dry-run is mode/selection/resolution-aware: re-preview on any change. */
  async function runPreview(overrides?: {
    mode?: ImportMode;
    categories?: ConfigTransferCategory[] | null;
    resolutions?: Resolution[];
  }) {
    if (!file) return;
    const useMode = overrides?.mode ?? mode;
    const useCategories =
      overrides?.categories !== undefined ? overrides.categories : importCategories;
    const useResolutions = overrides?.resolutions ?? resolutions;
    setPlanning(true);
    setImportError(null);
    setApplied(null);
    setPlan(null);
    try {
      const form = new FormData();
      form.append("bundle", file);
      form.append("mode", useMode);
      if (useCategories) form.append("categories", JSON.stringify(useCategories));
      if (useResolutions.length > 0) {
        form.append("resolutions", JSON.stringify(useResolutions));
      }
      const res = await fetch("/api/admin/config-transfer/plan", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => null)) as
        | { plan?: ImportPlan; error?: string }
        | null;
      if (!res.ok || !data?.plan) {
        throw new Error(data?.error ?? "Could not read the bundle.");
      }
      setPlan(data.plan);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setPlanning(false);
    }
  }

  function selectMode(next: ImportMode) {
    setMode(next);
    void runPreview({ mode: next });
  }

  function toggleImportCategory(category: ConfigTransferCategory) {
    if (!plan) return;
    const base = importCategories ?? plan.selectedCategories;
    const next = base.includes(category)
      ? base.filter((c) => c !== category)
      : [...base, category];
    setImportCategories(next);
    void runPreview({ categories: next });
  }

  function resolveMatch(entity: string, key: string, matchId: string) {
    const next = resolutions
      .filter((r) => !(r.entity === entity && r.key === key))
      .concat(matchId ? [{ entity, key, matchId }] : []);
    setResolutions(next);
    void runPreview({ resolutions: next });
  }

  async function runReseal() {
    if (!file) return;
    setResealing(true);
    setImportError(null);
    try {
      const form = new FormData();
      form.append("bundle", file);
      const res = await fetch("/api/admin/config-transfer/reseal", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Reseal failed.");
      }
      downloadBlob(
        await res.blob(),
        `config-transfer-resealed-${clubTime.today()}.zip`,
      );
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Reseal failed.");
    } finally {
      setResealing(false);
    }
  }

  async function runApply() {
    if (!file || !plan) return;
    setApplying(true);
    setImportError(null);
    try {
      const form = new FormData();
      form.append("bundle", file);
      form.append("expectedFingerprint", plan.fingerprint);
      form.append("mode", mode);
      if (importCategories) form.append("categories", JSON.stringify(importCategories));
      if (resolutions.length > 0) form.append("resolutions", JSON.stringify(resolutions));
      const res = await fetch("/api/admin/config-transfer/apply", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => null)) as
        | {
            result?: {
              totals: {
                created: number;
                updated: number;
                deleted: number;
                unchanged: number;
              };
            };
            error?: string;
          }
        | null;
      if (!res.ok || !data?.result) {
        throw new Error(data?.error ?? "Apply failed.");
      }
      const t = data.result.totals;
      setApplied(`Applied: ${formatConfigImportTotals(t)}.`);
      setPlan(null);
      setResolutions([]);
      setImportCategories(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setApplying(false);
    }
  }

  const hasErrors = (plan?.errors.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
          <ArrowRightLeft className="h-6 w-6" />
          Configuration Export &amp; Import
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Move configuration, site content, and lodge setup between instances as a
          portable file. This is not a database backup: ordinary categories do
          not delete, while booking policies replace the complete minimum-stay
          set after previewing every deletion. Members and transactional data
          are never included.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-4 w-4" />
            Export
          </CardTitle>
          <CardDescription>
            Choose the categories to include and download a bundle.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {CONFIG_TRANSFER_CATEGORIES.map((category) => (
              <label
                key={category}
                className="flex items-center gap-2 text-sm"
                htmlFor={`cat-${category}`}
              >
                <Checkbox
                  id={`cat-${category}`}
                  checked={selected.has(category)}
                  onCheckedChange={() => toggle(category)}
                />
                {CATEGORY_LABELS[category]}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm" htmlFor="door-codes">
            <Checkbox
              id="door-codes"
              checked={includeDoorCodes}
              onCheckedChange={(v) => setIncludeDoorCodes(v === true)}
            />
            Include lodge door codes (physical-access information)
          </label>
          <div className="flex items-center gap-3">
            <Button onClick={() => void runExport()} disabled={!canExport || exporting}>
              {exporting ? "Exporting…" : "Export bundle"}
            </Button>
          </div>
          {exportError && (
            <p className="rounded-md bg-danger-3 p-2 text-sm text-danger-11">
              {exportError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="h-4 w-4" />
            Import
          </CardTitle>
          <CardDescription>
            Upload a bundle and preview the changes. Nothing is applied until you
            confirm; the server takes a database backup before applying.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input
            type="file"
            accept=".zip,application/zip"
            className="block text-sm"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPlan(null);
              setApplied(null);
              setImportError(null);
              setResolutions([]);
              setImportCategories(null);
            }}
          />
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => void runPreview()}
              disabled={!file || planning}
            >
              {planning ? "Reading…" : "Preview (dry-run)"}
            </Button>
            <Button
              onClick={() => void runApply()}
              disabled={!plan || applying || hasErrors}
              title={hasErrors ? "Fix the bundle errors, reseal, and re-preview first" : undefined}
            >
              {applying ? "Applying…" : "Apply import"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void runReseal()}
              disabled={!file || resealing}
              title="Regenerate the manifest for a hand-edited bundle"
            >
              {resealing ? "Resealing…" : "Reseal edited bundle"}
            </Button>
          </div>

          {plan && (
            <div className="space-y-3 rounded-md border p-4 text-sm">
              <p className="font-medium">
                Plan:{" "}
                <span className="text-success-11">{plan.summary.create} new</span>,{" "}
                <span className="text-warning-11">{plan.summary.update} updated</span>,{" "}
                <span className="text-danger-11">{plan.summary.delete} deleted</span>,{" "}
                <span className="text-muted-foreground">
                  {plan.summary.unchanged} unchanged
                </span>
                .
              </p>

              {plan.selectedCategories.includes("booking-policies") && (
                <p className="flex items-start gap-2 rounded-md bg-danger-3 p-2 font-medium text-danger-11">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  Booking policies are a complete replace-set: policies omitted
                  from the bundle will be deleted, in both Merge and Overwrite
                  modes. Review every Deleted row below before applying.
                </p>
              )}

              {plan.errors.length > 0 && (
                <div className="rounded-md bg-danger-3 p-2">
                  <p className="font-medium text-danger-11">
                    {plan.errors.length} error(s) — the import is blocked until the
                    bundle is fixed (edit, reseal, then re-preview):
                  </p>
                  <ul className="ml-6 list-disc text-danger-11">
                    {plan.errors.slice(0, 25).map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              <fieldset className="rounded-md border p-3" disabled={planning}>
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  How to apply to existing records (changing this re-previews)
                </legend>
                {(
                  [
                    {
                      value: "merge" as const,
                      title: "Merge",
                      blurb:
                        " (recommended) — only fields with a value in the bundle are written; blank fields keep the existing value.",
                    },
                    {
                      value: "overwrite" as const,
                      title: "Overwrite",
                      blurb:
                        " — the bundle fully defines each record; blank fields clear the existing value.",
                    },
                  ]
                ).map((option) => (
                  <label
                    key={option.value}
                    className="mt-1 flex items-start gap-2 first:mt-0"
                    htmlFor={`mode-${option.value}`}
                  >
                    <input
                      id={`mode-${option.value}`}
                      type="radio"
                      name="import-mode"
                      className="mt-1"
                      checked={mode === option.value}
                      onChange={() => selectMode(option.value)}
                    />
                    <span>
                      <span className="font-medium">{option.title}</span>
                      {option.blurb}
                    </span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="rounded-md border p-3" disabled={planning}>
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  Categories to import (changing this re-previews)
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CONFIG_TRANSFER_CATEGORIES.filter(
                    (c) =>
                      plan.selectedCategories.includes(c) ||
                      (importCategories ?? []).includes(c) ||
                      plan.categories.some((p) => p.category === c),
                  ).map((category) => {
                    const active = (importCategories ?? plan.selectedCategories).includes(category);
                    return (
                      <label
                        key={category}
                        className="flex items-center gap-2 text-sm"
                        htmlFor={`import-cat-${category}`}
                      >
                        <Checkbox
                          id={`import-cat-${category}`}
                          checked={active}
                          onCheckedChange={() => toggleImportCategory(category)}
                        />
                        {CATEGORY_LABELS[category]}
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {plan.doorCodeChanges.length > 0 && (
                <p className="flex items-center gap-2 rounded-md bg-warning-3 p-2 font-medium text-warning-11">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  This import will set or change the door code for:{" "}
                  {plan.doorCodeChanges.join(", ")}.
                </p>
              )}
              {plan.doorCodesIncluded && (
                <p className="text-warning-11">This bundle includes door codes.</p>
              )}

              {plan.integrityWarnings.length > 0 && (
                <div className="rounded-md bg-warning-3 p-2">
                  <p className="flex items-center gap-2 font-medium text-warning-11">
                    <AlertTriangle className="h-4 w-4" />
                    This bundle was edited since export:
                  </p>
                  <ul className="ml-6 list-disc text-warning-11">
                    {plan.integrityWarnings.slice(0, 20).map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-warning-11">
                    You can still apply, or “Reseal edited bundle” to refresh its
                    manifest.
                  </p>
                </div>
              )}

              {plan.xero.mismatch && (
                <p className="flex items-center gap-2 text-warning-11">
                  <AlertTriangle className="h-4 w-4" />
                  Xero config came from a different connected org — verify before
                  applying (or untick the Xero category above).
                </p>
              )}

              {plan.categories.map((cat) => {
                // Every mutation is shown, even when there are more than 50.
                // Only unchanged rows may be capped; otherwise a destructive
                // replace-set could tell the admin to review "every Deleted
                // row below" while silently hiding some of them.
                const { shown, hiddenUnchanged } = visibleImportPlanItems(
                  cat.items,
                );
                return (
                <div key={cat.category}>
                  <p className="font-medium">{CATEGORY_LABELS[cat.category]}</p>
                  <ul className="ml-1 space-y-1">
                    {shown.map((item) => {
                      const changed = item.action !== "unchanged";
                      const badge = ACTION_BADGE[item.action];
                      return (
                      <li
                        key={`${item.entity}:${item.key}`}
                        className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${
                          changed ? "text-foreground" : "text-muted-foreground opacity-70"
                        }`}
                      >
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${badge.badge}`}
                        >
                          {badge.label}
                        </span>
                        <span className={changed ? "font-medium" : ""}>
                          {item.entity} “{item.key}”
                          {item.changedFields?.length
                            ? ` (${item.changedFields.join(", ")})`
                            : ""}
                        </span>
                        {item.candidates?.length ? (
                          <span className="ml-2">
                            <select
                              className="rounded border px-1 py-0.5 text-xs"
                              disabled={planning}
                              value={
                                resolutions.find(
                                  (r) => r.entity === item.entity && r.key === item.key,
                                )?.matchId ?? ""
                              }
                              onChange={(e) =>
                                resolveMatch(item.entity, item.key, e.target.value)
                              }
                            >
                              <option value="">create new</option>
                              {item.candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  match: {c.label}
                                </option>
                              ))}
                            </select>
                          </span>
                        ) : null}
                      </li>
                      );
                    })}
                  </ul>
                  {hiddenUnchanged > 0 && (
                    <p className="ml-1 text-xs text-muted-foreground">
                      …and {hiddenUnchanged} more unchanged row
                      {hiddenUnchanged === 1 ? "" : "s"} not shown.
                    </p>
                  )}
                  {cat.warnings.map((w) => (
                    <p key={w} className="text-warning-11">
                      {w}
                    </p>
                  ))}
                </div>
                );
              })}
            </div>
          )}

          {applied && (
            <p className="rounded-md bg-success-3 p-2 text-sm text-success-11">
              {applied}
            </p>
          )}
          {importError && (
            <p className="rounded-md bg-danger-3 p-2 text-sm text-danger-11">
              {importError}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
