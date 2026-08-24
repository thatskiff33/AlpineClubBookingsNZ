"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useLodgeOptions } from "@/components/lodge-select";
import { LodgeScopeStatusNotice } from "@/components/admin/lodge-options-status";
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { calendarDayFromPayload } from "../_lib/calendar-day";
import { formatCents } from "@/lib/pricing";

interface WorkPartyEventRow {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string;
  discountPercent: number;
  active: boolean;
  lodgeId: string | null;
  lodgeName: string | null;
  bookingCount: number;
  totalDiscountCents: number;
}

interface AttendingBooking {
  id: string;
  discountCents: number;
  createdAt: string;
  booking: {
    id: string;
    checkIn: string;
    checkOut: string;
    status: string;
    finalPriceCents: number;
  };
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}

interface EventDetail {
  attendingBookings: AttendingBooking[];
  totalDiscountCents: number;
}

interface EventFormState {
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  discountPercent: string;
  active: boolean;
  // Lodge the working bee is held at; "" means club-wide (all lodges).
  lodgeId: string;
}

const emptyForm: EventFormState = {
  name: "",
  description: "",
  startDate: "",
  endDate: "",
  discountPercent: "100",
  active: true,
  lodgeId: "",
};

// CT-4 (#2870): a work-party day and a booking's check-in/check-out are
// CALENDAR DATES, serialised from `@db.Date` columns as UTC midnight. Decoding
// that encoding in UTC is the identity for every club; reading it through
// APP_TIME_ZONE was a projection that named the previous day for any club
// behind UTC (INV-DATE-019). The rendered shape — the stored `yyyy-MM-dd` — is
// unchanged.
function formatStoredDate(value: string) {
  return calendarDayFromPayload(value) ?? value;
}

