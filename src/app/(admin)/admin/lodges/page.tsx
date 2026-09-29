"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Pencil, Plus, Settings2, X } from "lucide-react";
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
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  MAX_CONFIGURED_LODGE_CAPACITY,
  MIN_CONFIGURED_LODGE_CAPACITY,
  NEW_LODGE_CAPACITY_REQUIRED_MESSAGE,
  parseConfiguredLodgeCapacity,
} from "@/lib/lodge-effective-capacity";
import { OtherLodgesPanel } from "./_components/other-lodges-panel";

/**
 * The three lodge DETAIL fields, which `GET /api/admin/lodges` omits for a
 * caller holding no `lodge:view` (#2925).
 */
const LODGE_DETAIL_FIELDS = ["address", "doorCode", "travelNote"] as const;
type LodgeDetailField = (typeof LODGE_DETAIL_FIELDS)[number];

type LodgeRecord = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  // Optional since #2925: a narrowed payload carries none of the three.
  address?: string | null;
  doorCode?: string | null;
  travelNote?: string | null;
};

type LodgeFormState = {
  name: string;
  address: string;
  doorCode: string;
  travelNote: string;
  /** Maximum guests, as typed. Sent on create only (#3407). */
  capacity: string;
  /**
   * Which detail fields the record this form was seeded from actually carried
   * (#2925). A field missing here is OMITTED from the PATCH body rather than
   * sent as an empty string, because the PATCH route treats an absent key as
   * "leave unchanged" and a `null` as "clear it" — so seeding a form from a
   * narrowed record and saving it would otherwise WIPE the door code.
   *
   * BELT-AND-BRACES, and worth knowing which: the wipe is already impossible at
   * the server. The PATCH needs `lodge:edit`, the list narrows below
   * `lodge:view`, and `edit` outranks `view` in `LEVEL_RANK` — so any caller who
   * can write here was served the full record. This is kept because it is a few
   * lines and directly tested; it is deliberately not replicated in the lodge
   * setup wizard, where a second copy bought no reachable safety and made the
   * page reject any lodge fixture that omitted `doorCode`.
   */
  detailFields: readonly LodgeDetailField[];
};

const emptyForm: LodgeFormState = {
  name: "",
  address: "",
  doorCode: "",
  travelNote: "",
  capacity: "",
  // A create starts from a blank form the admin filled in themselves, so all
  // three values are theirs to send.
  detailFields: LODGE_DETAIL_FIELDS,
};

function formFromLodge(lodge: LodgeRecord): LodgeFormState {
  return {
    name: lodge.name,
    address: lodge.address ?? "",
    doorCode: lodge.doorCode ?? "",
    travelNote: lodge.travelNote ?? "",
    capacity: "",
    detailFields: LODGE_DETAIL_FIELDS.filter((field) => field in lodge),
  };
}

function formPayload(form: LodgeFormState) {
  const payload: {
    name: string;
    address?: string | null;
    doorCode?: string | null;
    travelNote?: string | null;
  } = { name: form.name.trim() };
  for (const field of form.detailFields) {
    payload[field] = form[field].trim() || null;
  }
  return payload;
}

