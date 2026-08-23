"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLodgeOptions } from "@/components/lodge-select";
import { LodgeOptionsUnavailableNotice } from "@/components/admin/lodge-options-status";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";

// Multi-lodge kiosks: one shared login per lodge device. Each account can
// bind to a lodge (a MemberLodgeAccess STAFF grant, managed through this
// page's lodge select); an unbound account serves the club's default
// lodge. With fewer than two lodges nothing lodge-related renders and the
// page behaves exactly as the original single-account screen (ADR-002).

interface KioskAccount {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: string;
  updatedAt: string;
  boundLodgeId: string | null;
  boundLodgeName: string | null;
  // Present only when this account holds STAFF grants at two or more lodges:
  // the kiosk/PIN paths deny it (M5), so an admin must reassign it to one lodge.
  binding?: "ambiguous";
  assignedLodgeCount?: number;
}

type SaveMessage = { type: "success" | "error"; text: string } | null;

function AccountCard({
  account,
  lodges,
  showLodgeControls,
  defaultLodgeName,
  canEdit,
  onSaved,
}: {
  account: KioskAccount;
  lodges: Array<{ id: string; name: string }>;
  showLodgeControls: boolean;
  defaultLodgeName: string | null;
  canEdit: boolean | undefined;
  onSaved: () => void;
}) {
  // Kiosk-account created/updated stamps are real INSTANTS (CT-4, #2870).
  const clubTime = useClubTime();
  const [email, setEmail] = useState(account.email);
  const [firstName, setFirstName] = useState(account.firstName);
  const [lastName, setLastName] = useState(account.lastName);
  const [password, setPassword] = useState("");
  const [boundLodgeId, setBoundLodgeId] = useState(account.boundLodgeId ?? "");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveMessage, setSaveMessage] = useState<SaveMessage>(null);

  function handleCancel() {
    setEmail(account.email);
    setFirstName(account.firstName);
    setLastName(account.lastName);
    setBoundLodgeId(account.boundLodgeId ?? "");
    setPassword("");
    setEditing(false);
    setSaveMessage(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage(null);

    const body: Record<string, unknown> = { id: account.id };
    if (email !== account.email) body.email = email;
    if (firstName !== account.firstName) body.firstName = firstName;
    if (lastName !== account.lastName) body.lastName = lastName;
    if (password) body.password = password;
    if ((account.boundLodgeId ?? "") !== boundLodgeId) {
      body.lodgeId = boundLodgeId || null;
    }

    if (Object.keys(body).length === 1) {
      setSaveMessage({ type: "error", text: "No changes to save" });
      setSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/admin/lodge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 403) {
        setSaveMessage({ type: "error", text: ADMIN_FORBIDDEN_SAVE_REASON });
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setSaveMessage({ type: "error", text: data.error || "Failed to save" });
        return;
      }
      setPassword("");
      setEditing(false);
      setSaveMessage({ type: "success", text: "Kiosk account updated successfully" });
      onSaved();
    } catch {
      setSaveMessage({ type: "error", text: "Failed to save changes" });
    } finally {
      setSaving(false);
    }
  }

  const fieldId = (suffix: string) => `lodge-${account.id}-${suffix}`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>
          {showLodgeControls
            ? account.binding === "ambiguous"
              ? "Kiosk account — Ambiguous assignment"
              : `Kiosk account — ${account.boundLodgeName ?? "Default lodge"}`
            : "Lodge Account Settings"}
        </CardTitle>
        <div className="flex items-center gap-2">
          {/* Preview this specific kiosk account (issue #23): opens the kiosk
              exactly as this login would see it — its bound lodge at the kiosk
              tier — rather than the admin's own default-lodge view. */}
          <a
            href={`/lodge/kiosk?previewAccount=${encodeURIComponent(account.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="app-button-brand gap-2"
          >
            Preview kiosk
          </a>
          {!editing && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(true);
                setSaveMessage(null);
              }}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Binding health (issue #23): make explicit which lodge this account
            serves, and warn when an unbound account silently falls back to the
            default lodge — the transitional debt to bind before deploying. */}
        {showLodgeControls &&
          account.binding !== "ambiguous" &&
          (account.boundLodgeName ? (
            <div className="rounded-md border border-success-6 bg-success-3 p-3 text-sm text-success-11">
              Serves <span className="font-semibold">{account.boundLodgeName}</span>.
            </div>
          ) : (
            <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
              <p className="font-semibold">Not bound to a lodge</p>
              <p className="mt-1">
                This account currently falls back to the club&apos;s default
                lodge{defaultLodgeName ? ` (${defaultLodgeName})` : ""}. Bind it
                to the lodge its device lives at before deploying.
              </p>
            </div>
          ))}
        {account.binding === "ambiguous" && (
          <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
            <p className="font-semibold">
              Ambiguous — assigned to {account.assignedLodgeCount} lodges
            </p>
            <p className="mt-1">
              This kiosk account has STAFF access at more than one lodge, so it
              is blocked from the kiosk and PIN sign-in.
              {showLodgeControls
                ? " Set it to operate a single lodge below and save to fix this."
                : " Reassign it to a single lodge to fix this."}
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor={fieldId("first")}>First Name</Label>
            <Input
              id={fieldId("first")}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              disabled={!editing}
              className={!editing ? "bg-muted text-muted-foreground" : ""}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={fieldId("last")}>Last Name</Label>
            <Input
              id={fieldId("last")}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              disabled={!editing}
              className={!editing ? "bg-muted text-muted-foreground" : ""}
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor={fieldId("email")}>Email</Label>
          <Input
            id={fieldId("email")}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!editing}
            className={!editing ? "bg-muted text-muted-foreground" : ""}
          />
        </div>

        {showLodgeControls && (
          <div className="space-y-1 max-w-sm">
            <Label htmlFor={fieldId("binding")}>Operates lodge</Label>
            <select
              id={fieldId("binding")}
              value={boundLodgeId}
              onChange={(e) => setBoundLodgeId(e.target.value)}
              disabled={!editing}
              className={`w-full rounded-md border border-input px-3 py-2 text-sm ${!editing ? "bg-muted text-muted-foreground" : "bg-background"}`}
            >
              <option value="">Default lodge</option>
              {lodges.map((lodge) => (
                <option key={lodge.id} value={lodge.id}>
                  {lodge.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              The kiosk signed in with this account shows this lodge&apos;s
              guests, roster, and instructions.
            </p>
          </div>
        )}

        {editing && (
          <div className="space-y-1">
            <Label htmlFor={fieldId("password")}>New Password</Label>
            <Input
              id={fieldId("password")}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep current password"
            />
            <p className="text-xs text-muted-foreground">Minimum 6 characters</p>
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          <p>Created: {clubTime.instantDateTime(requireInstant(account.createdAt))}</p>
          <p>Last updated: {clubTime.instantDateTime(requireInstant(account.updatedAt))}</p>
        </div>

        {saveMessage && (
          <div
            className={`rounded-md p-3 text-sm ${
              saveMessage.type === "success"
                ? "bg-success-3 text-success-11"
                : "bg-danger-3 text-danger-11"
            }`}
          >
            {saveMessage.text}
          </div>
        )}

        {editing && (
          <div className="flex gap-3">
            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </ViewOnlyActionButton>
            <Button variant="outline" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminLodgePage() {
  const { hutLeaderLabel } = useClubIdentity();
  // Kiosk accounts are lodge config; the write routes enforce lodge:edit, so a
  // lodge:view admin sees this screen read-only (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const [accounts, setAccounts] = useState<KioskAccount[]>([]);
  const [defaultLodgeName, setDefaultLodgeName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const {
    lodges,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
    reload: reloadLodgeOptions,
  } = useLodgeOptions("admin");
  /*
   * #2701: every lodge-binding control on this page is gated on there being a
   * second lodge, and a FAILED lodge list produced an empty array — so an
   * outage looked exactly like a single-lodge club and the controls simply
   * disappeared. On this page that is worse than a wrong default: a kiosk
   * device bound to the wrong lodge cannot be rebound, and "Add a kiosk
   * account" is the only way to create the second lodge's kiosk login at all.
   * The notice below says the list did not load, so the absence is explained
   * rather than mistaken for a club that has nothing to bind.
   */
  const showLodgeControls = lodges.length > 1;

  // Add-account form (rendered only with a second lodge to point it at).
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newLodgeId, setNewLodgeId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState<SaveMessage>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/lodge");
      if (!res.ok) throw new Error("Failed to load lodge account");
      const data = await res.json();
      setAccounts(data.accounts ?? (data.lodge ? [data.lodge] : []));
      setDefaultLodgeName(data.defaultLodgeName ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    setCreating(true);
    setCreateMessage(null);
    try {
      const res = await fetch("/api/admin/lodge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newEmail,
          password: newPassword,
          lodgeId: newLodgeId || undefined,
        }),
      });
      if (res.status === 403) {
        setCreateMessage({ type: "error", text: ADMIN_FORBIDDEN_SAVE_REASON });
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setCreateMessage({ type: "error", text: data.error || "Failed to create account" });
        return;
      }
      setAdding(false);
      setNewEmail("");
      setNewPassword("");
      setNewLodgeId("");
      setCreateMessage({ type: "success", text: "Kiosk account created" });
      await load();
    } catch {
      setCreateMessage({ type: "error", text: "Failed to create account" });
    } finally {
      setCreating(false);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the page —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. That is why it is hoisted above the
    loading/error early-returns and rendered in every branch. It sits OUTSIDE
    the `space-y-6` stack so the empty wrapper an edit-capable admin gets costs
    no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the lodge kiosk accounts but cannot change them.
      Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading) {
    return (
      <div className="p-6">
        {viewOnlyBanner}
        <h1 className="text-2xl font-bold text-foreground mb-6">Lodge Kiosk</h1>
        <div className="animate-pulse h-64 bg-muted rounded-lg" />
      </div>
    );
  }

  if (error || accounts.length === 0) {
    return (
      <div className="p-6">
        {viewOnlyBanner}
        <h1 className="text-2xl font-bold text-foreground mb-6">Lodge Kiosk</h1>
        <div className="bg-danger-3 border border-danger-6 rounded-lg p-4 text-danger-11">
          {error || "Lodge account not found. Run the database seed to create it."}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {viewOnlyBanner}
      <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Lodge Kiosk</h1>

      <LodgeOptionsUnavailableNotice
        failed={lodgeOptionsFailed}
        forbidden={lodgeOptionsForbidden}
        onRetry={reloadLodgeOptions}
        what="the lodge each kiosk account is bound to"
      />

      <p className="max-w-3xl text-sm text-muted-foreground">
        This is the shared sign-in used on the physical lodge kiosk screen — it is
        not a personal admin login. Guests and {hutLeaderLabel.toLowerCase()}s use
        it on the lodge device to check in and out and view lodge information. Set
        the email and
        password below, then sign in once on the kiosk device with these details.
        Use &ldquo;Preview kiosk&rdquo; on an account to see exactly what that
        login displays (a read-only preview — no changes are saved).
        {showLodgeControls &&
          " With more than one lodge, create one kiosk account per lodge and bind each to the lodge its device lives at."}
      </p>

      {accounts.map((account) => (
        <AccountCard
          key={`${account.id}-${account.updatedAt}`}
          account={account}
          lodges={lodges}
          showLodgeControls={showLodgeControls}
          defaultLodgeName={defaultLodgeName}
          canEdit={canEdit}
          onSaved={() => void load()}
        />
      ))}

      {showLodgeControls && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Add a kiosk account</CardTitle>
            {!adding && (
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => setAdding(true)}>
                Add account
              </ViewOnlyActionButton>
            )}
          </CardHeader>
          {adding && (
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="new-kiosk-email">Email</Label>
                  <Input
                    id="new-kiosk-email"
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-kiosk-password">Password</Label>
                  <Input
                    id="new-kiosk-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Minimum 6 characters</p>
                </div>
              </div>
              <div className="space-y-1 max-w-sm">
                <Label htmlFor="new-kiosk-lodge">Operates lodge</Label>
                <select
                  id="new-kiosk-lodge"
                  value={newLodgeId}
                  onChange={(e) => setNewLodgeId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Default lodge</option>
                  {lodges.map((lodge) => (
                    <option key={lodge.id} value={lodge.id}>
                      {lodge.name}
                    </option>
                  ))}
                </select>
              </div>
              {createMessage && (
                <div
                  className={`rounded-md p-3 text-sm ${
                    createMessage.type === "success"
                      ? "bg-success-3 text-success-11"
                      : "bg-danger-3 text-danger-11"
                  }`}
                >
                  {createMessage.text}
                </div>
              )}
              <div className="flex gap-3">
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={handleCreate}
                  disabled={creating || !newEmail || newPassword.length < 6}
                >
                  {creating ? "Creating..." : "Create account"}
                </ViewOnlyActionButton>
                <Button
                  variant="outline"
                  onClick={() => {
                    setAdding(false);
                    setCreateMessage(null);
                  }}
                  disabled={creating}
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          )}
          {!adding && createMessage?.type === "success" && (
            <CardContent>
              <div className="rounded-md p-3 text-sm bg-success-3 text-success-11">
                {createMessage.text}
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
    </div>
  );
}
