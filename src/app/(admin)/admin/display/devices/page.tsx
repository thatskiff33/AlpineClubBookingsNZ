"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BackLink } from "@/components/admin/back-link";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

// Lobby display device management (fork issue #33, epic #25): list devices
// with pairing/last-seen state, create a device, arm pairing by entering the
// code shown on the TV (ADR-001 admin bind), assign a registry template,
// revoke. The lobbyDisplay module flag gates this page at the proxy.

interface ClientDevice {
  id: string;
  name: string;
  lodgeId: string;
  lodgeName: string;
  templateId: string | null;
  templateName: string | null;
  // Per-device refresh cadence in seconds (LTV-039); null = the default (~60s).
  pollSeconds: number | null;
  paired: boolean;
  pairingArmedUntil: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
}

interface TemplateOption {
  id: string;
  key: string;
  name: string;
  layout: { id: string; key: string; name: string };
  deviceCount: number;
  updatedAt: string;
}

// The picker offers the club default and every v2 template (LTV-038 retired the
// separate built-ins group — the built-ins are now ordinary seeded templates).
// The empty value is the club default; a template value is prefixed so the
// change handler knows to PATCH its templateId.
const CLUB_DEFAULT = "";
const templateValue = (id: string) => `template:${id}`;

interface LodgeOption {
  id: string;
  name: string;
}

