"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeftRight, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/admin/back-link";
import { Input } from "@/components/ui/input";
import { MemberPicker, type PickedMember } from "@/components/admin/member-picker";
import { useClubTime } from "@/components/club-time-provider";
import {
  formatMergeFieldValue,
  mergeFieldValueKind,
  type MergeFieldValueKind,
} from "@/lib/member-merge-field-kinds";

type MemberBasic = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier?: string;
  active?: boolean;
  archivedAt?: string | null;
};

type FieldMergeRow = {
  field: string;
  master: unknown;
  loser: unknown;
  result: unknown;
  source: string;
  // The server stamps this on every row (#2860). Optional here only so a page
  // served by a newer build can still render a preview built by an older one
  // mid-deploy; `rowValueKind` re-derives it from the same declaration.
  kind?: MergeFieldValueKind;
};

type MergePreview = {
  masterId: string;
  loserId: string;
  masterName: string;
  loserName: string;
  confirmationPhrase: string;
  previewToken: string;
  fieldMerge: FieldMergeRow[];
  relationMoves: { model: string; count: number }[];
  collisions: { model: string; resolution: string; count: number }[];
  blockers: { code: string; label: string; count?: number }[];
  warnings: string[];
};

/**
 * What this row's values mean (#2860). The row carries it; the field-name
 * lookup is the mid-deploy fallback described on `FieldMergeRow.kind`. This
 * screen never infers a date's meaning from its runtime type — an instant and a
 * calendar day are the same `Date`, and reading one as the other dates it a day
 * early for half of every New Zealand day, immediately before an irreversible
 * merge.
 *
 * This REPLACES the `display()` helper that used to live here. #2684 had just
 * moved its `value instanceof Date` arm off a hand-written truncation and onto
 * `formatDateOnly`, which fixed the spelling; the arm itself is the defect,
 * because no runtime type can tell the two kinds apart. The canonical encoder is
 * still what renders a calendar day — one module across, in
 * `formatMergeFieldValue` — so nothing #2684 centralised is given back.
 */
function rowValueKind(row: FieldMergeRow): MergeFieldValueKind {
  return row.kind ?? mergeFieldValueKind(row.field);
}

