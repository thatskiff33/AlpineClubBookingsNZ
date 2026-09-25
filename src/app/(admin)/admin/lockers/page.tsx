"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/confirm-dialog";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select";
import { LodgeScopeStatusNotice } from "@/components/admin/lodge-options-status";
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useClubFormat } from "@/components/club-format-provider";

type MemberSummary = {
  id: string;
  firstName: string;
  lastName: string;
};

type LockerRecord = {
  id: string;
  name: string;
  allocatedToMemberId: string | null;
  allocatedTo: MemberSummary | null;
};

type SortField = "name" | "allocatedTo";

function memberDisplayName(member: MemberSummary | null): string {
  if (!member) {
    return "Unallocated";
  }
  return `${member.firstName} ${member.lastName}`.trim();
}

function handleAllocatedToSearchKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
) {
  // Prevent Select typeahead from hijacking focus as users type in search.
  event.stopPropagation();
}

export default function LockersPage() {
  const { confirm, confirmDialog } = useConfirm();
  // Sorting and case-folding follow the CLUB's language (#3566, owner decision
  // 6) rather than a hard-coded New Zealand English collation.
  const { locale: clubLocale } = useClubFormat();
  // Lockers live under the membership area (their write routes enforce
  // membership:edit), so gate the editor on that area (#1940).
  const canEdit = useAdminAreaEditAccess("membership");
  // #2264 — the locker examples move out of the grey-inside-the-box position
  // where they read as names/counts already entered.
  const lockerNameHint = useFieldHint();
  const bulkCountHint = useFieldHint();
  const bulkPrefixHint = useFieldHint();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [allocatedToMemberId, setAllocatedToMemberId] =
    useState<string>("UNALLOCATED");
  const [allocatedToSearch, setAllocatedToSearch] = useState("");
  const [editingLockerId, setEditingLockerId] = useState<string | null>(null);
  const [deletingLockerId, setDeletingLockerId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [lockers, setLockers] = useState<LockerRecord[]>([]);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  // Lodge context for the page; LodgeSelect renders nothing (and reports the
  // sole lodge) while fewer than two lodges exist (ADR-002).
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
    reload: reloadLodgeOptions,
  } = useLodgeOptions("admin");
  // Hub links (ADR-003) land pre-filtered; read synchronously so the first
  // fetch is already lodge-filtered.
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation);
  const [bulkCount, setBulkCount] = useState("");
  const [bulkNamePrefix, setBulkNamePrefix] = useState("Locker");
  const [bulkSaving, setBulkSaving] = useState(false);
  /*
    #2701: a FAILED lodge list is not "a club with no lodges", but until now the
    two were the same empty array here. LodgeSelect renders nothing below two
    options (ADR-002) and normalises the selection to null, and an omitted
    lodgeId is resolved server-side to the club's DEFAULT lodge — so a lodge
    nobody chose would get its lockers listed, renamed, bulk-created and
    allocated to members, with no lodge named anywhere on screen. While that is
    true this page does no lodge-scoped work at all.

    A `?lodgeId=` hub link is retained through failure/retry, but remains inert
    until a successful lodge response validates that id. Loading, failure, 403,
    and a successful empty response are all distinct stopped states.
  */
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: lodgeId,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
  });
  const scopedLodgeId = lodgeScope.kind === "lodge" ? lodgeScope.lodgeId : null;
  const activeScopeRef = useRef<string | null>(scopedLodgeId);
  /*
    #2887: ownership follows the COMMIT, not the render, and this must stay a
    LAYOUT effect - a passive one is flushed after paint, leaving a window in
    which a late lodge-A response still reads A as current. Full reasoning and
    both mutation proofs live in one place:
    `src/lib/__tests__/lodge-scope-committed-ownership.test.tsx`.
  */
  useLayoutEffect(() => {
    activeScopeRef.current = scopedLodgeId;
  }, [scopedLodgeId]);
  const lodgeScopeReady = scopedLodgeId !== null;

  const loadData = useCallback(async (signal?: AbortSignal) => {
    // #2701: no lodge, no read. Clear what the pre-failure unscoped request
    // put on screen too — those are some other lodge's lockers.
    if (!scopedLodgeId) {
      setMembers([]);
      setLockers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/lockers?lodgeId=${encodeURIComponent(scopedLodgeId)}`,
        { signal },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Failed to load lockers");
      }

      setMembers(body.members ?? []);
      setLockers(body.lockers ?? []);
    } catch (loadError) {
      // An aborted request means the lodge changed (or the page unmounted);
      // a newer request owns the list now.
      if (loadError instanceof DOMException && loadError.name === "AbortError") {
        return;
      }
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load lockers",
      );
    } finally {
      setLoading(false);
    }
  }, [scopedLodgeId]);

  useEffect(() => {
    const controller = new AbortController();
    loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  async function handleFormSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!scopedLodgeId) return;
    const requestedScope = scopedLodgeId;
    setSaving(true);
    setError("");

    try {
      const payload = {
        name,
        allocatedToMemberId:
          allocatedToMemberId === "UNALLOCATED" ? null : allocatedToMemberId,
        // Lodge is set at creation from the page's lodge context and cannot
        // be changed by an update.
        ...(editingLockerId ? {} : { lodgeId: scopedLodgeId }),
      };
      const response = editingLockerId
        ? await fetch(`/api/admin/lockers/${editingLockerId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/lockers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const body = await response.json();
      if (!response.ok) {
        // Stale-tab / narrowed-permission save surfaces the persistent
        // forbidden-save reason in the existing error line (#1940).
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(
          body.error ||
            (editingLockerId
              ? "Failed to update locker"
              : "Failed to create locker"),
        );
      }
      if (activeScopeRef.current !== requestedScope) return;

      if (editingLockerId) {
        setLockers((previous) =>
          previous.map((locker) =>
            locker.id === editingLockerId ? body.locker : locker,
          ),
        );
      } else {
        setLockers((previous) => [...previous, body.locker]);
      }

      setEditingLockerId(null);
      setName("");
      setAllocatedToMemberId("UNALLOCATED");
      setAllocatedToSearch("");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : editingLockerId
            ? "Failed to update locker"
            : "Failed to create locker",
      );
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(locker: LockerRecord) {
    if (!lodgeScopeReady) return;
    setEditingLockerId(locker.id);
    setName(locker.name);
    setAllocatedToMemberId(locker.allocatedToMemberId ?? "UNALLOCATED");
    setAllocatedToSearch("");
    setError("");
  }

  function resetForm() {
    setEditingLockerId(null);
    setName("");
    setAllocatedToMemberId("UNALLOCATED");
    setAllocatedToSearch("");
    setError("");
  }

  function handleLodgeChange(nextLodgeId: string | null) {
    activeScopeRef.current = nextLodgeId;
    setLodgeId(nextLodgeId);
    setMembers([]);
    setLockers([]);
    setLoading(true);
    resetForm();
  }

  async function deleteLocker(locker: LockerRecord) {
    if (!lodgeScopeReady) return;
    const requestedScope = scopedLodgeId;
    if (
      !(await confirm({
        title: `Delete locker ${locker.name}?`,
        description: "This cannot be undone.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }

    setDeletingLockerId(locker.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/lockers/${locker.id}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(body?.error || "Failed to delete locker");
      }
      if (activeScopeRef.current !== requestedScope) return;

      setLockers((previous) =>
        previous.filter((current) => current.id !== locker.id),
      );
      if (editingLockerId === locker.id) {
        resetForm();
      }
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete locker",
      );
    } finally {
      setDeletingLockerId(null);
    }
  }

  async function bulkCreateLockers() {
    if (!scopedLodgeId) return;
    const requestedScope = scopedLodgeId;
    const count = Number(bulkCount);
    setBulkSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/lockers/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count,
          namePrefix: bulkNamePrefix.trim() || undefined,
          lodgeId: scopedLodgeId,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          return;
        }
        throw new Error(body.error || "Failed to create lockers");
      }
      if (activeScopeRef.current !== requestedScope) return;
      setBulkCount("");
      await loadData();
    } catch (bulkError) {
      setError(
        bulkError instanceof Error
          ? bulkError.message
          : "Failed to create lockers",
      );
    } finally {
      setBulkSaving(false);
    }
  }

  function toggleSort(nextField: SortField) {
    if (sortField === nextField) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }

    setSortField(nextField);
    setSortDirection("asc");
  }

  const sortedLockers = useMemo(() => {
    const clone = [...lockers];
    clone.sort((a, b) => {
      const aValue =
        sortField === "name" ? a.name : memberDisplayName(a.allocatedTo);
      const bValue =
        sortField === "name" ? b.name : memberDisplayName(b.allocatedTo);

      const result = aValue.localeCompare(bValue, clubLocale, {
        sensitivity: "base",
      });
      return sortDirection === "asc" ? result : -result;
    });

    return clone;
  }, [clubLocale, lockers, sortDirection, sortField]);

  const filteredMembers = useMemo(() => {
    const query = allocatedToSearch.trim().toLocaleLowerCase(clubLocale);
    if (!query) {
      return members;
    }

    return members.filter((member) =>
      memberDisplayName(member).toLocaleLowerCase(clubLocale).includes(query),
    );
  }, [allocatedToSearch, clubLocale, members]);

  const SortIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view lockers but cannot change them. Membership
      edit access is required.
    </AdminViewOnlySectionBanner>
  );

  /*
    #2701: heading, scope notice and selector are the only things that mean
    anything with no lodge resolved, so both returns render them.

    An EARLY RETURN, not a ternary around the cards: the locker list carries the
    shared dataset Reset, and `dataset-reset-contract` requires that control to
    be unconditional within the view showing the dataset. Two pages, and the one
    with the table always has its Reset.
  */
  const scopeChrome = (
    <>
      {confirmDialog}
      <AdminPageHeader
        title="Lockers"
        description="Create lockers and optionally allocate them to members."
      />

      {/* #2701: say the lodge list failed, above the lodge-scoped content it
          silently replaced with the default lodge's. */}
      <LodgeScopeStatusNotice
        scope={lodgeScope}
        onRetry={reloadLodgeOptions}
        what="lockers and their allocations"
      />

      <div className="max-w-xs">
        <LodgeSelect lodges={lodges} value={lodgeId} onChange={handleLodgeChange} loading={lodgesLoading}
            // #2701: an empty list from a FAILED request is not evidence the
            // caller's lodge is gone, so the ADR-002 normaliser must not wipe a
            // ?lodgeId= hub link (ADR-003) while the outage lasts.
            deferDefaultSelection={lodgeOptionsFailed || lodgeOptionsForbidden}
          />
      </div>
    </>
  );

  if (!lodgeScopeReady) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-6">{scopeChrome}</div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      {scopeChrome}
      <Card>
        <CardHeader>
          <CardTitle>{editingLockerId ? "Edit Locker" : "New Locker"}</CardTitle>
          <CardDescription>
            {editingLockerId
              ? "Update the locker name or member allocation."
              : "Add a locker name and optionally assign it to a member."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleFormSubmit}
            className="grid gap-4 sm:grid-cols-3"
          >
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="locker-name">Name</Label>
              <Input
                id="locker-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                // #2701: nothing here is safe to fill in while the lodge the
                // locker would be created against is unknown.
                disabled={!canEdit}
                {...lockerNameHint.fieldProps}
              />
              <FieldHint {...lockerNameHint.hintProps}>
                Example: Locker A1
              </FieldHint>
            </div>
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="locker-allocated">Allocated To</Label>
              <Select
                value={allocatedToMemberId}
                disabled={!canEdit}
                onValueChange={(value) => {
                  setAllocatedToMemberId(value);
                  setAllocatedToSearch("");
                }}
              >
                <SelectTrigger id="locker-allocated">
                  <SelectValue placeholder="Unallocated" />
                </SelectTrigger>
                <SelectContent>
                  <div className="p-2">
                    <Input
                      value={allocatedToSearch}
                      onChange={(event) =>
                        setAllocatedToSearch(event.target.value)
                      }
                      onKeyDown={handleAllocatedToSearchKeyDown}
                      placeholder="Search member"
                      className="h-8"
                    />
                  </div>
                  <SelectItem value="UNALLOCATED">Unallocated</SelectItem>
                  {filteredMembers.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {memberDisplayName(member)}
                    </SelectItem>
                  ))}
                  {filteredMembers.length === 0 ? (
                    <div className="px-2 pb-2 text-xs text-muted-foreground">
                      No members found.
                    </div>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2 sm:col-span-1">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                type="submit"
                disabled={saving}
                className="w-full sm:w-auto"
              >
                {saving
                  ? "Saving..."
                  : editingLockerId
                    ? "Update Locker"
                    : "Create Locker"}
              </ViewOnlyActionButton>
              {editingLockerId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={resetForm}
                  disabled={saving}
                  aria-label="Cancel locker edit"
                  title="Cancel locker edit"
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </form>
          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quick Add Lockers</CardTitle>
          <CardDescription>
            Seed several unallocated lockers at once, then rename or allocate
            them individually.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="bulk-locker-count">How many</Label>
              <Input
                id="bulk-locker-count"
                type="number"
                min={1}
                max={100}
                value={bulkCount}
                onChange={(event) => setBulkCount(event.target.value)}
                // #2701: a bulk create with no lodgeId seeds the DEFAULT
                // lodge — up to 100 lockers on the wrong property.
                disabled={!canEdit}
                {...bulkCountHint.fieldProps}
              />
              <FieldHint {...bulkCountHint.hintProps}>
                Between 1 and 100 lockers at a time.
              </FieldHint>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-locker-prefix">Name prefix</Label>
              <Input
                id="bulk-locker-prefix"
                value={bulkNamePrefix}
                onChange={(event) => setBulkNamePrefix(event.target.value)}
                disabled={!canEdit}
                {...bulkPrefixHint.fieldProps}
              />
              <FieldHint {...bulkPrefixHint.hintProps}>
                Each locker is numbered after the prefix — Locker 1, Locker 2, and
                so on.
              </FieldHint>
            </div>
            <div className="flex items-end">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                type="button"
                onClick={() => void bulkCreateLockers()}
                disabled={
                  bulkSaving ||
                  !bulkCount ||
                  Number(bulkCount) < 1 ||
                  false
                }
                className="w-full sm:w-auto"
              >
                {bulkSaving ? "Creating..." : "Create Lockers"}
              </ViewOnlyActionButton>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Locker List</CardTitle>
              <CardDescription>
                Sort by locker name or allocated member.
              </CardDescription>
            </div>
            <DatasetResetButton
              disabled={sortField === "name" && sortDirection === "asc"}
              onReset={() => {
                setSortField("name");
                setSortDirection("asc");
              }}
            />
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading lockers...</p>
          ) : sortedLockers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No lockers created yet.</p>
          ) : (
            <AdminDataTable>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-semibold"
                      onClick={() => toggleSort("name")}
                    >
                      Name
                      {sortField === "name" ? (
                        <SortIcon className="h-3.5 w-3.5" />
                      ) : null}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-semibold"
                      onClick={() => toggleSort("allocatedTo")}
                    >
                      Allocated To
                      {sortField === "allocatedTo" ? (
                        <SortIcon className="h-3.5 w-3.5" />
                      ) : null}
                    </button>
                  </TableHead>
                  <TableHead className="text-right font-semibold">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedLockers.map((locker) => (
                  <TableRow key={locker.id}>
                    <TableCell className="font-medium">{locker.name}</TableCell>
                    <TableCell>
                      {memberDisplayName(locker.allocatedTo)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => beginEdit(locker)}
                          disabled={!canEdit}
                          className="inline-flex h-8 w-8 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Edit locker ${locker.name}`}
                          title="Edit locker"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteLocker(locker)}
                          disabled={deletingLockerId === locker.id || !canEdit}
                          className="inline-flex h-8 w-8 items-center justify-center rounded border border-danger/30 text-danger transition-colors hover:bg-danger-muted disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Delete locker ${locker.name}`}
                          title="Delete locker"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </AdminDataTable>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
