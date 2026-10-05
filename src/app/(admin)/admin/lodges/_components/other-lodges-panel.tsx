"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building, Pencil, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { isHttpUrl } from "@/lib/http-url";
import {
  AMENITIES_PER_LODGE_MAX,
  OTHER_LODGE_BOUNDS,
  OTHER_LODGE_NOT_OWNED_CODE,
  amenitiesInputSchema,
  ownedOtherLodgeEditLabel,
  type AdminOtherLodge,
  type AdminOtherLodgesResponse,
  type OtherLodgeBooleanField,
  type OtherLodgeDateField,
  type OtherLodgeTextField,
  type OwnedOtherLodgeNames,
  type SerializedOtherLodge,
} from "@/lib/other-lodges";

// The API's own shape, not a hand-copied one: a column added to the shared
// field list in `@/lib/other-lodges` fails to compile here until the form
// carries it, instead of being silently dropped from the editor (#50). The
// list row is the ADMIN shape (#52): another club's officer phone is not in
// it, and `owned` is the route's answer to whether this site may edit it.
type OtherLodgeRecord = AdminOtherLodge;
type OtherLodgePayload = Omit<SerializedOtherLodge, "id" | "createdAt" | "updatedAt">;

// EVERY EDITOR LABEL IS A `Record` OVER THE SHARED FIELD TYPE, so a field that
// is stored, serialized and uploaded but missing here is a compile error — the
// one list cannot gain a 15th field that the editor silently has no input for.
// Lengths come from the same `OTHER_LODGE_BOUNDS` the API validates with.
type TextInputSpec = {
  label: string;
  maxLength: number;
  type?: "email" | "url";
  placeholder?: string;
};
const TEXT_FIELDS: Record<OtherLodgeTextField, TextInputSpec> = {
  location: { label: "Location", maxLength: OTHER_LODGE_BOUNDS.location },
  bookingOfficerName: {
    label: "Booking officer's name",
    maxLength: OTHER_LODGE_BOUNDS.bookingOfficerName,
  },
  bookingOfficerEmail: {
    label: "Booking officer's email",
    maxLength: OTHER_LODGE_BOUNDS.bookingOfficerEmail,
    type: "email",
  },
  bookingOfficerPhone: {
    label: "Booking officer's phone",
    maxLength: OTHER_LODGE_BOUNDS.bookingOfficerPhone,
  },
  siteUrl: {
    label: "Website",
    maxLength: OTHER_LODGE_BOUNDS.siteUrl,
    type: "url",
    placeholder: "https://",
  },
  bookingPath: { label: "How to book", maxLength: OTHER_LODGE_BOUNDS.bookingPath },
  cancellationPeriod: {
    label: "Cancellation period",
    maxLength: OTHER_LODGE_BOUNDS.cancellationPeriod,
  },
};
const DATE_FIELDS: Record<OtherLodgeDateField, string> = {
  winterSeasonStart: "Winter season starts",
  summerSeasonStart: "Summer season starts",
};
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
const TEXT_FIELD_NAMES = Object.keys(TEXT_FIELDS) as OtherLodgeTextField[];
const DATE_FIELD_NAMES = Object.keys(DATE_FIELDS) as OtherLodgeDateField[];
const FACILITY_FIELDS = Object.keys(FACILITY_LABELS) as OtherLodgeBooleanField[];

type AmenityFormRow = { name: string; description: string };

type OtherLodgeFormState = {
  name: string;
  bedCapacity: string;
  text: Record<OtherLodgeTextField, string>;
  /** `YYYY-MM-DD` from a date input, or "" — never a `Date`. */
  dates: Record<OtherLodgeDateField, string>;
  facilities: Record<OtherLodgeBooleanField, boolean>;
  amenities: AmenityFormRow[];
};

/** `{ [field]: value(field) }` typed over the field union, for the records above. */
function recordOf<K extends string, V>(keys: readonly K[], value: (key: K) => V) {
  return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>;
}

const emptyForm: OtherLodgeFormState = {
  name: "",
  bedCapacity: "",
  text: recordOf(TEXT_FIELD_NAMES, () => ""),
  dates: recordOf(DATE_FIELD_NAMES, () => ""),
  facilities: recordOf(FACILITY_FIELDS, () => false),
  amenities: [],
};