export default function MemberMergePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // The `instant` branch of `formatMergeFieldValue` defaults its zone to
  // `APP_TIME_ZONE`; production never passed one, so this screen read the
  // environment. It is handed the club's PERSISTED zone here
  // (`INV-CONFIG-002`) — a day-early stamp on the screen immediately before an
  // IRREVERSIBLE merge is the worst place in the admin tree to have one. The
  // `calendarDay` branch ignores the argument by design.
  const clubTime = useClubTime();
  const { id: masterId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedLoserId = searchParams.get("loser");

  const [master, setMaster] = useState<MemberBasic | null>(null);
  const [loser, setLoser] = useState<PickedMember | null>(null);
  const [suggestions, setSuggestions] = useState<MemberBasic[]>([]);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState("");

  // Load the master member.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/admin/members/${masterId}`);
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok) {
        const m = data.member ?? data;
        setMaster({
          id: m.id,
          firstName: m.firstName,
          lastName: m.lastName,
          email: m.email,
          active: m.active,
          archivedAt: m.archivedAt ?? null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [masterId]);

  // Load duplicate-candidate suggestions (same last name).
  useEffect(() => {
    if (!master?.lastName) return;
    let cancelled = false;
    (async () => {
      const qs = new URLSearchParams({
        q: master.lastName,
        pageSize: "8",
        active: "true",
      });
      const res = await fetch(`/api/admin/members?${qs.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok) {
        const members = (data.members ?? []) as MemberBasic[];
        setSuggestions(members.filter((m) => m.id !== masterId));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [master?.lastName, masterId]);

  // Honour a preselected loser (from a swap).
  useEffect(() => {
    if (!preselectedLoserId || loser) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/admin/members/${preselectedLoserId}`);
      const data = await res.json().catch(() => ({}));
      if (!cancelled && res.ok) {
        const m = data.member ?? data;
        setLoser({
          id: m.id,
          firstName: m.firstName,
          lastName: m.lastName,
          email: m.email,
          ageTier: m.ageTier ?? "",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preselectedLoserId, loser]);

  const resetPreview = useCallback(() => {
    setPreview(null);
    setConfirmationText("");
    setError("");
  }, []);

  const runPreview = useCallback(async () => {
    if (!loser) return;
    setLoadingPreview(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/members/${masterId}/merge/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loserId: loser.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to build the merge preview.");
        setPreview(null);
        return;
      }
      setPreview(data as MergePreview);
    } finally {
      setLoadingPreview(false);
    }
  }, [loser, masterId]);

  const execute = useCallback(async () => {
    if (!preview) return;
    setExecuting(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/members/${masterId}/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loserId: preview.loserId,
          previewToken: preview.previewToken,
          confirmationText,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "The merge could not be completed.");
        return;
      }
      toast.success("Members merged. The duplicate has been deleted.");
      router.push(`/admin/members/${masterId}`);
    } finally {
      setExecuting(false);
    }
  }, [preview, masterId, confirmationText, router]);

  const swap = useCallback(() => {
    if (!loser) return;
    router.push(`/admin/members/${loser.id}/merge?loser=${masterId}`);
  }, [loser, masterId, router]);

  const canExecute = useMemo(
    () =>
      Boolean(preview) &&
      preview!.blockers.length === 0 &&
      confirmationText.trim().replace(/\s+/g, " ") === preview!.confirmationPhrase,
    [preview, confirmationText],
  );

  const changedFields = useMemo(
    () => preview?.fieldMerge.filter((r) => r.source !== "master") ?? [],
    [preview],
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4">
        <BackLink href={`/admin/members/${masterId}`} label="Member" />
      </div>

      <h1 className="text-xl font-semibold text-foreground">Merge duplicate member</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The master record below survives and keeps its login, security and Xero
        identity. The duplicate&apos;s history is moved onto the master and the
        duplicate is permanently deleted.
      </p>

      {/* Master / loser */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-info-6 bg-info-3 p-4">
          <p className="text-xs font-semibold uppercase text-info-11">Master (kept)</p>
          <p className="mt-1 font-medium text-foreground">
            {master ? `${master.firstName} ${master.lastName}` : "Loading…"}
          </p>
          <p className="text-xs text-muted-foreground">{master?.email}</p>
          {master && (master.active === false || master.archivedAt) && (
            <p className="mt-2 text-xs font-medium text-danger-11">
              This member is inactive or archived and cannot be a merge master.
            </p>
          )}
        </div>
        <div className="rounded-lg border border-warning-6 bg-warning-3 p-4">
          <p className="text-xs font-semibold uppercase text-warning-11">
            Duplicate (deleted)
          </p>
          {loser ? (
            <>
              <p className="mt-1 font-medium text-foreground">
                {loser.firstName} {loser.lastName}
              </p>
              <p className="text-xs text-muted-foreground">{loser.email}</p>
              <div className="mt-2 flex gap-2">
                <Button variant="outline" size="sm" onClick={swap}>
                  <ArrowLeftRight className="mr-1 h-3 w-3" /> Swap
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLoser(null);
                    resetPreview();
                  }}
                >
                  Clear
                </Button>
              </div>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">No duplicate selected.</p>
          )}
        </div>
      </div>

      {/* Picker + suggestions */}
      {!loser && (
        <div className="mt-4 space-y-3">
          <MemberPicker
            label="Search for the duplicate member to merge in"
            placeholder="Type a name or email…"
            onSelect={(m) => {
              if (m.id === masterId) {
                toast.error("Pick a different member than the master.");
                return;
              }
              setLoser(m);
              resetPreview();
            }}
          />
          {suggestions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                Possible duplicates (same last name)
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    className="rounded-full border px-3 py-1 text-xs hover:bg-info-3"
                    onClick={() => {
                      setLoser({
                        id: s.id,
                        firstName: s.firstName,
                        lastName: s.lastName,
                        email: s.email,
                        ageTier: s.ageTier ?? "",
                      });
                      resetPreview();
                    }}
                  >
                    {s.firstName} {s.lastName} · {s.email}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {loser && !preview && (
        <Button className="mt-4" onClick={runPreview} disabled={loadingPreview}>
          {loadingPreview ? "Building preview…" : "Preview merge"}
        </Button>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-danger-6 bg-danger-3 p-3 text-sm text-danger-11">
          {error}
        </div>
      )}

      {/* Preview panel */}
      {preview && (
        <div className="mt-6 space-y-5">
          {preview.blockers.length > 0 && (
            <div className="rounded-lg border border-danger-6 bg-danger-3 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-danger-11">
                <AlertTriangle className="h-4 w-4" /> This merge is blocked
              </p>
              <ul className="mt-2 list-disc pl-5 text-sm text-danger-11">
                {preview.blockers.map((b) => (
                  <li key={b.code}>
                    {b.label}
                    {typeof b.count === "number" ? ` (${b.count})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Field diff */}
          <div>
            <h2 className="text-sm font-semibold text-foreground">Field merge</h2>
            {changedFields.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                No blank master fields will be filled — the master keeps all its
                own values.
              </p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-3">Field</th>
                      <th className="py-1 pr-3">Master</th>
                      <th className="py-1 pr-3">Duplicate</th>
                      <th className="py-1 pr-3">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changedFields.map((r) => {
                      const kind = rowValueKind(r);
                      return (
                        <tr key={r.field} className="border-t">
                          <td className="py-1 pr-3 font-medium">{r.field}</td>
                          <td className="py-1 pr-3 text-muted-foreground">
                            {formatMergeFieldValue(r.master, kind, clubTime.zone)}
                          </td>
                          <td className="py-1 pr-3 text-muted-foreground">
                            {formatMergeFieldValue(r.loser, kind, clubTime.zone)}
                          </td>
                          <td className="py-1 pr-3 font-medium text-success-11">
                            {formatMergeFieldValue(r.result, kind, clubTime.zone)}{" "}
                            <span className="text-muted-foreground">({r.source})</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Relation moves */}
          {preview.relationMoves.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-foreground">History moved</h2>
              <div className="mt-1 flex flex-wrap gap-2">
                {preview.relationMoves.map((m) => (
                  <span key={m.model} className="rounded border bg-muted px-2 py-1 text-xs">
                    {m.model}: {m.count}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Collisions */}
          {preview.collisions.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Duplicate rows resolved
              </h2>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {preview.collisions.map((c) => (
                  <li key={c.model}>
                    {c.model} — {c.resolution}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Warnings */}
          {preview.warnings.length > 0 && (
            <div className="rounded-lg border border-warning-6 bg-warning-3 p-3">
              <ul className="list-disc pl-5 text-xs text-warning-11">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Irreversible banner + confirmation */}
          {preview.blockers.length === 0 && (
            <div className="rounded-lg border-2 border-danger-7 bg-danger-3 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-danger-11">
                <AlertTriangle className="h-4 w-4" /> This cannot be undone
              </p>
              <p className="mt-1 text-xs text-danger-11">
                The duplicate <strong>{preview.loserName}</strong> will be
                permanently deleted. Type{" "}
                <code className="rounded bg-card px-1">{preview.confirmationPhrase}</code>{" "}
                to confirm.
              </p>
              <Input
                className="mt-3"
                value={confirmationText}
                onChange={(e) => setConfirmationText(e.target.value)}
                placeholder={preview.confirmationPhrase}
              />
              <div className="mt-3 flex gap-2">
                <Button
                  variant="destructive"
                  disabled={!canExecute || executing}
                  onClick={execute}
                >
                  {executing ? "Merging…" : "Merge and delete duplicate"}
                </Button>
                <Button variant="outline" onClick={runPreview} disabled={loadingPreview}>
                  Refresh preview
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
