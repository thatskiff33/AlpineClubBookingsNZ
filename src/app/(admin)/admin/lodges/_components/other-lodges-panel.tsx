"use client";

import { useCallback, useEffect, useState } from "react";
import { Building, Pencil, Plus, Trash2, X } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

type OtherLodgeRecord = {
  id: string;
  name: string;
  location: string | null;
  bookingOfficerName: string | null;
  bookingOfficerEmail: string | null;
  bookingOfficerPhone: string | null;
  bedCapacity: number | null;
  active: boolean;
};

type OtherLodgeFormState = {
  name: string;
  location: string;
  bookingOfficerName: string;
  bookingOfficerEmail: string;
  bookingOfficerPhone: string;
  bedCapacity: string;
};

const emptyForm: OtherLodgeFormState = {
  name: "",
  location: "",
  bookingOfficerName: "",
  bookingOfficerEmail: "",
  bookingOfficerPhone: "",
  bedCapacity: "",
};

function formFromLodge(lodge: OtherLodgeRecord): OtherLodgeFormState {
  return {
    name: lodge.name,
    location: lodge.location ?? "",
    bookingOfficerName: lodge.bookingOfficerName ?? "",
    bookingOfficerEmail: lodge.bookingOfficerEmail ?? "",
    bookingOfficerPhone: lodge.bookingOfficerPhone ?? "",
    bedCapacity:
      lodge.bedCapacity === null ? "" : String(lodge.bedCapacity),
  };
}

// Blank text fields save as null; bed capacity parses to an integer or null.
function formPayload(form: OtherLodgeFormState) {
  const capacity = form.bedCapacity.trim();
  return {
    name: form.name.trim(),
    location: form.location.trim() || null,
    bookingOfficerName: form.bookingOfficerName.trim() || null,
    bookingOfficerEmail: form.bookingOfficerEmail.trim() || null,
    bookingOfficerPhone: form.bookingOfficerPhone.trim() || null,
    bedCapacity: capacity === "" ? null : Number(capacity),
  };
}

