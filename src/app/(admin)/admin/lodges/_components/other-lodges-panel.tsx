"use client";

import { useCallback, useEffect, useState } from "react";
import { Building, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  AMENITIES_PER_LODGE_MAX,
  isHttpUrl,
  type OtherLodgeBooleanField,
  type SerializedOtherLodge,
} from "@/lib/other-lodges";

// The API's own shape, not a hand-copied one: a column added to the shared
// field list in `@/lib/other-lodges` fails to compile here until the form
// carries it, instead of being silently dropped from the editor (#50).
type OtherLodgeRecord = SerializedOtherLodge;
type OtherLodgePayload = Omit<OtherLodgeRecord, "id" | "createdAt" | "updatedAt">;

// `Record` over the shared field type: a facility missing a label here is a
// compile error, so the checklist cannot fall behind the schema.
const FACILITY_LABELS: Record<OtherLodgeBooleanField, string> = {
  requiresLodgeCustodian: "Requires a lodge custodian",
  freeWifi: "Free wifi",
  quietRoom: "Quiet room",
  dryingRoom: "Drying room",
  sharedKitchen: "Shared kitchen",
  wheelchairAccessible: "Wheelchair accessible",
  breakfastIncluded: "Breakfast included",
  lunchIncluded: "Lunch included",
  dinnerIncluded: "Dinner included",
};
const FACILITY_FIELDS = Object.keys(FACILITY_LABELS) as OtherLodgeBooleanField[];

type AmenityFormRow = { name: string; description: string };

type OtherLodgeFormState = {
  name: string;
  location: string;
  bookingOfficerName: string;
  bookingOfficerEmail: string;
  bookingOfficerPhone: string;
  bedCapacity: string;
  siteUrl: string;
  bookingPath: string;
  cancellationPeriod: string;
  /** `YYYY-MM-DD` from a date input, or "" — never a `Date`. */
  winterSeasonStart: string;
  summerSeasonStart: string;
  facilities: Record<OtherLodgeBooleanField, boolean>;
  amenities: AmenityFormRow[];
};

const noFacilities = Object.fromEntries(
  FACILITY_FIELDS.map((field) => [field, false]),
) as Record<OtherLodgeBooleanField, boolean>;

const emptyForm: OtherLodgeFormState = {
  name: "",
  location: "",
  bookingOfficerName: "",
  bookingOfficerEmail: "",
  bookingOfficerPhone: "",
  bedCapacity: "",
  siteUrl: "",
  bookingPath: "",
  cancellationPeriod: "",
  winterSeasonStart: "",
  summerSeasonStart: "",
  facilities: noFacilities,
  amenities: [],
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
    siteUrl: lodge.siteUrl ?? "",
    bookingPath: lodge.bookingPath ?? "",
    cancellationPeriod: lodge.cancellationPeriod ?? "",
    winterSeasonStart: lodge.winterSeasonStart ?? "",
    summerSeasonStart: lodge.summerSeasonStart ?? "",
    facilities: Object.fromEntries(
      FACILITY_FIELDS.map((field) => [field, lodge[field]]),
    ) as Record<OtherLodgeBooleanField, boolean>,
    amenities: lodge.amenities.map((a) => ({
      name: a.name,
      description: a.description ?? "",
    })),
  };
}

// Blank text fields save as null; bed capacity parses to an integer or null;
// dates travel as the `YYYY-MM-DD` string the input holds. The return type is
// the API's shape, so a missing field is a compile error.
function formPayload(form: OtherLodgeFormState): OtherLodgePayload {
  const capacity = form.bedCapacity.trim();
  return {
    name: form.name.trim(),
    location: form.location.trim() || null,
    bookingOfficerName: form.bookingOfficerName.trim() || null,
    bookingOfficerEmail: form.bookingOfficerEmail.trim() || null,
    bookingOfficerPhone: form.bookingOfficerPhone.trim() || null,
    bedCapacity: capacity === "" ? null : Number(capacity),
    siteUrl: form.siteUrl.trim() || null,
    bookingPath: form.bookingPath.trim() || null,
    cancellationPeriod: form.cancellationPeriod.trim() || null,
    winterSeasonStart: form.winterSeasonStart.trim() || null,
    summerSeasonStart: form.summerSeasonStart.trim() || null,
    ...form.facilities,
    amenities: form.amenities.map((a) => ({
      name: a.name.trim(),
      description: a.description.trim() || null,
    })),
  };
}