export default function AdminDisplayDevicesPage() {
  // When a display device last checked in — real INSTANTS, projected through the club's persisted zone rather
  // than the viewer's or the build's (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  const [devices, setDevices] = useState<ClientDevice[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [newName, setNewName] = useState("");
  const [newLodgeId, setNewLodgeId] = useState("");
  const [lodgeOptionsError, setLodgeOptionsError] = useState(false);
  const [codeByDevice, setCodeByDevice] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayUrl, setDisplayUrl] = useState("/display");
  const [copied, setCopied] = useState(false);
  // Display devices resolve to the "lodge" area (create/pair/revoke/template/
  // poll are all lodge:edit writes), so gate the management controls on
  // lodge:edit — a lodge:view admin can read the device list but not change it
  // (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const deviceNameHint = useFieldHint();

  useEffect(() => {
    setDisplayUrl(`${window.location.origin}/display`);
  }, []);

  const refresh = useCallback(async () => {
    const [devicesRes, templatesRes, lodgesRes] = await Promise.all([
      fetch("/api/admin/display/devices"),
      fetch("/api/admin/display/templates"),
      fetch("/api/admin/lodges").catch(() => null),
    ]);
    if (devicesRes.ok) {
      const body = (await devicesRes.json()) as { devices: ClientDevice[] };
      setDevices(body.devices);
    }
    if (templatesRes.ok) {
      const body = (await templatesRes.json()) as {
        templates: TemplateOption[];
      };
      setTemplates(body.templates ?? []);
    }
    if (lodgesRes?.ok) {
      const body = (await lodgesRes.json()) as {
        lodges?: Array<{ id: string; name: string; active?: boolean }>;
      };
      const active = (body.lodges ?? []).filter((lodge) => lodge.active !== false);
      setLodges(active.map((lodge) => ({ id: lodge.id, name: lodge.name })));
      setNewLodgeId((current) => current || active[0]?.id || "");
      setLodgeOptionsError(false);
    } else {
      setLodges([]);
      setNewLodgeId("");
      setLodgeOptionsError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createDevice() {
    setMessage(null);
    if (!newLodgeId) {
      setMessage("Choose a lodge before creating a display device.");
      return;
    }
    const response = await fetch("/api/admin/display/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName, lodgeId: newLodgeId }),
    });
    if (response.status === 403) {
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(body?.error ?? "Could not create the device");
      return;
    }
    setNewName("");
    await refresh();
  }

  async function armPairing(deviceId: string) {
    setMessage(null);
    const code = codeByDevice[deviceId] ?? "";
    const response = await fetch(`/api/admin/display/devices/${deviceId}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
    setMessage(
      response.ok
        ? "Pairing armed — the display will connect within a few seconds."
        : response.status === 403
          ? ADMIN_FORBIDDEN_SAVE_REASON
          : body?.error ?? "Pairing failed"
    );
    if (response.ok) {
      setCodeByDevice((current) => ({ ...current, [deviceId]: "" }));
      await refresh();
    }
  }

  async function assignTemplate(deviceId: string, selection: string) {
    setMessage(null);
    // Decode the picker value into the binding to PATCH: a template value binds
    // its id; the empty value clears the binding back to the club default
    // (templateId null).
    const patch: { templateId: string | null } = selection.startsWith("template:")
      ? { templateId: selection.slice("template:".length) }
      : { templateId: null };
    const response = await fetch(`/api/admin/display/devices/${deviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (response.status === 403) {
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(body?.error ?? "Could not assign the template");
      return;
    }
    await refresh();
  }

  // Per-device refresh cadence (LTV-039). Blank resets to the default; a value
  // is validated to the 15–600s range client-side before the PATCH (the route
  // rejects out-of-range too). The poll doubles as the heartbeat, so this is
  // also how often the device's "last seen" refreshes.
  async function savePollSeconds(deviceId: string, raw: string) {
    setMessage(null);
    const trimmed = raw.trim();
    let pollSeconds: number | null;
    if (trimmed === "") {
      pollSeconds = null;
    } else {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 15 || parsed > 600) {
        setMessage(
          "Refresh interval must be a whole number of seconds between 15 and 600."
        );
        return;
      }
      pollSeconds = parsed;
    }
    const response = await fetch(`/api/admin/display/devices/${deviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pollSeconds }),
    });
    if (response.status === 403) {
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(body?.error ?? "Could not update the refresh interval");
      return;
    }
    await refresh();
  }

  async function revoke(deviceId: string) {
    setMessage(null);
    const response = await fetch(`/api/admin/display/devices/${deviceId}/revoke`, {
      method: "POST",
    });
    if (response.status === 403) {
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (!response.ok) {
      setMessage("Could not revoke the device");
      return;
    }
    await refresh();
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the page —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. It sits OUTSIDE the `space-y-6`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the lobby display devices but cannot change
      them. Lodge edit access is required to create, pair, revoke, or
      re-template a screen.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div className="p-6">
      {viewOnlyBanner}
      <div className="space-y-6">
      <div>
        <BackLink href="/admin/display" label="Lobby Display" />
        <h1 className="mt-2 text-2xl font-bold">Display Devices</h1>
        <p className="text-muted-foreground">
          Paired lobby screens per lodge. Create a device, open the display URL
          on the TV, then enter the code it shows to pair. Devices are
          read-only and individually revocable.
        </p>
        {/* LTV-035 (#81): the per-lodge display config (name granularity,
            committee notice, {{config:key}} values) moved to each lodge's own
            configuration page. Point admins arriving from the old Display
            Settings location at the new home. */}
        <p className="text-muted-foreground mt-2 text-sm">
          Per-lodge display values (guest name granularity, committee notice,
          and {"{{config:key}}"} values) are edited on each lodge — Admin →
          Lodges.
        </p>
      </div>

      {message && <p className="text-sm font-medium">{message}</p>}

      {lodgeOptionsError ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>
            The lodge list could not be loaded. Display devices can still be
            viewed, but a new device cannot be created without an explicit lodge.
          </p>
          <Button type="button" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Setting up a screen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            1. On the TV (or any browser on the screen device), open:{" "}
            <code className="bg-muted rounded px-2 py-1 font-mono">{displayUrl}</code>{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(displayUrl).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? "Copied" : "Copy URL"}
            </Button>
          </p>
          <p>2. The screen shows a six-character pairing code.</p>
          <p>
            3. Create (or pick) a device below, type the code into its Pair box,
            and the screen connects itself within a few seconds. It keeps
            working across reboots until you revoke it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a display device</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="device-name">Name</Label>
            <Input
              id="device-name"
              value={newName}
              disabled={!canEdit}
              {...deviceNameHint.fieldProps}
              onChange={(event) => setNewName(event.target.value)}
            />
            <FieldHint {...deviceNameHint.hintProps}>Example: Lobby TV</FieldHint>
          </div>
          {lodges.length > 1 && (
            <div className="space-y-1">
              <Label htmlFor="device-lodge">Lodge</Label>
              <select
                id="device-lodge"
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                value={newLodgeId}
                disabled={!canEdit}
                onChange={(event) => setNewLodgeId(event.target.value)}
              >
                {lodges.map((lodge) => (
                  <option key={lodge.id} value={lodge.id}>
                    {lodge.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={() => void createDevice()}
            disabled={!newName || !newLodgeId || lodgeOptionsError}
          >
            Create device
          </ViewOnlyActionButton>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {!loading && devices.length === 0 && (
            <p className="text-muted-foreground text-sm">No display devices yet.</p>
          )}
          <div className="space-y-4">
            {devices.map((device) => (
              <div
                key={device.id}
                className="flex flex-wrap items-center gap-3 border-b pb-4 last:border-b-0"
              >
                <div className="min-w-48">
                  <p className="font-medium">{device.name}</p>
                  <p className="text-muted-foreground text-sm">{device.lodgeName}</p>
                </div>
                <div className="flex items-center gap-2">
                  {device.revoked ? (
                    <Badge variant="destructive">Revoked</Badge>
                  ) : device.paired ? (
                    <Badge>Paired</Badge>
                  ) : (
                    <Badge variant="secondary">Unpaired</Badge>
                  )}
                  {device.pairingArmedUntil && !device.paired && (
                    <Badge variant="outline">Pairing armed</Badge>
                  )}
                  <span className="text-muted-foreground text-xs">
                    {device.lastSeenAt
                      ? `Last seen ${clubTime.instantDateTime(requireInstant(device.lastSeenAt))}`
                      : "Never seen"}
                  </span>
                </div>
                {!device.revoked && (
                  <>
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 uppercase"
                        // #2264: this box repeats once per device row and had
                        // no label, no id and no aria-label — its placeholder
                        // was doing the naming, so the only way to reach it was
                        // `getByPlaceholder("TV code")`. A per-device
                        // accessible name both names it for a screen reader
                        // ("which device am I pairing?") and gives the e2e
                        // specs a row-scoped selector that cannot go ambiguous
                        // once a second device exists.
                        aria-label={`Pairing code for ${device.name}`}
                        placeholder="TV code"
                        maxLength={6}
                        value={codeByDevice[device.id] ?? ""}
                        disabled={!canEdit}
                        onChange={(event) =>
                          setCodeByDevice((current) => ({
                            ...current,
                            [device.id]: event.target.value.toUpperCase(),
                          }))
                        }
                      />
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        describeReason={false}
                        variant="outline"
                        onClick={() => void armPairing(device.id)}
                        disabled={(codeByDevice[device.id] ?? "").length !== 6}
                      >
                        Pair
                      </ViewOnlyActionButton>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label className="text-xs" htmlFor={`template-${device.id}`}>
                        Template
                      </Label>
                      <select
                        id={`template-${device.id}`}
                        className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                        value={
                          device.templateId
                            ? templateValue(device.templateId)
                            : CLUB_DEFAULT
                        }
                        disabled={!canEdit}
                        onChange={(event) =>
                          void assignTemplate(device.id, event.target.value)
                        }
                      >
                        <option value={CLUB_DEFAULT}>Club default</option>
                        {templates.length > 0 && (
                          <optgroup label="Templates">
                            {templates.map((template) => (
                              <option
                                key={template.id}
                                value={templateValue(template.id)}
                              >
                                {template.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Label className="text-xs" htmlFor={`poll-${device.id}`}>
                          Refresh every
                        </Label>
                        <Input
                          id={`poll-${device.id}`}
                          className="w-20"
                          type="number"
                          min={15}
                          max={600}
                          placeholder="60"
                          // Uncontrolled: re-key on the saved value so a refresh
                          // reflows the input to the persisted (or default) state.
                          key={`poll-${device.id}-${device.pollSeconds ?? "default"}`}
                          defaultValue={device.pollSeconds ?? ""}
                          disabled={!canEdit}
                          onBlur={(event) =>
                            void savePollSeconds(device.id, event.target.value)
                          }
                        />
                        <span className="text-muted-foreground text-xs">seconds</span>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        Blank uses the default (~60s). This is also how often the
                        screen&apos;s &ldquo;last seen&rdquo; updates.
                      </p>
                    </div>
                    <Button variant="outline" asChild>
                      <a
                        href={`/display?previewDevice=${device.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Preview
                      </a>
                    </Button>
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="destructive"
                      onClick={() => void revoke(device.id)}
                    >
                      Revoke
                    </ViewOnlyActionButton>
                  </>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
