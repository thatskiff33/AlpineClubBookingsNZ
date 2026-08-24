"use client";

import type { AgeTier } from "@prisma/client";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ViewOnlyActionButton,
  AdminViewOnlySectionBanner,
} from "@/components/admin/view-only-action";
import {
  useAdminAreaEditAccess,
  useAdminAreaViewAccess,
} from "@/hooks/use-admin-area-edit-access";
import { formatAgeTierName } from "@/lib/use-age-tier-options";
import { canonicalizeAgeTiers } from "@/lib/age-tier-schema";
import { loadAdminXeroContactGroups } from "@/lib/admin-xero-contact-groups";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";

type GroupingMode = "NONE" | "MEMBERSHIP_TYPE" | "MEMBERSHIP_TYPE_AND_AGE";
type RuleKind = "MANAGED" | "ACCEPTED";
const ANY = "__any__";

type Rule = {
  id: string;
  membershipTypeId: string | null;
  membershipTypeName: string | null;
  ageTiers: AgeTier[];
  mode: RuleKind;
  groupId: string;
  groupName: string | null;
  isActive: boolean;
  sortOrder: number;
};

/** Human label for a rule's tier set: the tier names, or "All age tiers". */
function formatRuleAgeTiers(ageTiers: AgeTier[]): string {
  if (!ageTiers || ageTiers.length === 0) {
    return "All age tiers";
  }
  return ageTiers.map(formatAgeTierName).join(", ");
}

type Config = {
  mode: GroupingMode;
  rules: Rule[];
  groups: Array<{ id: string; name: string; contactCount: number }>;
  lastRefreshedAt: string | null;
  membershipTypes: Array<{ id: string; name: string }>;
  ageTiers: AgeTier[];
};

type DiffEntry = {
  memberId: string;
  memberName: string;
  ageTier: AgeTier;
  addGroupId: string | null;
  managedGroup: { id: string; name: string | null } | null;
  removeGroupIds: string[];
};

type InformationalEntry = {
  memberId: string;
  memberName: string;
  ageTier: AgeTier;
  unexpectedManagedGroupIds: string[];
};

type Snapshot = {
  mode: GroupingMode;
  cacheReady: boolean;
  lastRefreshedAt: string | null;
  mismatchCount: number;
  addCount: number;
  removeCount: number;
  estimatedXeroCalls: number;
  membersConsidered: number;
  skippedNoContact: Array<{ memberId: string; memberName: string }>;
  mismatches: DiffEntry[];
  informationalCount: number;
  informational: InformationalEntry[];
};

const MODE_HELP: Record<GroupingMode, string> = {
  NONE: "None: existing Xero groups are left untouched. The system never adds or removes a contact's group membership, and never calls Xero.",
  MEMBERSHIP_TYPE: "Membership Type: only membership-type rules apply. Age-tier rules are shown but ignored.",
  MEMBERSHIP_TYPE_AND_AGE: "Membership Type + Age: the most specific rule wins — type+tier beats type-only beats tier-only.",
};

class ApiError extends Error {
  status: number;
  reason?: string;
  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.reason = reason;
  }
}

async function api(body: unknown) {
  const res = await fetch("/api/admin/xero/member-grouping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(json.error ?? "Request failed", res.status, json.reason);
  }
  return json;
}