/** The inline message for a form the API would refuse, or null when it is fine. */
function formProblem(form: OtherLodgeFormState): string | null {
  if (!form.name.trim()) return "Lodge name is required.";
  const capacity = form.bedCapacity.trim();
  if (capacity !== "" && !/^\d+$/.test(capacity)) {
    return "Bed capacity must be a whole number.";
  }
  // Mirror the server's upper bound so an unrealistic value gets a clear
  // inline message instead of a generic "Invalid input" from the API.
  if (capacity !== "" && Number(capacity) > 100_000) {
    return "Bed capacity looks too large. Enter a realistic number.";
  }
  const siteUrl = form.siteUrl.trim();
  if (siteUrl && !isHttpUrl(siteUrl)) {
    return "The site URL must start with http:// or https://.";
  }
  if (form.amenities.length > AMENITIES_PER_LODGE_MAX) {
    return `A lodge can list at most ${AMENITIES_PER_LODGE_MAX} amenities.`;
  }
  const names = form.amenities.map((a) => a.name.trim());
  if (names.some((n) => !n)) return "Every amenity needs a name.";
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    return "Amenity names must be unique within a lodge.";
  }
  return null;
}

export function OtherLodgesPanel({
  // #2160/#2168 vouch: the Lodges page renders one lodge-area
  // AdminViewOnlySectionBanner above this panel and passes `true` at the render
  // site, so this panel does not render its own banner (that would nest two) and
  // its controls opt out of the per-button reason. Defaults false so the panel
  // still explains itself if ever rendered without a covering banner.
  ancestorRendersViewOnlyBanner = false,
}: {
  ancestorRendersViewOnlyBanner?: boolean;
}) {
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
        otherLodges?: OtherLodgeRecord[];
      };
      setLodges(Array.isArray(data?.otherLodges) ? data.otherLodges : []);
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

  function setText(
    field: Exclude<keyof OtherLodgeFormState, "facilities" | "amenities">,
    value: string,
  ) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function setAmenity(index: number, patch: Partial<AmenityFormRow>) {
    setForm((prev) => ({
      ...prev,
      amenities: prev.amenities.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));
  }

  async function submitForm() {
    const problem = formProblem(form);
    if (problem) {
      setError(problem);
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

  const textField = (
    field: Exclude<keyof OtherLodgeFormState, "facilities" | "amenities">,
    label: string,
    props: { type?: string; maxLength?: number; placeholder?: string } = {},
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`other-lodge-${field}`}>{label}</Label>
      <Input
        id={`other-lodge-${field}`}
        value={form[field]}
        onChange={(event) => setText(field, event.target.value)}
        {...props}
      />
    </div>
  );

  return (
    <div className="space-y-4">
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
          describeReason={!ancestorRendersViewOnlyBanner}
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
              Only the name is required. Everything else is optional detail that
              is shared with other clubs through the Alpine Central Server when
              that connection is on.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              {textField("name", "Name", { maxLength: 120 })}
              {textField("location", "Location", { maxLength: 300 })}
              {textField("bookingOfficerName", "Booking officer's name", {
                maxLength: 200,
              })}
              {textField("bookingOfficerEmail", "Booking officer's email", {
                type: "email",
                maxLength: 320,
              })}
              {textField("bookingOfficerPhone", "Booking officer's phone", {
                maxLength: 50,
              })}
              <div className="space-y-2">
                <Label htmlFor="other-lodge-bedCapacity">Bed capacity</Label>
                <Input
                  id="other-lodge-bedCapacity"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={form.bedCapacity}
                  onChange={(event) =>
                    setText("bedCapacity", event.target.value)
                  }
                />
              </div>
              {textField("siteUrl", "Website", {
                type: "url",
                maxLength: 500,
                placeholder: "https://",
              })}
              {textField("bookingPath", "How to book", { maxLength: 300 })}
              {textField("cancellationPeriod", "Cancellation period", {
                maxLength: 200,
              })}
              {textField("winterSeasonStart", "Winter season starts", {
                type: "date",
              })}
              {textField("summerSeasonStart", "Summer season starts", {
                type: "date",
              })}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Facilities</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {FACILITY_FIELDS.map((field) => (
                  <label
                    key={field}
                    className="flex items-center gap-2 text-sm"
                    htmlFor={`other-lodge-${field}`}
                  >
                    <Checkbox
                      id={`other-lodge-${field}`}
                      checked={form.facilities[field]}
                      onCheckedChange={(checked) =>
                        setForm((prev) => ({
                          ...prev,
                          facilities: { ...prev.facilities, [field]: checked },
                        }))
                      }
                    />
                    {FACILITY_LABELS[field]}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Amenities</legend>
              <p className="text-xs text-muted-foreground">
                Anything else the lodge offers, one per row. Up to{" "}
                {AMENITIES_PER_LODGE_MAX}; names must be unique.
              </p>
              {form.amenities.map((row, index) => (
                <div
                  key={index}
                  className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
                >
                  <div className="space-y-1">
                    <Label htmlFor={`other-lodge-amenity-name-${index}`}>
                      Name
                    </Label>
                    <Input
                      id={`other-lodge-amenity-name-${index}`}
                      value={row.name}
                      maxLength={120}
                      onChange={(event) =>
                        setAmenity(index, { name: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label
                      htmlFor={`other-lodge-amenity-description-${index}`}
                    >
                      Description
                    </Label>
                    <Input
                      id={`other-lodge-amenity-description-${index}`}
                      value={row.description}
                      maxLength={1000}
                      onChange={(event) =>
                        setAmenity(index, { description: event.target.value })
                      }
                    />
                  </div>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={!ancestorRendersViewOnlyBanner}
                    variant="outline"
                    size="sm"
                    aria-label={`Remove amenity ${row.name || index + 1}`}
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        amenities: prev.amenities.filter((_, i) => i !== index),
                      }))
                    }
                    disabled={saving}
                  >
                    <X className="h-4 w-4" />
                  </ViewOnlyActionButton>
                </div>
              ))}
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={!ancestorRendersViewOnlyBanner}
                variant="outline"
                size="sm"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    amenities: [...prev.amenities, { name: "", description: "" }],
                  }))
                }
                disabled={
                  saving || form.amenities.length >= AMENITIES_PER_LODGE_MAX
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                Add amenity
              </ViewOnlyActionButton>
            </fieldset>

            <div className="flex gap-2">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={!ancestorRendersViewOnlyBanner}
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
            These names will be offered to non-members who indicate they are a
            member of another lodge. Use Delete to remove one from the list.
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
                    <TableHead>Website</TableHead>
                    <TableHead className="text-right">Beds</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lodges.map((lodge) => (
                    <TableRow key={lodge.id}>
                      <TableCell>
                        <div className="font-medium">{lodge.name}</div>
                        {lodge.amenities.length > 0 ? (
                          <div className="text-xs text-muted-foreground">
                            {lodge.amenities.length}{" "}
                            {lodge.amenities.length === 1
                              ? "amenity"
                              : "amenities"}
                          </div>
                        ) : null}
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
                      <TableCell className="text-muted-foreground">
                        {/* A link only for an http(s) address, which is all the
                            API accepts; anything else is shown as plain text. */}
                        {lodge.siteUrl && isHttpUrl(lodge.siteUrl) ? (
                          <a
                            href={lodge.siteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all underline underline-offset-2"
                          >
                            {lodge.siteUrl}
                          </a>
                        ) : (
                          lodge.siteUrl ?? "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {lodge.bedCapacity ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            describeReason={!ancestorRendersViewOnlyBanner}
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
                            describeReason={!ancestorRendersViewOnlyBanner}
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
