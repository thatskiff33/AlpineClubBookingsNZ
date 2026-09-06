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
import {
  FieldHint,
  describedByFieldHint,
} from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { XeroAccountMultiSelect } from "@/components/admin/xero-account-multi-select";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
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
/*
  #2257 — the subtype field's id and its hint id, each spelled EXACTLY ONCE.
  These rows render inside a `.map()`, so a hook cannot be called per row and the
  ids must be derived from the row key (a cuid, or the `new-N` counter below, so
  always id-safe). Deriving them at each use site would mean the same template
  literal written twice, where a typo in either copy silently orphans the hint
  with nothing failing.
*/
function subtypeFieldId(categoryKey: string) {
  return `finance-subtype-${categoryKey}`;
}

function subtypeHintId(categoryKey: string) {
  return `finance-subtype-hint-${categoryKey}`;
}

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
  // The save/backfill routes enforce finance manager (finance:edit) access, so
  // gate the editor on the finance area (#1940). A finance:view admin sees the
  // read-only mappings but every write control is disabled.
  const canEdit = useAdminAreaEditAccess("finance");

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
      //
      // 404 joins them. This route is module-gated, so it answers 404 both when
      // the finance module is off and when the sign-in behind this tab has
      // expired — a gated route hides that difference on purpose
      // (`moduleGatedNotFoundResponse` in `src/lib/session-guards.ts`). There is
      // nothing to edit in either state, so the panel goes quiet exactly as it
      // does for a denial rather than showing a red box that names neither
      // cause.
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
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
      // 404 deliberately does NOT hide the panel. `/api/admin/xero/*` is gated
      // by the Xero module, which a club can run with the finance module on, so
      // the mappings above are still editable — only the account picker is
      // unavailable. The other cause is an expired sign-in: a gated route
      // answers an anonymous caller with the same 404 on purpose
      // (`moduleGatedNotFoundResponse` in `src/lib/session-guards.ts`), so the
      // note names both and the operator can settle it by signing in again.
      if (response.status === 404) {
        setAccounts([]);
        setCoaError(
          "the Xero module may be switched off, or your sign-in may have expired — sign in again and reload to tell which",
        );
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

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the card, not in the
    `space-y-5` CardContent stack, because two of the controls it explains
    (Backfill History and Save) are in the CardHeader — a banner inside the
    content would come after them in the reading order. The empty wrapper an
    edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view the finance report mappings but cannot change
      them. Finance edit access is required.
    </AdminViewOnlySectionBanner>
  );

  // A cross-area 403 hides the whole panel, banner included — there is no
  // section left here for the banner to explain.
  if (forbidden) return null;

  return (
    <div>
      {viewOnlyBanner}
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
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
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
            </ViewOnlyActionButton>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
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
            </ViewOnlyActionButton>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <div className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11">
            {message}
          </div>
        ) : null}
        {coaError ? (
          <div className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
            Could not load the Xero chart of accounts ({coaError}). You can still
            type account codes manually; reconnect Xero to pick from the live
            account list.
          </div>
        ) : null}

        {loading && !state ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading finance mappings
          </div>
        ) : null}

        {state ? (
          <>
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              Latest inspected P&amp;L snapshot:{" "}
              {state.snapshotCoverage.latestProfitAndLossSnapshot ?? "none"} ·{" "}
              {state.snapshotCoverage.inspectedSnapshotCount} snapshots checked.
              Lines are matched to groups by Xero account code only.
            </div>

            <div className="space-y-6">
              {(["REVENUE", "EXPENSE"] as const).map((kind) => (
                <section key={kind} className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-foreground">
                        {categoryTitle(kind)}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        Groups are shown under their subtype sub-headings, the
                        same way they appear on the finance dashboard.
                      </p>
                    </div>
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addCategory(kind, null)}
                    >
                      <Plus className="h-4 w-4" />
                      Add group
                    </ViewOnlyActionButton>
                  </div>

                  {buildSections(grouped[kind]).map((section) => (
                    <div
                      key={`${kind}:${section.subtype ?? "__ungrouped__"}`}
                      className="space-y-3"
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-border pb-1">
                        <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          {section.subtype ?? "Ungrouped"}
                        </h4>
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => addCategory(kind, section.subtype)}
                        >
                          <Plus className="h-4 w-4" />
                          Add group here
                        </ViewOnlyActionButton>
                      </div>

                      {section.items.map((category) => (
                        <div
                          key={category.key}
                          className="rounded-md border border-border bg-card p-3"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_auto]">
                            <div className="space-y-1.5">
                              <Label>Name</Label>
                              <Input
                                value={category.name}
                                disabled={!canEdit}
                                onChange={(event) =>
                                  updateCategory(category.key, {
                                    name: event.target.value,
                                  })
                                }
                              />
                            </div>
                            <div className="space-y-1.5">
                              {/* #2257 — the Label carried no `htmlFor` and the
                                  Input no `id`, so the field had no accessible
                                  NAME for the new description to attach to.
                                  Both are supplied here. */}
                              <Label htmlFor={subtypeFieldId(category.key)}>
                                Subtype
                              </Label>
                              <Input
                                id={subtypeFieldId(category.key)}
                                list={`finance-subtypes-${kind}`}
                                value={category.subtype ?? ""}
                                disabled={!canEdit}
                                aria-describedby={describedByFieldHint(
                                  subtypeHintId(category.key),
                                )}
                                onChange={(event) =>
                                  updateCategory(category.key, {
                                    subtype: event.target.value
                                      ? event.target.value
                                      : null,
                                  })
                                }
                              />
                              <FieldHint id={subtypeHintId(category.key)}>
                                Example: Operating
                              </FieldHint>
                            </div>
                            <div className="space-y-1.5">
                              <Label>Order</Label>
                              <Input
                                type="number"
                                min={0}
                                value={category.sortOrder}
                                disabled={!canEdit}
                                onChange={(event) =>
                                  updateCategory(category.key, {
                                    sortOrder: Number(event.target.value),
                                  })
                                }
                              />
                            </div>
                            <div className="flex items-end justify-end gap-3">
                              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                                <input
                                  type="checkbox"
                                  checked={category.archived}
                                  disabled={!canEdit}
                                  onChange={(event) =>
                                    updateCategory(category.key, {
                                      archived: event.target.checked,
                                    })
                                  }
                                />
                                Archived
                              </label>
                              <ViewOnlyActionButton
                                canEdit={canEdit}
                                describeReason={false}
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => deleteCategory(category.key)}
                                aria-label="Delete group"
                              >
                                <Trash2 className="h-4 w-4 text-danger-11" />
                              </ViewOnlyActionButton>
                            </div>
                          </div>

                          <div className="mt-3 space-y-1.5">
                            <Label>Xero accounts</Label>
                            <XeroAccountMultiSelect
                              accounts={accounts}
                              disabled={!canEdit}
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
                <SearchX className="h-4 w-4 text-warning-11" />
                <h3 className="text-lg font-semibold text-foreground">
                  Unmapped Lines
                </h3>
                <Badge variant={state.unmappedLines.length ? "warning" : "success"}>
                  {state.unmappedLines.length}
                </Badge>
              </div>
              {state.unmappedLines.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No unmapped revenue or expense lines were found in inspected
                  snapshots.
                </p>
              ) : (
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {state.unmappedLines.slice(0, 18).map((line) => (
                    <div
                      key={`${line.kind}:${line.sectionLabel}:${line.lineLabel}:${line.accountCode ?? ""}`}
                      className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline">{line.kind}</Badge>
                        <span className="text-sm font-semibold text-warning-11">
                          {line.formattedAmount}
                        </span>
                      </div>
                      <p className="mt-1 text-sm font-medium text-warning-11">
                        {line.lineLabel}
                      </p>
                      <p className="text-xs text-warning-11">
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
    </div>
  );
}
