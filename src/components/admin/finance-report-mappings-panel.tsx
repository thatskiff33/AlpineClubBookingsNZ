"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  SearchX,
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
import { Textarea } from "@/components/ui/textarea";

type CategoryKind = "REVENUE" | "EXPENSE";

interface FinanceMapping {
  id?: string;
  accountCode: string | null;
  sectionLabel: string | null;
  lineLabel: string | null;
}

interface FinanceCategory {
  id?: string;
  kind: CategoryKind;
  name: string;
  sortOrder: number;
  archived: boolean;
  mappings: FinanceMapping[];
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
  categories: FinanceCategory[];
  unmappedLines: UnmappedLine[];
  snapshotCoverage: {
    latestProfitAndLossSnapshot: string | null;
    inspectedSnapshotCount: number;
  };
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

function accountCodeText(category: FinanceCategory) {
  return category.mappings
    .filter((mapping) => mapping.accountCode)
    .map((mapping) => mapping.accountCode)
    .join("\n");
}

function fallbackLineText(category: FinanceCategory) {
  return category.mappings
    .filter((mapping) => !mapping.accountCode && mapping.lineLabel)
    .map((mapping) =>
      mapping.sectionLabel
        ? `${mapping.sectionLabel} :: ${mapping.lineLabel}`
        : mapping.lineLabel,
    )
    .join("\n");
}

function parseLineMappings(value: string): FinanceMapping[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [section, ...rest] = line.split("::").map((part) => part.trim());
      if (rest.length === 0) {
        return {
          accountCode: null,
          sectionLabel: null,
          lineLabel: section,
        };
      }
      return {
        accountCode: null,
        sectionLabel: section,
        lineLabel: rest.join(" :: "),
      };
    });
}

function parseAccountMappings(value: string): FinanceMapping[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((accountCode) => ({
      accountCode,
      sectionLabel: null,
      lineLabel: null,
    }));
}

function categoryTitle(kind: CategoryKind) {
  return kind === "REVENUE" ? "Revenue" : "Expenses";
}

export function FinanceReportMappingsPanel() {
  const [state, setState] = useState<FinanceMappingsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMappings() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/setup/finance-report-mappings", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as FinanceMappingsState | { error?: string };
      if (!response.ok || !("categories" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to load finance mappings"),
        );
      }
      setState(body);
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

  useEffect(() => {
    void loadMappings();
  }, []);

  const grouped = useMemo(() => {
    const categories = state?.categories ?? [];
    return {
      REVENUE: categories.filter((category) => category.kind === "REVENUE"),
      EXPENSE: categories.filter((category) => category.kind === "EXPENSE"),
    } satisfies Record<CategoryKind, FinanceCategory[]>;
  }, [state]);

  function updateCategory(
    target: FinanceCategory,
    patch: Partial<FinanceCategory>,
  ) {
    setState((current) => {
      if (!current) return current;
      return {
        ...current,
        categories: current.categories.map((category) =>
          category === target ||
          (target.id && category.id === target.id) ||
          (!target.id &&
            !category.id &&
            category.kind === target.kind &&
            category.sortOrder === target.sortOrder)
            ? { ...category, ...patch }
            : category,
        ),
      };
    });
  }

  function updateCategoryMappings(
    target: FinanceCategory,
    accountCodes: string,
    fallbackLines: string,
  ) {
    updateCategory(target, {
      mappings: [
        ...parseAccountMappings(accountCodes),
        ...parseLineMappings(fallbackLines),
      ],
    });
  }

  function addCategory(kind: CategoryKind) {
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
            kind,
            name: `${categoryTitle(kind)} Group`,
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
      const response = await fetch("/api/admin/setup/finance-report-mappings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories: state.categories }),
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
      setState(body);
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

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle>Finance Report Mappings</CardTitle>
            <CardDescription>
              Group Xero profit-and-loss account codes and fallback report lines for the finance dashboard.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={loadMappings}
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
            </div>

            <div className="grid gap-5 2xl:grid-cols-2">
              {(["REVENUE", "EXPENSE"] as const).map((kind) => (
                <section key={kind} className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-900">
                        {categoryTitle(kind)}
                      </h3>
                      <p className="text-sm text-slate-600">
                        Account-code mappings take priority over fallback labels.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addCategory(kind)}
                    >
                      <Plus className="h-4 w-4" />
                      Add
                    </Button>
                  </div>

                  <div className="space-y-3">
                    {grouped[kind].map((category) => (
                      <div
                        key={category.id ?? `${category.kind}:${category.sortOrder}`}
                        className="rounded-md border border-slate-200 bg-white p-3"
                      >
                        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_7rem_7rem]">
                          <div className="space-y-1.5">
                            <Label>Name</Label>
                            <Input
                              value={category.name}
                              onChange={(event) =>
                                updateCategory(category, {
                                  name: event.target.value,
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
                                updateCategory(category, {
                                  sortOrder: Number(event.target.value),
                                })
                              }
                            />
                          </div>
                          <label className="mt-7 flex items-center gap-2 text-sm text-slate-700">
                            <input
                              type="checkbox"
                              checked={category.archived}
                              onChange={(event) =>
                                updateCategory(category, {
                                  archived: event.target.checked,
                                })
                              }
                            />
                            Archived
                          </label>
                        </div>
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label>Xero Account Codes</Label>
                            <Textarea
                              rows={4}
                              value={accountCodeText(category)}
                              onChange={(event) =>
                                updateCategoryMappings(
                                  category,
                                  event.target.value,
                                  fallbackLineText(category),
                                )
                              }
                              placeholder="200&#10;203"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label>Fallback P&L Lines</Label>
                            <Textarea
                              rows={4}
                              value={fallbackLineText(category)}
                              onChange={(event) =>
                                updateCategoryMappings(
                                  category,
                                  accountCodeText(category),
                                  event.target.value,
                                )
                              }
                              placeholder="Income :: Hut Fees&#10;Insurance"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
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
                  No unmapped revenue or expense lines were found in inspected snapshots.
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
                        {line.accountCode ? ` · ${line.accountCode}` : ""} ·{" "}
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