function formFromLodge(lodge: OtherLodgeRecord): OtherLodgeFormState {
  return {
    name: lodge.name,
    bedCapacity: lodge.bedCapacity === null ? "" : String(lodge.bedCapacity),
    text: recordOf(TEXT_FIELD_NAMES, (field) => lodge[field] ?? ""),
    dates: recordOf(DATE_FIELD_NAMES, (field) => lodge[field] ?? ""),
    facilities: recordOf(FACILITY_FIELDS, (field) => lodge[field]),
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
    bedCapacity: capacity === "" ? null : Number(capacity),
    ...recordOf(TEXT_FIELD_NAMES, (field) => form.text[field].trim() || null),
    ...recordOf(DATE_FIELD_NAMES, (field) => form.dates[field].trim() || null),
    ...form.facilities,
    amenities: form.amenities.map((a) => ({
      name: a.name.trim(),
      description: a.description.trim() || null,
    })),
  };
}

/**
 * The inline message for a form the API would refuse, or null when it is fine.
 * The amenity list is checked with the API's OWN schema rather than a re-typed
 * copy of its rules, so "needs a name", "unique ignoring case" and the per-lodge
 * cap can only ever disagree with the server by not being run.
 */
function formProblem(form: OtherLodgeFormState): string | null {
  if (!form.name.trim()) return "Lodge name is required.";
  const capacity = form.bedCapacity.trim();
  if (capacity !== "" && !/^\d+$/.test(capacity)) {
    return "Bed capacity must be a whole number.";
  }
  // Mirror the server's upper bound so an unrealistic value gets a clear
  // inline message instead of a generic "Invalid input" from the API.
  if (capacity !== "" && Number(capacity) > OTHER_LODGE_BOUNDS.bedCapacityMax) {
    return "Bed capacity looks too large. Enter a realistic number.";
  }
  const siteUrl = form.text.siteUrl.trim();
  if (siteUrl && !isHttpUrl(siteUrl)) {
    return "The site URL must start with http:// or https://.";
  }
  const amenities = amenitiesInputSchema.safeParse(formPayload(form).amenities);
  if (!amenities.success) {
    const [issue] = amenities.error.issues;
    const row = typeof issue?.path[0] === "number" ? ` (amenity ${issue.path[0] + 1})` : "";
    return `${issue?.message ?? "Check the amenities."}${row}`;
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
  // Same edit gate as the club's own lodges: the write route enforces lodge:edit,
  // so a lodge:view admin sees this panel read-only.
  const canEdit = useAdminAreaEditAccess("lodge");
  const [lodges, setLodges] = useState<OtherLodgeRecord[]>([]);
  // Which lodges are THIS club's own, as the central server last said (#52):
  // `null` until it has said anything, `[]` when it said none. Only an owned
  // lodge gets an Edit button; both read-only states are explained below.
  const [ownedNames, setOwnedNames] = useState<OwnedOtherLodgeNames>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<OtherLodgeFormState>(emptyForm);

  // The spinner is for the FIRST load only. A refresh after a save keeps the
  // table mounted: replacing it with "Loading..." would unmount the Edit button
  // that opened the dialog, and focus could not return to it when the dialog
  // closes (it would land on the page body).
  //
  // Only the NEWEST load may write the list. Two refreshes can be in flight a
  // moment apart, and if the older response arrived last it would put back
  // what the newer one had already replaced.
  const loadSeqRef = useRef(0);
  const loadLodges = useCallback(async (showSpinner = false) => {
    const seq = ++loadSeqRef.current;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/other-lodges");
      if (!response.ok) {
        throw new Error("Failed to load other lodges");
      }
      const data = (await response.json()) as Partial<AdminOtherLodgesResponse>;
      if (seq !== loadSeqRef.current) return;
      setLodges(Array.isArray(data?.otherLodges) ? data.otherLodges : []);
      setOwnedNames(Array.isArray(data?.ownedLodgeNames) ? data.ownedLodgeNames : null);
    } catch {
      if (seq !== loadSeqRef.current) return;
      setError("Could not load other lodges. Please try again.");
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLodges(true);
  }, [loadLodges]);

  // The button that opened the dialog, so focus can go back to it on close.
  // Radix restores focus to whatever was focused when the dialog mounted, but a
  // button click does not focus the button in every browser (Safari, and Firefox
  // on macOS), so that can be the page body; and the dialog's own close handler
  // otherwise aims at a `DialogTrigger`, which this dialog does not have. Without
  // this, a keyboard user lands on the page after Save or Cancel and has to tab
  // back to where they were.
  const openerRef = useRef<HTMLElement | null>(null);

  function startEdit(lodge: OtherLodgeRecord, opener: HTMLElement) {
    openerRef.current = opener;
    setEditingId(lodge.id);
    setForm(formFromLodge(lodge));
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
    // An error belongs to the edit it came from. Left in place, closing the
    // dialog would hand it to the page-level message, which would announce a
    // validation error for an edit the administrator has just discarded.
    setError(null);
  }

  /** Show a lodge the server has just saved, without waiting for the refresh. */
  function applySaved(saved: OtherLodgeRecord) {
    setLodges((prev) =>
      [...prev.filter((l) => l.id !== saved.id), saved].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
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
    let saved = false;
    try {
      const response = await fetch(`/api/admin/other-lodges/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formPayload(form)),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
        otherLodge?: OtherLodgeRecord;
      } | null;
      if (response.status === 403) {
        // Two different refusals share the status: the administrator's role
        // (the generic view-only message) and the central server's answer about
        // whose lodge this is, which the route marks with a code and explains.
        setError(
          data?.code === OTHER_LODGE_NOT_OWNED_CODE && data.error
            ? data.error
            : ADMIN_FORBIDDEN_SAVE_REASON,
        );
        return;
      }
      if (!response.ok) {
        throw new Error(data?.error ?? "Failed to save lodge");
      }
      // Show what was saved straight away, so the list is not stale (and an
      // Edit click on the old row cannot overwrite this save) while the
      // refresh below is still on its way.
      if (data?.otherLodge) applySaved(data.otherLodge);
      saved = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lodge");
    } finally {
      setSaving(false);
    }
    if (saved) {
      // The save is done and `saving` is already cleared, so the refresh runs
      // with the buttons enabled: held open across it, every Edit button would
      // stay disabled and a disabled button cannot take focus back when the
      // dialog closes. Closing and clearing `saving` land in one render.
      cancelEdit();
      await loadLodges();
    }
  }

  const showForm = editingId !== null;
  // The label of each owned lodge's button, and of the dialog it opens: "Edit
  // my Lodge" when the club owns one, the lodge's name when it owns several.
  const editLabel = (name: string) =>
    ownedOtherLodgeEditLabel(ownedNames ?? [], name);
  const anyOwnedRow = lodges.some((l) => l.owned);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Other lodges</h2>
        <p className="text-sm text-muted-foreground">
          Details of other clubs&apos; lodges the club recognises. Their names
          will be offered to non-members when they indicate they are a member
          of another lodge. The list comes from the Alpine Central Server; only
          your own lodge can be changed here.
        </p>
      </div>

      {/* While the dialog is open it covers the page, so a save or validation
          error is shown inside it, directly above Save and Cancel (the form is
          long, and Save is where the administrator's attention is when it
          fails). This one is for everything outside it: a list that could not
          load. */}
      {error && !showForm ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {/* The controls in the dialog pass `describeReason={!ancestorRendersViewOnlyBanner}`
          like the rest of the panel, although the page banner is hidden behind a
          modal. That is safe because a view-only admin can never open this
          dialog: Edit is itself gated, so none of these controls is ever shown
          to them disabled. (If a session's permissions narrowed while the
          dialog was open, Save would go dead without a reason beside it.) */}
      <Dialog
        open={showForm}
        // Close is Escape, the close button or Cancel — never while a save is in
        // flight, so the form cannot vanish under a request that may still land.
        // This one guard covers Escape and the close button alike: Radix routes
        // both through here. The close button is also hidden while saving, so
        // there is no clickable button that does nothing.
        onOpenChange={(next) => {
          if (!next && !saving) cancelEdit();
        }}
      >
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
          showCloseButton={!saving}
          // A click on the dimmed background does NOT close it: the form is long
          // and one stray click outside must not throw away what was typed.
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            // Back to the button that opened the dialog. (If a refresh has since
            // removed that row there is nothing to focus and this is a no-op.)
            event.preventDefault();
            openerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editLabel(form.name)}</DialogTitle>
            <DialogDescription>
              Everything here is optional detail that is shared with other clubs
              through the Alpine Central Server when that connection is on.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="other-lodge-name">Name</Label>
                {/* READ-ONLY: the central server matches lodges by name, so a
                    new name here would create a second lodge there and strand
                    this one. The route refuses a change as well. */}
                <Input
                  id="other-lodge-name"
                  value={form.name}
                  readOnly
                  aria-describedby="other-lodge-name-note"
                />
                <p
                  id="other-lodge-name-note"
                  className="text-xs text-muted-foreground"
                >
                  The name is set on the central server and cannot be changed
                  here.
                </p>
              </div>
              {TEXT_FIELD_NAMES.map((field) => (
                <div key={field} className="space-y-2">
                  <Label htmlFor={`other-lodge-${field}`}>
                    {TEXT_FIELDS[field].label}
                  </Label>
                  <Input
                    id={`other-lodge-${field}`}
                    type={TEXT_FIELDS[field].type}
                    placeholder={TEXT_FIELDS[field].placeholder}
                    maxLength={TEXT_FIELDS[field].maxLength}
                    value={form.text[field]}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        text: { ...prev.text, [field]: event.target.value },
                      }))
                    }
                  />
                </div>
              ))}
              <div className="space-y-2">
                <Label htmlFor="other-lodge-bedCapacity">Bed capacity</Label>
                <Input
                  id="other-lodge-bedCapacity"
                  type="number"
                  min={0}
                  max={OTHER_LODGE_BOUNDS.bedCapacityMax}
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
              {DATE_FIELD_NAMES.map((field) => (
                <div key={field} className="space-y-2">
                  <Label htmlFor={`other-lodge-${field}`}>{DATE_FIELDS[field]}</Label>
                  <Input
                    id={`other-lodge-${field}`}
                    type="date"
                    value={form.dates[field]}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        dates: { ...prev.dates, [field]: event.target.value },
                      }))
                    }
                  />
                </div>
              ))}
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
                      maxLength={OTHER_LODGE_BOUNDS.amenityName}
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
                      maxLength={OTHER_LODGE_BOUNDS.amenityDescription}
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

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
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
          </div>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building className="h-5 w-5" />
            Other lodges
          </CardTitle>
          <CardDescription>
            These names will be offered to non-members who indicate they are a
            member of another lodge. Each club keeps its own lodge up to date;
            the rest arrive by download from the central server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Why nothing here can be edited, in the two read-only states. Not
              shown while loading: the owned list is not known yet either way. */}
          {!loading && ownedNames === null ? (
            <p className="text-sm text-muted-foreground" data-testid="owned-unknown">
              Which lodge is yours is set on the central server. Connect this
              site to it on the Alpine Central Server setup page and press{" "}
              <strong>Download</strong>; the lodge it names for this site can
              then be edited here.
            </p>
          ) : null}
          {!loading && ownedNames !== null && ownedNames.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="owned-none">
              The central server has no lodge assigned to this site, so nothing
              here can be edited. Ask the central server&apos;s operator to
              assign your lodge.
            </p>
          ) : null}
          {loading ? (
            <p className="text-sm text-muted-foreground">
              Loading other lodges...
            </p>
          ) : lodges.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other lodges yet. They arrive when the site downloads from the
              central server.
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
                    {anyOwnedRow ? (
                      <TableHead className="text-right">Actions</TableHead>
                    ) : null}
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
                        {/* Name and email only. The phone is private: it is
                            not shown for any lodge, and for another club's
                            lodge it is not sent to the browser at all (#52). */}
                        {lodge.bookingOfficerName ? (
                          <div>
                            <div>{lodge.bookingOfficerName}</div>
                            {lodge.bookingOfficerEmail ? (
                              <div className="text-xs">
                                {lodge.bookingOfficerEmail}
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
                      {anyOwnedRow ? (
                        <TableCell>
                          {lodge.owned ? (
                            <div className="flex justify-end">
                              <ViewOnlyActionButton
                                canEdit={canEdit}
                                describeReason={!ancestorRendersViewOnlyBanner}
                                variant="outline"
                                size="sm"
                                onClick={(event) =>
                                  startEdit(lodge, event.currentTarget)
                                }
                                disabled={saving}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                {editLabel(lodge.name)}
                              </ViewOnlyActionButton>
                            </div>
                          ) : null}
                        </TableCell>
                      ) : null}
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