export default function AdminWorkPartiesPage() {
  // Work-party events are lodge config; the write routes enforce lodge:edit, so
  // a lodge:view admin sees this screen read-only (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const [events, setEvents] = useState<WorkPartyEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EventFormState>(emptyForm);
  // #2257 — the example lives UNDER the field, not inside it as grey pseudo-content.
  const nameHint = useFieldHint();
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, EventDetail>>({});
  // Lodge options for the form's lodge field and per-event lodge labels; the
  // field and labels only render once a second lodge exists (ADR-002).
  const {
    lodges,
    loading: lodgeOptionsLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
    reload: reloadLodgeOptions,
  } = useLodgeOptions("admin");
  /*
    #2701: a FAILED lodge list is not "a club with no lodges", but until now the
    two were the same empty array here, and this page keys BOTH its lodge field
    and its per-event lodge labels on `lodges.length > 1`. So a multi-lodge club
    whose list failed read exactly like a single-lodge one: no "Lodge" field, no
    lodge named on any event, and `form.lodgeId` stuck at "" — which the POST
    route stores as a CLUB-WIDE event, a discount applied at every lodge that
    nobody chose. (Unlike the other lodge-scoped pages, a work party is not
    silently pushed onto the default lodge; it is silently pushed onto all of
    them.)

    The events list itself is club-wide, but it is held too: a successful lodge
    response is what makes the form's deliberate "All lodges" choice meaningful.
  */
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: "__all_lodges__",
    loading: lodgeOptionsLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
    explicitAllLodgesValue: "__all_lodges__",
  });
  const lodgeScopeReady = lodgeScope.kind === "all";

  const fetchEvents = useCallback(async () => {
    if (!lodgeScopeReady) {
      setEvents([]);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/admin/work-parties");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to load work party events");
        return;
      }
      setEvents(data.events);
    } catch {
      setError("Failed to load work party events");
    } finally {
      setLoading(false);
    }
  }, [lodgeScopeReady]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  function startCreate() {
    if (!lodgeScopeReady) return;
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
    setError("");
  }

  function startEdit(event: WorkPartyEventRow) {
    if (!lodgeScopeReady) return;
    setEditingId(event.id);
    setForm({
      name: event.name,
      description: event.description ?? "",
      startDate: event.startDate.slice(0, 10),
      endDate: event.endDate.slice(0, 10),
      discountPercent: String(event.discountPercent),
      active: event.active,
      lodgeId: event.lodgeId ?? "",
    });
    setShowForm(true);
    setError("");
  }

  async function handleSave() {
    if (!lodgeScopeReady) return;
    const discountPercent = Number(form.discountPercent);
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    if (!form.startDate || !form.endDate) {
      setError("Start and end dates are required");
      return;
    }
    if (!Number.isInteger(discountPercent) || discountPercent < 1 || discountPercent > 100) {
      setError("Discount must be a whole number between 1 and 100");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        startDate: form.startDate,
        endDate: form.endDate,
        discountPercent,
        active: form.active,
        lodgeId: form.lodgeId || null,
      };
      const res = await fetch(
        editingId ? `/api/admin/work-parties/${editingId}` : "/api/admin/work-parties",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to save work party event");
        return;
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      await fetchEvents();
    } catch {
      setError("Failed to save work party event");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(event: WorkPartyEventRow) {
    if (!lodgeScopeReady) return;
    setError("");
    const res = await fetch(`/api/admin/work-parties/${event.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: event.name,
        description: event.description,
        startDate: event.startDate.slice(0, 10),
        endDate: event.endDate.slice(0, 10),
        discountPercent: event.discountPercent,
        active: !event.active,
        lodgeId: event.lodgeId,
      }),
    });
    if (res.status === 403) {
      setError(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed to update work party event");
      return;
    }
    await fetchEvents();
  }

  async function handleDelete(event: WorkPartyEventRow) {
    if (!lodgeScopeReady) return;
    if (!confirm(`Delete work party event "${event.name}"?`)) return;
    setError("");
    const res = await fetch(`/api/admin/work-parties/${event.id}`, {
      method: "DELETE",
    });
    if (res.status === 403) {
      setError(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed to delete work party event");
      return;
    }
    await fetchEvents();
  }

  async function toggleDetail(eventId: string) {
    if (!lodgeScopeReady) return;
    if (expandedId === eventId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(eventId);
    if (!details[eventId]) {
      const res = await fetch(`/api/admin/work-parties/${eventId}`);
      const data = await res.json();
      if (res.ok) {
        setDetails((prev) => ({
          ...prev,
          [eventId]: {
            attendingBookings: data.attendingBookings,
            totalDiscountCents: data.totalDiscountCents,
          },
        }));
      }
    }
  }

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
      Your admin role can view work parties but cannot change them. Lodge
      edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <AdminPageHeader
        title="Work Parties"
        description="Working bee events with an automatic discount for attending bookings"
        actions={lodgeScopeReady ?
          <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={startCreate}>
            New Event
          </ViewOnlyActionButton> : null
        }
      />

      {/* #2701: say the lodge list failed, above the form whose "Lodge" field
          it silently removed. */}
      <LodgeScopeStatusNotice
        scope={lodgeScope}
        onRetry={reloadLodgeOptions}
        what="work parties for a particular lodge"
      />

      {lodgeScopeReady && error && (
        <div className="rounded-md border border-danger/20 bg-danger-muted p-3 text-sm text-danger">{error}</div>
      )}

      {lodgeScopeReady && showForm && (
        <Card>
          <CardHeader>
            <CardTitle>{editingId ? "Edit Event" : "New Event"}</CardTitle>
            <CardDescription>
              Members booking nights within the event window can tick &quot;I am
              attending a working bee&quot; to receive the discount automatically.
              The discount applies to every guest&apos;s nights inside the window.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="wp-name">Name</Label>
                <Input
                  id="wp-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  {...nameHint.fieldProps}
                />
                <FieldHint {...nameHint.hintProps}>
                  Example: Spring working bee
                </FieldHint>
              </div>
              <div className="space-y-2">
                <Label htmlFor="wp-discount">Discount %</Label>
                <Input
                  id="wp-discount"
                  type="number"
                  min={1}
                  max={100}
                  value={form.discountPercent}
                  onChange={(e) => setForm({ ...form, discountPercent: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wp-start">Start date</Label>
                <Input
                  id="wp-start"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wp-end">End date (last discounted night)</Label>
                <Input
                  id="wp-end"
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                />
              </div>
              {lodges.length > 1 && (
                <div className="space-y-2">
                  <Label htmlFor="wp-lodge">Lodge</Label>
                  <select
                    id="wp-lodge"
                    value={form.lodgeId}
                    onChange={(e) => setForm({ ...form, lodgeId: e.target.value })}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    <option value="">All lodges (club-wide)</option>
                    {lodges.map((lodge) => (
                      <option key={lodge.id} value={lodge.id}>
                        {lodge.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="wp-description">Description (optional)</Label>
              <Textarea
                id="wp-description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                maxLength={1000}
                rows={3}
              />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="rounded border-input"
              />
              Active (members can select this event when booking)
            </label>
            <div className="flex gap-2">
              {/* #2701: an edit would PUT back the lodge the event already has,
                  but the admin cannot SEE which lodge that is while the list is
                  down — and a create would silently go club-wide. Both save
                  through this one button, so it stays shut for both. */}
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : editingId ? "Save Changes" : "Create Event"}
              </ViewOnlyActionButton>
              <Button
                variant="outline"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!lodgeScopeReady ? null : loading ? (
        <div className="flex justify-center py-8">
          <Spinner label="Loading work party events…" />
        </div>
      ) : events.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarDays}
            title="No work party events yet"
            description="Create one to offer an automatic working bee discount on nights in the window."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {events.map((event) => (
            <Card key={event.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {event.name}
                      <Badge variant={event.active ? "default" : "secondary"}>
                        {event.active ? "Active" : "Inactive"}
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      {formatStoredDate(event.startDate)} to {formatStoredDate(event.endDate)}
                      {" · "}
                      {event.discountPercent}% off nights in the window
                      {lodges.length > 1 && (
                        <>
                          {" · "}
                          {event.lodgeName ?? "All lodges"}
                        </>
                      )}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEdit(event)}>
                      Edit
                    </ViewOnlyActionButton>
                    <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => toggleActive(event)}>
                      {event.active ? "Deactivate" : "Activate"}
                    </ViewOnlyActionButton>
                    {event.bookingCount === 0 && (
                      <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => handleDelete(event)}>
                        Delete
                      </ViewOnlyActionButton>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {event.description && (
                  <p className="text-sm text-muted-foreground">{event.description}</p>
                )}
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span>
                    Attending bookings: <strong>{event.bookingCount}</strong>
                  </span>
                  <span>
                    Total discount given: <strong>{formatCents(event.totalDiscountCents)}</strong>
                  </span>
                  {event.bookingCount > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => toggleDetail(event.id)}>
                      {expandedId === event.id ? "Hide bookings" : "Show bookings"}
                    </Button>
                  )}
                </div>
                {expandedId === event.id &&
                  (details[event.id] ? (
                    <AdminDataTable showDensityToggle={false}>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Member</TableHead>
                          <TableHead>Stay</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Discount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {details[event.id].attendingBookings.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell>
                              {row.member.firstName} {row.member.lastName}
                            </TableCell>
                            <TableCell>
                              {formatStoredDate(row.booking.checkIn)} to{" "}
                              {formatStoredDate(row.booking.checkOut)}
                            </TableCell>
                            <TableCell>{row.booking.status}</TableCell>
                            <TableCell className="text-right">
                              {formatCents(row.discountCents)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </AdminDataTable>
                  ) : (
                    <div className="rounded-md border p-3 text-sm text-muted-foreground">
                      Loading bookings...
                    </div>
                  ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