export default function AdminLodgesPage() {
  const router = useRouter();
  // Lodge properties are lodge config; the write routes enforce lodge:edit, so
  // a lodge:view admin sees this screen read-only (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const [lodges, setLodges] = useState<LodgeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<LodgeFormState>(emptyForm);

  const loadLodges = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/lodges");
      if (!response.ok) {
        throw new Error("Failed to load lodges");
      }
      const data = (await response.json()) as { lodges: LodgeRecord[] };
      setLodges(data.lodges);
    } catch {
      setError("Could not load lodges. Please try again.");
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
  }

  function startEdit(lodge: LodgeRecord) {
    setEditingId(lodge.id);
    setCreating(false);
    setForm(formFromLodge(lodge));
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
    // Required on create only (#3407): an existing lodge's capacity is edited
    // on its configuration page, which explains it against the lodge's beds.
    // The same parse that page uses, so the bounds cannot drift from the ones
    // `POST /api/admin/lodges` enforces (INV-SSOT-001).
    const typedCapacity = parseConfiguredLodgeCapacity(form.capacity);
    if (creating && typedCapacity.kind !== "valid") {
      setError(NEW_LODGE_CAPACITY_REQUIRED_MESSAGE);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = creating
        ? await fetch("/api/admin/lodges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...formPayload(form),
              capacity:
                typedCapacity.kind === "valid" ? typedCapacity.capacity : null,
            }),
          })
        : await fetch(`/api/admin/lodges/${editingId}`, {
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
      if (creating) {
        // A new lodge lands straight in the guided setup wizard; identity is
        // pre-filled there and every remaining step can be skipped.
        const data = (await response.json()) as { lodge: LodgeRecord };
        router.push(`/admin/lodges/${encodeURIComponent(data.lodge.id)}/setup`);
        return;
      }
      cancelEdit();
      await loadLodges();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lodge");
    } finally {
      setSaving(false);
    }
  }

  async function setActive(lodge: LodgeRecord, active: boolean, force = false) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/lodges/${lodge.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(force ? { active, force: true } : { active }),
      });
      if (response.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
          code?: string;
          dependencies?: {
            futureBookings: number;
            waitlistEntries: number;
            hutLeaderAssignments: number;
            kioskBindings: number;
          };
        } | null;
        // Deactivation pre-flight: the lodge still has dependencies. Show what
        // they are and let the admin confirm; a confirmed retry sends force.
        if (
          !force &&
          data?.code === "LODGE_HAS_DEPENDENCIES" &&
          data.dependencies
        ) {
          const d = data.dependencies;
          const parts = [
            d.futureBookings ? `${d.futureBookings} future booking(s)` : null,
            d.waitlistEntries ? `${d.waitlistEntries} waitlist entry(ies)` : null,
            d.hutLeaderAssignments
              ? `${d.hutLeaderAssignments} hut-leader assignment(s)`
              : null,
            d.kioskBindings ? `${d.kioskBindings} bound kiosk account(s)` : null,
          ].filter(Boolean);
          const proceed = window.confirm(
            `${lodge.name} still has ${parts.join(", ")}. Deactivating stops new bookings but leaves these in place. Deactivate anyway?`,
          );
          if (proceed) {
            await setActive(lodge, active, true);
          }
          return;
        }
        throw new Error(data?.error ?? "Failed to update lodge");
      }
      await loadLodges();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update lodge");
    } finally {
      setSaving(false);
    }
  }

  const showForm = creating || editingId !== null;

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
      Your admin role can view the lodge properties but cannot change them.
      Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Lodges</h1>
          <p className="text-muted-foreground">
            Manage the club&apos;s lodge properties. Member-facing screens only
            change once a second active lodge exists.
          </p>
        </div>
        <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={startCreate} disabled={saving || showForm || loading || error !== null}>
          <Plus className="mr-2 h-4 w-4" />
          Add lodge
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
            <CardTitle>{creating ? "Add lodge" : "Edit lodge"}</CardTitle>
            <CardDescription>
              The address feeds the public {"{{lodge-address}}"} content token.
              The door code and travel note appear in booking and pre-arrival
              emails for this lodge.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="lodge-name">Name</Label>
              <Input
                id="lodge-name"
                value={form.name}
                maxLength={120}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, name: event.target.value }))
                }
              />
            </div>
            {creating ? (
              <div className="space-y-2">
                <Label htmlFor="lodge-capacity">Capacity (maximum guests)</Label>
                <Input
                  id="lodge-capacity"
                  type="number"
                  inputMode="numeric"
                  min={MIN_CONFIGURED_LODGE_CAPACITY}
                  max={MAX_CONFIGURED_LODGE_CAPACITY}
                  step={1}
                  required
                  aria-describedby="lodge-capacity-hint"
                  value={form.capacity}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, capacity: event.target.value }))
                  }
                />
                <p
                  id="lodge-capacity-hint"
                  className="text-sm text-muted-foreground"
                >
                  How many guests the lodge can sleep. Bookings are refused
                  above it, and a lodge without one cannot take a booking. You
                  can change it later on the lodge&apos;s configuration page.
                </p>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="lodge-address">Address</Label>
              <Textarea
                id="lodge-address"
                value={form.address}
                maxLength={300}
                rows={2}
                placeholder="Optional — feeds the public {{lodge-address}} token"
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, address: event.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lodge-door-code">Door code</Label>
              <Input
                id="lodge-door-code"
                value={form.doorCode}
                maxLength={80}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, doorCode: event.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lodge-travel-note">Travel note</Label>
              <Textarea
                id="lodge-travel-note"
                value={form.travelNote}
                maxLength={2000}
                rows={3}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    travelNote: event.target.value,
                  }))
                }
              />
            </div>
            <div className="flex gap-2">
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={() => void submitForm()} disabled={saving}>
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
            <Building2 className="h-5 w-5" />
            Lodge properties
          </CardTitle>
          <CardDescription>
            At least one lodge must stay active. Deactivated lodges are kept
            for history but cannot take new bookings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading lodges...</p>
          ) : error ? null : lodges.length === 0 ? (
            <p className="text-sm text-muted-foreground">No lodges found.</p>
          ) : (
            <ul className="divide-y">
              {lodges.map((lodge) => (
                <li
                  key={lodge.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{lodge.name}</span>
                      <Badge variant={lodge.active ? "default" : "secondary"}>
                        {lodge.active ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    {lodge.travelNote ? (
                      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                        {lodge.travelNote}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/admin/lodges/${lodge.id}`}>
                        <Settings2 className="mr-2 h-4 w-4" />
                        Configure
                      </Link>
                    </Button>
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
                      onClick={() => void setActive(lodge, !lodge.active)}
                      disabled={saving}
                    >
                      {lodge.active ? "Deactivate" : "Activate"}
                    </ViewOnlyActionButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <OtherLodgesPanel ancestorRendersViewOnlyBanner />
      </div>
    </div>
  );
}