export function OtherLodgesPanel() {
  // Same edit gate as the club's own lodges: the write routes enforce lodge:edit,
  // so a lodge:view admin sees this panel read-only.
  const canEdit = useAdminAreaEditAccess("lodge");
  const [lodges, setLodges] = useState<OtherLodgeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<OtherLodgeFormState>(emptyForm);

  const loadLodges = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/other-lodges");
      if (!response.ok) {
        throw new Error("Failed to load other lodges");
      }
      const data = (await response.json()) as {
        otherLodges: OtherLodgeRecord[];
      };
      setLodges(data.otherLodges);
    } catch {
      setError("Could not load other lodges. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLodges();
  }, [loadLodges]);

  function startCreate() {
    setCreating(true);
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  function startEdit(lodge: OtherLodgeRecord) {
    setEditingId(lodge.id);
    setCreating(false);
    setForm(formFromLodge(lodge));
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setCreating(false);
    setForm(emptyForm);
  }

  async function submitForm() {
    if (!form.name.trim()) {
      setError("Lodge name is required.");
      return;
    }
    const capacity = form.bedCapacity.trim();
    if (capacity !== "" && !/^\d+$/.test(capacity)) {
      setError("Bed capacity must be a whole number.");
      return;
    }
    // Mirror the server's upper bound so an unrealistic value gets a clear
    // inline message instead of a generic "Invalid input" from the API.
    if (capacity !== "" && Number(capacity) > 100_000) {
      setError("Bed capacity looks too large. Enter a realistic number.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = creating
        ? await fetch("/api/admin/other-lodges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(formPayload(form)),
          })
        : await fetch(`/api/admin/other-lodges/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(formPayload(form)),
          });
      if (response.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? "Failed to save lodge");
      }
      cancelEdit();
      await loadLodges();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lodge");
    } finally {
      setSaving(false);
    }
  }

  async function setActive(lodge: OtherLodgeRecord, active: boolean) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/other-lodges/${lodge.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (response.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? "Failed to update lodge");
      }
      await loadLodges();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update lodge");
    } finally {
      setSaving(false);
    }
  }

  async function deleteLodge(lodge: OtherLodgeRecord) {
    if (
      !window.confirm(
        `Delete "${lodge.name}"? This removes it from the list for good.`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/other-lodges/${lodge.id}`, {
        method: "DELETE",
      });
      if (response.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? "Failed to delete lodge");
      }
      await loadLodges();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete lodge");
    } finally {
      setSaving(false);
    }
  }

  const showForm = creating || editingId !== null;

  return (
    <div className="space-y-4">
      <AdminViewOnlySectionBanner canEdit={canEdit}>
        Your admin role can view other lodges but cannot change them. Lodge edit
        access is required.
      </AdminViewOnlySectionBanner>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Other lodges</h2>
          <p className="text-sm text-muted-foreground">
            Details of other clubs&apos; lodges the club recognises. Their names
            will be offered to non-members when they indicate they are a member
            of another lodge.
          </p>
        </div>
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          onClick={startCreate}
          disabled={saving || showForm}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add other lodge
        </ViewOnlyActionButton>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {creating ? "Add other lodge" : "Edit other lodge"}
            </CardTitle>
            <CardDescription>
              Only the name is required. Everything else is optional contact and
              capacity detail.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="other-lodge-name">Name</Label>
                <Input
                  id="other-lodge-name"
                  value={form.name}
                  maxLength={120}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="other-lodge-location">Location</Label>
                <Input
                  id="other-lodge-location"
                  value={form.location}
                  maxLength={300}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      location: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="other-lodge-officer-name">
                  Booking officer&apos;s name
                </Label>
                <Input
                  id="other-lodge-officer-name"
                  value={form.bookingOfficerName}
                  maxLength={200}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      bookingOfficerName: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="other-lodge-officer-email">
                  Booking officer&apos;s email
                </Label>
                <Input
                  id="other-lodge-officer-email"
                  type="email"
                  value={form.bookingOfficerEmail}
                  maxLength={320}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      bookingOfficerEmail: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="other-lodge-officer-phone">
                  Booking officer&apos;s phone
                </Label>
                <Input
                  id="other-lodge-officer-phone"
                  value={form.bookingOfficerPhone}
                  maxLength={50}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      bookingOfficerPhone: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="other-lodge-bed-capacity">Bed capacity</Label>
                <Input
                  id="other-lodge-bed-capacity"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={form.bedCapacity}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      bedCapacity: event.target.value,
                    }))
                  }
                />
              </div>
            </div>
            <div className="flex gap-2">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={() => void submitForm()}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save"}
              </ViewOnlyActionButton>
              <Button variant="outline" onClick={cancelEdit} disabled={saving}>
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building className="h-5 w-5" />
            Other lodges
          </CardTitle>
          <CardDescription>
            Inactive lodges are kept for history but will be hidden from the
            non-member drop-down.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">
              Loading other lodges...
            </p>
          ) : lodges.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other lodges yet. Use &ldquo;Add other lodge&rdquo; to add one.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Booking officer</TableHead>
                    <TableHead className="text-right">Beds</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lodges.map((lodge) => (
                    <TableRow key={lodge.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{lodge.name}</span>
                          {!lodge.active ? (
                            <Badge variant="secondary">Inactive</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {lodge.location ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {lodge.bookingOfficerName ? (
                          <div>
                            <div>{lodge.bookingOfficerName}</div>
                            {lodge.bookingOfficerEmail ? (
                              <div className="text-xs">
                                {lodge.bookingOfficerEmail}
                              </div>
                            ) : null}
                            {lodge.bookingOfficerPhone ? (
                              <div className="text-xs">
                                {lodge.bookingOfficerPhone}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {lodge.bedCapacity ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            describeReason={false}
                            variant="outline"
                            size="sm"
                            onClick={() => startEdit(lodge)}
                            disabled={saving}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </ViewOnlyActionButton>
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            describeReason={false}
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              void setActive(lodge, !lodge.active)
                            }
                            disabled={saving}
                          >
                            {lodge.active ? "Deactivate" : "Activate"}
                          </ViewOnlyActionButton>
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            describeReason={false}
                            variant="outline"
                            size="sm"
                            onClick={() => void deleteLodge(lodge)}
                            disabled={saving}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </ViewOnlyActionButton>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
