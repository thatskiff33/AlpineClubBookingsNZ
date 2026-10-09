"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
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
  ownedOtherLodgeEditLabel,
  type AdminOtherLodgesResponse,
  type OwnedOtherLodgeNames,
} from "@/lib/other-lodges";
import {
  DATE_FIELDS,
  DATE_FIELD_NAMES,
  FACILITY_FIELDS,
  FACILITY_LABELS,
  ROOM_TYPE_CHOICES,
  TEXT_FIELDS,
  TEXT_FIELD_NAMES,
  WHOLE_NUMBER_FIELDS,
  WHOLE_NUMBER_FIELD_NAMES,
  emptyForm,
  formFromLodge,
  formPayload,
  formProblem,
  type AmenityFormRow,
  type OtherLodgeFormState,
  type OtherLodgeRecord,
} from "./other-lodge-form";

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
  // Whether syncing with the central server is paused for version (#49): the
  // list on screen may be stale while it is, so the panel says so and links
  // to setup, where the two numbers are shown.
  const [syncPaused, setSyncPaused] = useState(false);
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
      setSyncPaused(data?.serverVersionStatus === "mismatch");
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
  // The owned rows actually ON SCREEN. A name the server lists that has no
  // local row yet (not downloaded) has no button, so the label counts what the
  // administrator can see: "Edit my Lodge" when one row is theirs, the lodge's
  // name on each when several are, and a note below when none is yet.
  const localOwnedNames = lodges.filter((l) => l.owned).map((l) => l.name);
  const editLabel = (name: string) => ownedOtherLodgeEditLabel(localOwnedNames, name);
  const anyOwnedRow = localOwnedNames.length > 0;
  const ownedButNotDownloaded =
    !loading && ownedNames !== null && ownedNames.length > 0 && !anyOwnedRow;

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
              {WHOLE_NUMBER_FIELD_NAMES.map((field) => (
                <div key={field} className="space-y-2">
                  <Label htmlFor={`other-lodge-${field}`}>
                    {WHOLE_NUMBER_FIELDS[field]}
                  </Label>
                  <Input
                    id={`other-lodge-${field}`}
                    type="number"
                    min={0}
                    max={OTHER_LODGE_BOUNDS.wholeNumberMax}
                    inputMode="numeric"
                    value={form.numbers[field]}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        numbers: { ...prev.numbers, [field]: event.target.value },
                      }))
                    }
                  />
                </div>
              ))}
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Room or dormitory</legend>
                <div className="flex flex-wrap gap-4 pt-1 text-sm">
                  {ROOM_TYPE_CHOICES.map(([value, label]) => (
                    <label key={value || "unset"} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="other-lodge-roomType"
                        className="h-4 w-4"
                        value={value}
                        checked={form.roomType === value}
                        onChange={() =>
                          setForm((prev) => ({ ...prev, roomType: value }))
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
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
          {/* Syncing paused for version (#49): the rows below may be stale and
              an edit saved here will not leave this site until it resumes. */}
          {!loading && syncPaused ? (
            <p className="text-sm text-destructive" role="status" data-testid="server-version-paused">
              Syncing with the Alpine Central Server is paused because the server
              is on a different software version from this site, so this list may
              be out of date and changes made here are not sent until the two
              match. See the{" "}
              <Link href="/admin/alpine-server/setup" className="underline underline-offset-4">
                Alpine Central Server setup page
              </Link>{" "}
              for both version numbers.
            </p>
          ) : null}
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
          {ownedButNotDownloaded ? (
            <p className="text-sm text-muted-foreground" data-testid="owned-not-downloaded">
              The central server names{" "}
              {ownedNames?.length === 1 ? (
                <strong>{ownedNames[0]}</strong>
              ) : (
                "your lodges"
              )}{" "}
              as yours, but {ownedNames?.length === 1 ? "it has" : "they have"}{" "}
              not been downloaded to this site yet. Press <strong>Download</strong>{" "}
              on the Alpine Central Server setup page; the Edit button appears
              once the entry is here.
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
                    <TableHead>Booking page</TableHead>
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
