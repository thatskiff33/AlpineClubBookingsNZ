"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useClubTime } from "@/components/club-time-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type InductionKind,
  type InductionStatus,
  formatInductionDate,
  INDUCTION_KIND_LABELS,
  INDUCTION_STATUS_LABELS,
} from "@/lib/induction-display";

interface RegisterRow {
  id: string;
  kind: InductionKind;
  status: InductionStatus;
  requiredSignOffs: number;
  signOffCount: number;
  completedAt: string | null;
  completionSource: string | null;
  createdAt: string;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    ageTier: string;
  };
  assignedSigners: AssignedSigner[];
}

interface MemberResult {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface AssignedSigner {
  memberId: string;
  firstName: string;
  lastName: string;
  email: string;
  emailSentAt: string | null;
}

const STATUS_VARIANT: Record<
  InductionStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  DRAFT: "outline",
  IN_PROGRESS: "secondary",
  COMPLETED: "default",
  VOIDED: "destructive",
};

const KIND_OPTIONS: InductionKind[] = [
  "NEW_MEMBER",
  "HUT_LEADER",
  "RE_INDUCTION",
  "YOUTH_TO_FULL",
];

export function InductionRegisterTable() {
  const { hutLeaderLabel } = useClubIdentity();
  const clubTime = useClubTime();
  const { prompt, confirmDialog } = useConfirm();
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  // Create-induction state
  const [memberSearch, setMemberSearch] = useState("");
  const [memberResults, setMemberResults] = useState<MemberResult[]>([]);
  const [selectedMember, setSelectedMember] = useState<MemberResult | null>(null);
  const [newKind, setNewKind] = useState<InductionKind>("RE_INDUCTION");
  const [signerSearch, setSignerSearch] = useState("");
  const [signerResults, setSignerResults] = useState<MemberResult[]>([]);
  const [selectedSigners, setSelectedSigners] = useState<MemberResult[]>([]);
  const [reassignRowId, setReassignRowId] = useState<string | null>(null);
  const [reassignSigners, setReassignSigners] = useState<MemberResult[]>([]);
  const [reassignSearch, setReassignSearch] = useState("");
  const [reassignResults, setReassignResults] = useState<MemberResult[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/admin/inductions?${params.toString()}`, {
        credentials: "same-origin",
      });
      const body = await res.json();
      setRows(body.inductions ?? []);
    } catch {
      toast.error("Failed to load register");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function searchMembers() {
    if (!memberSearch.trim()) return;
    const res = await fetch(
      `/api/admin/members?search=${encodeURIComponent(memberSearch.trim())}`,
      { credentials: "same-origin" }
    );
    const body = await res.json().catch(() => ({}));
    setMemberResults((body.members ?? []).slice(0, 10));
  }

  async function searchSigners() {
    if (!signerSearch.trim()) return;
    const res = await fetch(
      `/api/admin/members?search=${encodeURIComponent(signerSearch.trim())}`,
      { credentials: "same-origin" }
    );
    const body = await res.json().catch(() => ({}));
    const results: MemberResult[] = (body.members ?? []).slice(0, 10);
    setSignerResults(results.filter((m) => !selectedSigners.some((s) => s.id === m.id)));
  }

  function addSigner(member: MemberResult) {
    setSelectedSigners((prev) =>
      prev.some((s) => s.id === member.id) ? prev : [...prev, member]
    );
    setSignerSearch("");
    setSignerResults([]);
  }

  function removeSigner(id: string) {
    setSelectedSigners((prev) => prev.filter((s) => s.id !== id));
  }

  function startReassign(row: RegisterRow) {
    setReassignRowId(row.id);
    setReassignSigners(
      row.assignedSigners.map((signer) => ({
        id: signer.memberId,
        firstName: signer.firstName,
        lastName: signer.lastName,
        email: signer.email,
      }))
    );
    setReassignSearch("");
    setReassignResults([]);
  }

  async function searchReassignSigners() {
    if (!reassignSearch.trim()) return;
    const res = await fetch(
      `/api/admin/members?search=${encodeURIComponent(reassignSearch.trim())}`,
      { credentials: "same-origin" }
    );
    const body = await res.json().catch(() => ({}));
    const results: MemberResult[] = (body.members ?? []).slice(0, 10);
    setReassignResults(
      results.filter((m) => !reassignSigners.some((s) => s.id === m.id))
    );
  }

  function addReassignSigner(member: MemberResult) {
    setReassignSigners((prev) =>
      prev.some((s) => s.id === member.id) ? prev : [...prev, member]
    );
    setReassignSearch("");
    setReassignResults([]);
  }

  function removeReassignSigner(id: string) {
    setReassignSigners((prev) => prev.filter((s) => s.id !== id));
  }

  async function saveReassignSigners() {
    if (!reassignRowId) return;
    const res = await fetch(`/api/admin/inductions/${reassignRowId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        action: "REASSIGN_SIGNERS",
        signerMemberIds: reassignSigners.map((signer) => signer.id),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Failed to reassign signers");
      return;
    }
    toast.success("Assigned signers updated");
    setReassignRowId(null);
    setReassignSigners([]);
    setReassignResults([]);
    setReassignSearch("");
    void load();
  }

  async function createInduction() {
    if (!selectedMember) return;
    const res = await fetch("/api/admin/inductions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        memberId: selectedMember.id,
        kind: newKind,
        signerMemberIds: selectedSigners.map((s) => s.id),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Failed to create induction");
      return;
    }
    toast.success(
      selectedSigners.length > 0
        ? `Induction created — sign-off request emails sent to ${selectedSigners.length} signer${selectedSigners.length === 1 ? "" : "s"}`
        : "Induction created"
    );
    setSelectedMember(null);
    setMemberResults([]);
    setMemberSearch("");
    setSelectedSigners([]);
    setSignerSearch("");
    void load();
  }

  async function overrideComplete(id: string) {
    const res = await fetch(`/api/admin/inductions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "OVERRIDE_COMPLETE" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "Failed to complete induction");
      return;
    }
    toast.success("Induction marked complete");
    void load();
  }

  async function voidInductionRow(id: string) {
    const reason = await prompt({
      title: "Void this induction?",
      inputLabel: "Reason",
      confirmLabel: "Void induction",
      destructive: true,
    });
    if (!reason) return;
    const res = await fetch(`/api/admin/inductions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "VOID", reason }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "Failed to void induction");
      return;
    }
    toast.success("Induction voided");
    void load();
  }

  return (
    <div className="space-y-6">
      {confirmDialog}
      <Card>
        <CardHeader>
          <CardTitle>Start an induction</CardTitle>
          <CardDescription>
            Create a New Member, {hutLeaderLabel}, youth-to-full, or re-induction
            workflow for an existing member.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="text-xs">Find member</label>
              <Input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void searchMembers();
                }}
                placeholder="Name or email"
                className="w-64"
              />
            </div>
            <Button size="sm" variant="outline" onClick={searchMembers}>
              Search
            </Button>
            <div className="space-y-1">
              <label className="text-xs">Type</label>
              <select
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as InductionKind)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {KIND_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>
                    {INDUCTION_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              onClick={createInduction}
              disabled={!selectedMember}
            >
              Create induction
            </Button>
          </div>
          {selectedMember && (
            <p className="text-sm">
              Selected:{" "}
              <strong>
                {selectedMember.firstName} {selectedMember.lastName}
              </strong>{" "}
              ({selectedMember.email})
            </p>
          )}
          {memberResults.length > 0 && (
            <ul className="space-y-1">
              {memberResults.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedMember(member)}
                    className="text-sm text-primary hover:underline"
                  >
                    {member.firstName} {member.lastName} — {member.email}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t pt-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Assign signers (optional) — they will receive a sign-off request email
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label className="text-xs">Find signer</label>
                <Input
                  value={signerSearch}
                  onChange={(e) => setSignerSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void searchSigners();
                  }}
                  placeholder="Name or email"
                  className="w-64"
                />
              </div>
              <Button size="sm" variant="outline" onClick={searchSigners}>
                Search
              </Button>
            </div>
            {signerResults.length > 0 && (
              <ul className="space-y-1">
                {signerResults.map((member) => (
                  <li key={member.id}>
                    <button
                      type="button"
                      onClick={() => addSigner(member)}
                      className="text-sm text-primary hover:underline"
                    >
                      + {member.firstName} {member.lastName} — {member.email}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedSigners.length > 0 && (
              <ul className="space-y-1">
                {selectedSigners.map((signer) => (
                  <li key={signer.id} className="flex items-center gap-2 text-sm">
                    <span>
                      {signer.firstName} {signer.lastName}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeSigner(signer.id)}
                      className="text-xs text-destructive hover:underline"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Induction register</CardTitle>
          <CardDescription>
            Signed induction records and assigned signers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search member"
              className="w-56"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">All statuses</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="COMPLETED">Completed</option>
              <option value="DRAFT">Draft</option>
              <option value="VOIDED">Voided</option>
            </select>
            <DatasetResetButton
              disabled={search === "" && statusFilter === ""}
              onReset={() => {
                setSearch("");
                setStatusFilter("");
              }}
            />
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No induction records found.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sign-offs</TableHead>
                  <TableHead>Signers</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <Fragment key={row.id}>
                    <TableRow>
                      <TableCell>
                        <div className="font-medium">
                          {row.member.firstName} {row.member.lastName}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {row.member.email}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {INDUCTION_KIND_LABELS[row.kind]}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[row.status]}>
                          {INDUCTION_STATUS_LABELS[row.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.signOffCount}/{row.requiredSignOffs}
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.assignedSigners.length > 0
                          ? row.assignedSigners
                              .map((signer) => `${signer.firstName} ${signer.lastName}`)
                              .join(", ")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatInductionDate(row.completedAt, clubTime) ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/admin/induction/${row.id}/print`}>
                              View
                            </Link>
                          </Button>
                          {row.status !== "VOIDED" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => startReassign(row)}
                            >
                              Signers
                            </Button>
                          )}
                          {row.status !== "COMPLETED" &&
                            row.status !== "VOIDED" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => overrideComplete(row.id)}
                              >
                                Complete
                              </Button>
                            )}
                          {row.status !== "VOIDED" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => voidInductionRow(row.id)}
                            >
                              Void
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {reassignRowId === row.id && (
                      <TableRow>
                        <TableCell colSpan={7}>
                          <div className="space-y-3 rounded-md border bg-muted p-3">
                            <p className="text-sm font-medium">
                              Assigned signers for {row.member.firstName}{" "}
                              {row.member.lastName}
                            </p>
                            <div className="flex flex-wrap items-end gap-2">
                              <div className="space-y-1">
                                <label className="text-xs">Find signer</label>
                                <Input
                                  value={reassignSearch}
                                  onChange={(e) => setReassignSearch(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") void searchReassignSigners();
                                  }}
                                  placeholder="Name or email"
                                  className="w-64"
                                />
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={searchReassignSigners}
                              >
                                Search
                              </Button>
                            </div>
                            {reassignResults.length > 0 && (
                              <ul className="space-y-1">
                                {reassignResults.map((member) => (
                                  <li key={member.id}>
                                    <button
                                      type="button"
                                      onClick={() => addReassignSigner(member)}
                                      className="text-sm text-primary hover:underline"
                                    >
                                      + {member.firstName} {member.lastName} —{" "}
                                      {member.email}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {reassignSigners.length > 0 ? (
                              <ul className="space-y-1">
                                {reassignSigners.map((signer) => (
                                  <li
                                    key={signer.id}
                                    className="flex items-center gap-2 text-sm"
                                  >
                                    <span>
                                      {signer.firstName} {signer.lastName}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => removeReassignSigner(signer.id)}
                                      className="text-xs text-destructive hover:underline"
                                    >
                                      Remove
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-sm text-muted-foreground">
                                No explicit signers assigned.
                              </p>
                            )}
                            <div className="flex gap-2">
                              <Button size="sm" onClick={saveReassignSigners}>
                                Save signers
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setReassignRowId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