export default function XeroMemberGroupingPage() {
  // The Xero contact-group cache refresh stamp is a real INSTANT (CT-4, #2870).
  const clubTime = useClubTime();
  // Mode/rule/bulk controls need finance:edit; the dry-run is read-only and
  // matches the API's finance:view guard (E1 pattern, #1934 review).
  const canEdit = useAdminAreaEditAccess("finance");
  const canView = useAdminAreaViewAccess("finance");
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // The persisted dry-run this UI is authorised against — threaded into the bulk
  // re-sync so the server can enforce freshness (#1961). Null until a dry-run is
  // run (or after a stale-dry-run rejection forces a fresh one).
  const [dryRunId, setDryRunId] = useState<string | null>(null);
  const [resyncState, setResyncState] = useState<{
    status: string;
    nextCursorMemberId: string | null;
    haltedByDailyLimit: boolean;
    failures: Array<{ memberId: string; error: string }>;
  } | null>(null);

  // New-rule draft
  const [draftTypeId, setDraftTypeId] = useState<string>(ANY);
  const [draftTiers, setDraftTiers] = useState<AgeTier[]>([]);
  const [draftMode, setDraftMode] = useState<RuleKind>("MANAGED");
  const [draftGroupId, setDraftGroupId] = useState<string>("");
  // "Refresh from Xero" busy state (re-pulls the contact-group cache, same
  // operation as the members-list "Refresh Xero Groups" button, #2093).
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/xero/member-grouping");
      if (!res.ok) throw new Error("Failed to load configuration");
      setConfig(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-pull the Xero contact-group cache (the same full refresh the members-list
  // "Refresh Xero Groups" button runs), then reload the config so the "Last
  // synced" header and the group picker reflect the new cache immediately. This
  // also moves the CONTACT_GROUP_FULL_REFRESH cursor that the dry-run's
  // freshness check anchors to, so an in-flight reviewed diff correctly
  // invalidates. Inline status callbacks — no toast lib (#2093, D-B3).
  const refreshFromXero = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    setRefreshStatus(null);
    try {
      const result = await loadAdminXeroContactGroups({ refreshFromXero: true });
      await load();
      setRefreshStatus(
        result.groups.length > 0
          ? "Refreshed from Xero."
          : "Refreshed from Xero. No active contact groups were returned.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh from Xero");
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const run = useCallback(
    async (body: unknown, after?: (json: unknown) => void) => {
      setBusy(true);
      setError(null);
      try {
        const json = await api(body);
        if (after) after(json);
        else setConfig(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const groupName = useCallback(
    (id: string) => config?.groups.find((g) => g.id === id)?.name ?? id,
    [config],
  );

  type BulkResult = {
    processed: number;
    added: number;
    removed: number;
    failed: number;
    done: boolean;
    haltedByDailyLimit: boolean;
    nextCursorMemberId: string | null;
    failures: Array<{ memberId: string; error: string }>;
  };

  const runBulkResync = useCallback(
    async (afterMemberId?: string) => {
      if (!dryRunId) {
        setError("Run the dry-run and review the diff before re-syncing.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const json = await api({
          action: "bulk-resync",
          dryRunId,
          confirmDryRunReviewed: true,
          ...(afterMemberId ? { afterMemberId } : {}),
        });
        const r = (json as { result: BulkResult }).result;
        setResyncState({
          status: `Processed ${r.processed} (added ${r.added}, removed ${r.removed}, failed ${r.failed}).`,
          nextCursorMemberId: r.done ? null : r.nextCursorMemberId,
          haltedByDailyLimit: r.haltedByDailyLimit,
          failures: r.failures,
        });
        void load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
        // A server-side dry-run freshness rejection (stale/absent dry-run, or a
        // rule/cache change since review) carries a `reason`. Invalidate the
        // reviewed diff so the admin must re-run the dry-run before retrying.
        if (err instanceof ApiError && err.reason) {
          setSnapshot(null);
          setDryRunId(null);
          setResyncState(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [dryRunId, load],
  );

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It is rendered in the pre-config branch
    too so the region exists from the first paint rather than from whenever the
    config fetch settles, and it sits OUTSIDE the `space-y-*` stack so the empty
    wrapper an edit-capable admin gets costs no layout.

    No children: the notice it replaces used the shared default reason, and the
    spec for this sweep is to carry the old copy over verbatim.

    The two controls gated on `canView` rather than `canEdit` are opted out too:
    finance edit implies finance view, so whenever `canView` is false `canEdit`
    is false as well and this banner is on screen covering them.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6" />
  );

  if (!config) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-4">
          <AdminPageHeader title="Xero member grouping" description="Loading…" />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <AdminPageHeader
        title="Xero member grouping"
        description="Choose how members are auto-sorted into Xero contact groups, and manage the grouping rules."
        actions={
          <ViewOnlyActionButton
            canEdit={canView}
            describeReason={false}
            readOnlyReason="Your admin role cannot view Xero member grouping."
            variant="outline"
            size="sm"
            disabled={refreshing || busy}
            onClick={() => void refreshFromXero()}
          >
            <RefreshCw className={`mr-1 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh from Xero"}
          </ViewOnlyActionButton>
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Last synced:</span>
        <span className="text-muted-foreground">
          {config.lastRefreshedAt
            ? clubTime.instantDateTime(requireInstant(config.lastRefreshedAt))
            : "never — refresh from Xero to populate the contact-group cache"}
        </span>
      </div>
      {refreshStatus ? <p className="text-sm text-success">{refreshStatus}</p> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Grouping mode</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(Object.keys(MODE_HELP) as GroupingMode[]).map((mode) => (
            <label key={mode} className="flex items-start gap-3">
              <input
                type="radio"
                name="grouping-mode"
                className="mt-1"
                checked={config.mode === mode}
                disabled={!canEdit || busy}
                onChange={() => void run({ action: "set-mode", mode })}
              />
              <span className="text-sm">
                <span className="font-medium">
                  {mode === "NONE" ? "None" : mode === "MEMBERSHIP_TYPE" ? "Membership Type" : "Membership Type + Age"}
                </span>
                <span className="block text-muted-foreground">{MODE_HELP[mode]}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            Changing the mode or a rule never re-groups existing members. Members re-group on their
            next trigger (age change, membership-type change, cron age-up, contact link) or when you
            run the bulk re-sync below.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Grouping rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {config.lastRefreshedAt
              ? "The Xero group picker below uses the cached contact-group list (see “Last synced” above). Use “Refresh from Xero” to update it."
              : "The Xero contact-group cache has not been refreshed yet — use “Refresh from Xero” above to populate it."}
          </p>

          {config.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rules yet.</p>
          ) : (
            <div className="space-y-2">
              {config.rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{rule.groupName ?? groupName(rule.groupId)}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{rule.mode}</span>
                      {!rule.isActive ? (
                        <span className="rounded bg-border px-1.5 py-0.5 text-xs">inactive</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {rule.membershipTypeName ?? "Any type"} · {formatRuleAgeTiers(rule.ageTiers)}
                      {config.mode === "MEMBERSHIP_TYPE" && rule.ageTiers.length > 0
                        ? " · (inert in Membership Type mode)"
                        : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run({ action: "toggle-rule", id: rule.id, isActive: !rule.isActive })
                      }
                    >
                      {rule.isActive ? "Deactivate" : "Activate"}
                    </ViewOnlyActionButton>
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      title="Members already in this group will not be removed."
                      onClick={() => {
                        if (
                          window.confirm(
                            "Delete this rule? Members already in this group will NOT be removed from it.",
                          )
                        ) {
                          void run({ action: "delete-rule", id: rule.id });
                        }
                      }}
                    >
                      Delete
                    </ViewOnlyActionButton>
                  </div>
                </div>
              ))}
            </div>
          )}

          {canEdit ? (
            <div className="grid grid-cols-1 gap-3 rounded-md border p-3 md:grid-cols-5">
              <div>
                <Label className="text-xs">Membership type</Label>
                <Select value={draftTypeId} onValueChange={setDraftTypeId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any type</SelectItem>
                    {config.membershipTypes.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Age tiers</Label>
                <div className="mt-1 space-y-1 rounded-md border p-2">
                  {config.ageTiers.map((tier) => (
                    <label key={tier} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draftTiers.includes(tier)}
                        onChange={(e) =>
                          setDraftTiers((prev) =>
                            e.target.checked
                              ? [...prev, tier]
                              : prev.filter((t) => t !== tier),
                          )
                        }
                      />
                      {formatAgeTierName(tier)}
                    </label>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    {draftTiers.length === 0
                      ? "None ticked = all age tiers."
                      : "Ticked tiers only."}
                  </p>
                </div>
              </div>
              <div>
                <Label className="text-xs">Rule kind</Label>
                <Select value={draftMode} onValueChange={(v) => setDraftMode(v as RuleKind)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MANAGED">Managed (add)</SelectItem>
                    <SelectItem value="ACCEPTED">Accepted (tolerate)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Xero group</Label>
                <Select value={draftGroupId} onValueChange={setDraftGroupId}>
                  <SelectTrigger><SelectValue placeholder="Select group" /></SelectTrigger>
                  <SelectContent>
                    {config.groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  size="sm"
                  disabled={busy || !draftGroupId}
                  onClick={() =>
                    void run(
                      {
                        action: "create-rule",
                        membershipTypeId: draftTypeId === ANY ? null : draftTypeId,
                        // Empty = "all age tiers"; the server canonical-sorts and
                        // collapses a full-tier selection. Canonicalize here too
                        // so the button never sends a redundant shape.
                        ageTiers: canonicalizeAgeTiers(draftTiers),
                        mode: draftMode,
                        groupId: draftGroupId,
                        groupName: groupName(draftGroupId),
                      },
                      (json) => {
                        setConfig(json as Config);
                        setDraftGroupId("");
                        setDraftTiers([]);
                      },
                    )
                  }
                >
                  Add rule
                </ViewOnlyActionButton>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bulk re-sync (advanced)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This is the heavyweight tool for re-grouping the whole membership at once — separate
            from the lightweight “Refresh from Xero” above, which only re-pulls the cached group
            list. Always preview the diff before re-syncing. The dry-run reads the local cache only
            and never calls Xero.
          </p>
          <div className="flex flex-wrap gap-2">
            <ViewOnlyActionButton
              canEdit={canView}
              describeReason={false}
              readOnlyReason="Your admin role cannot view Xero member grouping."
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run({ action: "dry-run" }, (json) => {
                  const j = json as { snapshot: Snapshot; dryRunId: string | null };
                  setSnapshot(j.snapshot);
                  setDryRunId(j.dryRunId);
                  setResyncState(null);
                })
              }
            >
              Run dry-run diff
            </ViewOnlyActionButton>
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              size="sm"
              disabled={
                busy ||
                !snapshot ||
                !dryRunId ||
                snapshot.mismatchCount === 0 ||
                // Once a run has been initiated from this dry-run, the server
                // rejects a second initiate (already_started, #1961) — continue
                // with "Resume re-sync", or re-run the dry-run to start over.
                Boolean(resyncState)
              }
              title={
                !snapshot || !dryRunId
                  ? "Run the dry-run first."
                  : resyncState
                    ? "This dry-run's re-sync has already started — use Resume re-sync, or re-run the dry-run to start over."
                    : undefined
              }
              onClick={() => {
                if (
                  window.confirm(
                    `Re-sync ${snapshot?.mismatchCount ?? 0} member(s) to Xero? You have reviewed the dry-run diff.`,
                  )
                ) {
                  void runBulkResync();
                }
              }}
            >
              Run bulk re-sync
            </ViewOnlyActionButton>
            {resyncState?.nextCursorMemberId ? (
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void runBulkResync(resyncState.nextCursorMemberId ?? undefined)}
              >
                Resume re-sync
              </ViewOnlyActionButton>
            ) : null}
          </div>
          {resyncState ? (
            <div className="space-y-1">
              <p className="text-sm text-success">{resyncState.status}</p>
              {resyncState.haltedByDailyLimit ? (
                <p className="text-sm text-danger">
                  Halted by the Xero daily API limit — resume tomorrow with the button above.
                </p>
              ) : resyncState.nextCursorMemberId ? (
                <p className="text-sm text-muted-foreground">
                  More members remain — use “Resume re-sync” to continue from where this chunk
                  stopped.
                </p>
              ) : null}
              {resyncState.failures.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs text-danger">
                    {resyncState.failures.length} member(s) failed (details are ledgered in Xero
                    sync operations):
                  </p>
                  {resyncState.failures.slice(0, 20).map((f) => (
                    <p key={f.memberId} className="text-xs text-muted-foreground">
                      {f.memberId}: {f.error}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {snapshot ? (
            <div className="space-y-2">
              {!snapshot.cacheReady ? (
                <p className="text-sm text-muted-foreground">
                  The Xero contact-group cache has not been refreshed — refresh it before relying on
                  this diff.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    Mode <strong>{snapshot.mode}</strong>: {snapshot.mismatchCount} member(s) would change —
                    {" "}{snapshot.addCount} add(s), {snapshot.removeCount} remove(s) across{" "}
                    {snapshot.membersConsidered} linked member(s). Estimated{" "}
                    <strong>{snapshot.estimatedXeroCalls}</strong> Xero call(s).
                  </p>
                  {snapshot.skippedNoContact.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {snapshot.skippedNoContact.length} member(s) without a Xero contact were skipped.
                    </p>
                  ) : null}
                  {snapshot.informationalCount > 0 ? (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        {snapshot.informationalCount} member(s) match no rule but currently sit in
                        managed group(s) — shown for information only. The bulk re-sync never
                        touches them; remove them in Xero manually if desired.
                      </p>
                      {snapshot.informational.slice(0, 50).map((m) => (
                        <div key={m.memberId} className="rounded border border-dashed p-2 text-xs text-muted-foreground">
                          <span className="font-medium">{m.memberName}</span> ({formatAgeTierName(m.ageTier)}) — in:{" "}
                          {m.unexpectedManagedGroupIds.map(groupName).join(", ")}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {snapshot.mismatches.length > 0 ? (
                    <div className="space-y-1">
                      {snapshot.mismatches.slice(0, 200).map((m) => (
                        <div key={m.memberId} className="rounded border p-2 text-xs">
                          <span className="font-medium">{m.memberName}</span> ({formatAgeTierName(m.ageTier)}) —{" "}
                          add: {m.addGroupId ? (m.managedGroup?.name ?? m.addGroupId) : "nothing"}; remove:{" "}
                          {m.removeGroupIds.length > 0 ? m.removeGroupIds.map(groupName).join(", ") : "nothing"}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-success">No changes — every linked member is correctly grouped.</p>
                  )}
                </>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
