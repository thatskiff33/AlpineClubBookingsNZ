"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  SearchX,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { XeroAccountMultiSelect } from "@/components/admin/xero-account-multi-select";
import type { XeroAccount } from "@/lib/xero-admin-cache";

type CategoryKind = "REVENUE" | "EXPENSE";

interface FinanceMapping {
  id?: string;
  accountCode: string;
}

interface ServerCategory {
  id?: string;
  kind: CategoryKind;
  name: string;
  subtype: string | null;
  sortOrder: number;
  archived: boolean;
  mappings: FinanceMapping[];
}

interface EditorCategory extends ServerCategory {
  key: string;
}

interface UnmappedLine {
  kind: CategoryKind;
  sectionLabel: string;
  lineLabel: string;
  accountCode: string | null;
  formattedAmount: string;
  periodsPresent: number;
}

interface FinanceMappingsState {
  categories: ServerCategory[];
  unmappedLines: UnmappedLine[];
  snapshotCoverage: {
    latestProfitAndLossSnapshot: string | null;
    inspectedSnapshotCount: number;
  };
}

interface EditorState {
  categories: EditorCategory[];
  unmappedLines: UnmappedLine[];
  snapshotCoverage: FinanceMappingsState["snapshotCoverage"];
}

const KIND_CLASS_FILTER: Record<CategoryKind, string> = {
  REVENUE: "REVENUE",
  EXPENSE: "EXPENSE",
};

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `new-${keyCounter}`;
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

function categoryTitle(kind: CategoryKind) {
  return kind === "REVENUE" ? "Revenue" : "Expenses";
}

function toEditorState(state: FinanceMappingsState): EditorState {
  return {
    categories: state.categories.map((category) => ({
      ...category,
      subtype: category.subtype ?? null,
      mappings: category.mappings ?? [],
      key: category.id ?? nextKey(),
    })),
    unmappedLines: state.unmappedLines,
    snapshotCoverage: state.snapshotCoverage,
  };
}

interface Section {
  subtype: string | null;
  items: EditorCategory[];
}

// Group a kind's categories into subtype sections, ordered by the first
// (lowest sortOrder) appearance of each subtype. Categories with no subtype
// fall into the "Ungrouped" section.
function buildSections(categories: EditorCategory[]): Section[] {
  const sorted = [...categories].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
  );
  const order: string[] = [];
  const buckets = new Map<string, EditorCategory[]>();
  for (const category of sorted) {
    const subtype = category.subtype?.trim() ?? "";
    if (!buckets.has(subtype)) {
      buckets.set(subtype, []);
      order.push(subtype);
    }
    buckets.get(subtype)!.push(category);
  }
  return order.map((subtype) => ({
    subtype: subtype === "" ? null : subtype,
    items: buckets.get(subtype)!,
  }));
}

export function FinanceReportMappingsPanel() {
  const [state, setState] = useState<EditorState | null>(null);
  const [accounts, setAccounts] = useState<XeroAccount[]>([]);
  const [coaError, setCoaError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  async function loadMappings() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/setup/finance-report-mappings", {
        credentials: "same-origin",
      });
      // The embedding page normally hides this panel by permission matrix; this
      // in-card backstop makes a future cross-area embedding degrade quietly
      // (render nothing) instead of showing the error box for a viewer lacking
      // finance access. Xero-not-connected returns 500, not 403, so the
      // chart-of-accounts amber note below is unaffected.
      if (response.status === 401 || response.status === 403) {
        // Dev breadcrumb: the embedding page hides this panel by matrix, so a
        // denial here means matrix↔enforcement drift or mid-session revocation.
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "FinanceReportMappingsPanel: mappings fetch denied; hiding panel (matrix/enforcement drift or revoked session?)",
          );
        }
        setForbidden(true);
        return;
      }
      const body = (await response.json()) as
        | FinanceMappingsState
        | { error?: string };
      if (!response.ok || !("categories" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to load finance mappings"),
        );
      }
      setState(toEditorState(body));
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load finance mappings",
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadAccounts() {
    setCoaError(null);
    try {
      const response = await fetch("/api/admin/xero/chart-of-accounts", {
        credentials: "same-origin",
      });
      // Same backstop as the mappings load: a finance-area denial hides the
      // whole panel quietly. This route returns 500 (not 401/403) when Xero is
      // simply not connected, so the coaError amber note stays the graceful path
      // for a legitimate finance viewer.
      if (response.status === 401 || response.status === 403) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "FinanceReportMappingsPanel: chart-of-accounts fetch denied; hiding panel (matrix/enforcement drift or revoked session?)",
          );
        }
        setForbidden(true);
        return;
      }
      const body = (await response.json()) as
        | { accounts?: XeroAccount[] }
        | { error?: string };
      if (!response.ok || !("accounts" in body) || !Array.isArray(body.accounts)) {
        throw new Error(
          responseErrorMessage(body, "Failed to load Xero chart of accounts"),
        );
      }
      setAccounts(body.accounts);
    } catch (accountsError) {
      setAccounts([]);
      setCoaError(
        accountsError instanceof Error
          ? accountsError.message
          : "Failed to load Xero chart of accounts",
      );
    }
  }

  useEffect(() => {
    void loadMappings();
    void loadAccounts();
  }, []);

  const grouped = useMemo(() => {
    const categories = state?.categories ?? [];
    return {
      REVENUE: categories.filter((category) => category.kind === "REVENUE"),
      EXPENSE: categories.filter((category) => category.kind === "EXPENSE"),
    } satisfies Record<CategoryKind, EditorCategory[]>;
  }, [state]);

  const subtypeSuggestions = useMemo(() => {
    const byKind: Record<CategoryKind, Set<string>> = {
      REVENUE: new Set(),
      EXPENSE: new Set(),
    };
    for (const category of state?.categories ?? []) {
      const subtype = category.subtype?.trim();
      if (subtype) {
        byKind[category.kind].add(subtype);
      }
    }
    return {
      REVENUE: Array.from(byKind.REVENUE).sort(),
      EXPENSE: Array.from(byKind.EXPENSE).sort(),
    };
  }, [state]);

  function updateCategory(key: string, patch: Partial<EditorCategory>) {
    setState((current) => {
      if (!current) return current;
      return {
        ...current,
        categories: current.categories.map((category) =>
          category.key === key ? { ...category, ...patch } : category,
        ),
      };
    });
  }

  function deleteCategory(key: string) {
    setState((current) => {
      if (!current) return current;
      return {
        ...current,
        categories: current.categories.filter(
          (category) => category.key !== key,
        ),
      };
    });
  }

  function addCategory(kind: CategoryKind, subtype: string | null) {
    setState((current) => {
      if (!current) return current;
      const nextSort =
        Math.max(
          0,
          ...current.categories
            .filter((category) => category.kind === kind)
            .map((category) => category.sortOrder),
        ) + 10;
      return {
        ...current,
        categories: [
          ...current.categories,
          {
            key: nextKey(),
            kind,
            name: `New ${categoryTitle(kind)} group`,
            subtype,
            sortOrder: nextSort,
            archived: false,
            mappings: [],
          },
        ],
      };
    });
  }

  async function saveMappings() {
    if (!state) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = {
        categories: state.categories.map((category) => ({
          ...(category.id ? { id: category.id } : {}),
          kind: category.kind,
          name: category.name,
          subtype: category.subtype?.trim() ? category.subtype.trim() : null,
          sortOrder: category.sortOrder,
          archived: category.archived,
          mappings: category.mappings.map((mapping) => ({
            accountCode: mapping.accountCode,
          })),
        })),
      };
      const response = await fetch("/api/admin/setup/finance-report-mappings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as
        | FinanceMappingsState
        | { error?: string; details?: unknown }
        | null;
      if (!response.ok || !body || !("categories" in body)) {
        const detailText =
          body &&
          typeof body === "object" &&
          "details" in body &&
          Array.isArray(body.details)
            ? ` ${body.details.join(" ")}`
            : "";
        throw new Error(
          `${responseErrorMessage(body, "Failed to save finance mappings")}${detailText}`,
        );
      }
      setState(toEditorState(body));
      setMessage("Finance report mappings saved.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save finance mappings",
      );
    } finally {
      setSaving(false);
    }
  }

  async function runBackfill() {
    setBackfilling(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/admin/setup/finance-report-mappings/backfill",
        {
          method: "POST",
          credentials: "same-origin",
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { status?: string; snapshotCount?: number; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(responseErrorMessage(body, "Finance backfill failed"));
      }
      setMessage(
        `Finance backfill ${body?.status ?? "completed"} with ${body?.snapshotCount ?? 0} snapshots.`,
      );
      await loadMappings();
    } catch (backfillError) {
      setError(
        backfillError instanceof Error
          ? backfillError.message
          : "Finance backfill failed",
      );
    } finally {
      setBackfilling(false);
    }
  }

  if (forbidden) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle>Finance Report Mappings</CardTitle>
            <CardDescription>
              Build the report groups that organise the finance dashboard. Each
              group has a name, an optional subtype sub-heading, and the Xero
              chart-of-accounts codes whose profit-and-loss lines roll up into it.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void loadMappings();
                void loadAccounts();
              }}
              disabled={loading}
            >
              <RotateCcw className="h-4 w-4" />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={runBackfill}
              disabled={backfilling || loading}
            >
              {backfilling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
              Backfill History
            </Button>
            <Button
              type="button"
              onClick={saveMappings}
              disabled={saving || loading || !state}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {message}
          </div>
        ) : null}
        {coaError ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Could not load the Xero chart of accounts ({coaError}). You can still
            type account codes manually; reconnect Xero to pick from the live
            account list.
          </div>
        ) : null}

        {loading && !state ? (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading finance mappings
          </div>
        ) : null}

        {state ? (
          <>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Latest inspected P&L snapshot:{" "}
              {state.snapshotCoverage.latestProfitAndLossSnapshot ?? "none"} ·{" "}
              {state.snapshotCoverage.inspectedSnapshotCount} snapshots checked.
              Lines are matched to groups by Xero account code only.
            </div>

            <div className="space-y-6">
              {(["REVENUE", "EXPENSE"] as const).map((kind) => (
                <section key={kind} className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-900">
                        {categoryTitle(kind)}
                      </h3>
                      <p className="text-sm text-slate-600">
                        Groups are shown under their subtype sub-headings, the
                        same way they appear on the finance dashboard.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addCategory(kind, null)}
                    >
                      <Plus className="h-4 w-4" />
                      Add group
                    </Button>
                  </div>

                  {buildSections(grouped[kind]).map((section) => (
                    <div
                      key={`${kind}:${section.subtype ?? "__ungrouped__"}`}
                      className="space-y-3"
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-1">
                        <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                          {section.subtype ?? "Ungrouped"}
                        </h4>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => addCategory(kind, section.subtype)}
                        >
                          <Plus className="h-4 w-4" />
                          Add group here
                        </Button>
                      </div>

                      {section.items.map((category) => (
                        <div
                          key={category.key}
                          className="rounded-md border border-slate-200 bg-white p-3"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_auto]">
                            <div className="space-y-1.5">
                              <Label>Name</Label>
                              <Input
                                value={category.name}
                                onChange={(event) =>
                                  updateCategory(category.key, {
                                    name: event.target.value,
                                  })
                                }
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label>Subtype</Label>
                              <Input
                                list={`finance-subtypes-${kind}`}
                                value={category.subtype ?? ""}
                                placeholder="e.g. Operating"
                                onChange={(event) =>
                                  updateCategory(category.key, {
                                    subtype: event.target.value
                                      ? event.target.value
                                      : null,
                                  })
                                }
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label>Order</Label>
                              <Input
                                type="number"
                                min={0}
                                value={category.sortOrder}
                                onChange={(event) =>
                                  updateCategory(category.key, {
                                    sortOrder: Number(event.target.value),
                                  })
                                }
                              />
                            </div>
                            <div className="flex items-end justify-end gap-3">
                              <label className="flex items-center gap-2 text-sm text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={category.archived}
                                  onChange={(event) =>
                                    updateCategory(category.key, {
                                      archived: event.target.checked,
                                    })
                                  }
                                />
                                Archived
                              </label>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => deleteCategory(category.key)}
                                aria-label="Delete group"
                              >
                                <Trash2 className="h-4 w-4 text-red-600" />
                              </Button>
                            </div>
                          </div>

                          <div className="mt-3 space-y-1.5">
                            <Label>Xero accounts</Label>
                            <XeroAccountMultiSelect
                              accounts={accounts}
                              selectedCodes={category.mappings.map(
                                (mapping) => mapping.accountCode,
                              )}
                              classFilter={KIND_CLASS_FILTER[kind]}
                              allowManualCodes={
                                accounts.length === 0 || Boolean(coaError)
                              }
                              onChange={(codes) =>
                                updateCategory(category.key, {
                                  mappings: codes.map((accountCode) => ({
                                    accountCode,
                                  })),
                                })
                              }
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}

                  <datalist id={`finance-subtypes-${kind}`}>
                    {subtypeSuggestions[kind].map((subtype) => (
                      <option key={subtype} value={subtype} />
                    ))}
                  </datalist>
                </section>
              ))}
            </div>

            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <SearchX className="h-4 w-4 text-amber-700" />
                <h3 className="text-lg font-semibold text-slate-900">
                  Unmapped Lines
                </h3>
                <Badge variant={state.unmappedLines.length ? "warning" : "success"}>
                  {state.unmappedLines.length}
                </Badge>
              </div>
              {state.unmappedLines.length === 0 ? (
                <p className="text-sm text-slate-600">
                  No unmapped revenue or expense lines were found in inspected
                  snapshots.
                </p>
              ) : (
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {state.unmappedLines.slice(0, 18).map((line) => (
                    <div
                      key={`${line.kind}:${line.sectionLabel}:${line.lineLabel}:${line.accountCode ?? ""}`}
                      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline">{line.kind}</Badge>
                        <span className="text-sm font-semibold text-amber-950">
                          {line.formattedAmount}
                        </span>
                      </div>
                      <p className="mt-1 text-sm font-medium text-amber-950">
                        {line.lineLabel}
                      </p>
                      <p className="text-xs text-amber-900">
                        {line.sectionLabel}
                        {line.accountCode ? ` · code ${line.accountCode}` : ""} ·{" "}
                        {line.periodsPresent} hits
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
