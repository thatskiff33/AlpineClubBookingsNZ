"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AdminViewOnlyNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const FOLLOW_XERO = "__xero__";
const NONE = "__none__";

function monthName(month: number | null): string {
  if (month == null || month < 1 || month > 12) return "Unknown";
  // The range check above guarantees `month - 1` is within [0, 11], so this
  // can only be undefined if that guarantee is ever violated — the same
  // "Unknown" this function already returns for an out-of-range month.
  return MONTH_NAMES[month - 1] ?? "Unknown";
}

/** #2543 — mirrors the Prisma `SubscriptionLockoutMode` enum. */
type SubscriptionLockoutMode = "NO_BLOCK" | "HARD_BLOCK" | "NON_MEMBER_PRICING";

/**
 * Ordered least-strict to most-involved, with HARD_BLOCK in the middle because
 * it is what every club already does. Wording is deliberately about CONSEQUENCE
 * rather than about the setting: an admin picking between these needs to know
 * what a member experiences, not what the column is called.
 */
const LOCKOUT_MODE_OPTIONS: ReadonlyArray<{
  value: SubscriptionLockoutMode;
  label: string;
  description: string;
}> = [
  {
    value: "NO_BLOCK",
    label: "Let them book normally",
    description:
      "No subscription check at booking. Members book at member rates whether or not their subscription is paid, and the unpaid-subscription banner is hidden.",
  },
  {
    value: "HARD_BLOCK",
    label: "Stop them booking (default)",
    description:
      "A member whose subscription is not paid for the season cannot book at all, and sees an unpaid-subscription banner asking them to pay first.",
  },
  {
    value: "NON_MEMBER_PRICING",
    label: "Let them book, at non-member rates",
    description:
      "They may book, but their own nights are charged at the non-member rate until the subscription is paid, and the booking must include at least one adult member whose subscription is paid.",
  },
];

interface LockoutSettings {
  mode: SubscriptionLockoutMode;
  financialYearEndMonthOverride: number | null;
  textFallbackEnabled: boolean;
  useFeeScheduleItemCodes: boolean;
}

const ITEM_CODE_MODE_SINGLE = "single";
const ITEM_CODE_MODE_FEE_SCHEDULE = "fee-schedule";

interface XeroCode {
  code: string;
  name: string;
}

interface AgeTierRow {
  tier: string;
  label: string;
  subscriptionRequiredForBooking?: boolean;
}

export function SubscriptionLockoutSettingsPanel({
  permissionMatrix,
}: {
  permissionMatrix: AdminPermissionMatrix;
}) {
  // This support-area panel fans out to three other areas. Each backing area is
  // gated at `view` so a narrow custom role never fetches into a 403 (seeded
  // roles that reach this page hold all three, so they are unaffected).
  const canMembership = permissionMatrix.membership !== "none";
  const canFinance = permissionMatrix.finance !== "none";
  const canBookings = permissionMatrix.bookings !== "none";

  // Edit gating (#1927/#1940). Each control is gated on the area its OWN backing
  // route enforces at `edit`: the lockout enable, the financial-year override,
  // and the invoice-text fallback all write the membership-area
  // membership-lockout-settings route; the detection account/item codes write
  // the finance-area xero/account-mappings route. A view-level admin sees the
  // data but every editor is disabled.
  const membershipCanEdit = permissionMatrix.membership === "edit";
  const financeCanEdit = permissionMatrix.finance === "edit";
  // Save fans out to at most two writes; enable it when the viewer can edit at
  // least one, and skip each write below unless its own area is editable.
  const canSave = membershipCanEdit || financeCanEdit;

  const [settings, setSettings] = useState<LockoutSettings | null>(null);
  const [subscriptionCode, setSubscriptionCode] = useState<string | null>(null);
  const [subscriptionItemCode, setSubscriptionItemCode] = useState<
    string | null
  >(null);
  const [accounts, setAccounts] = useState<XeroCode[] | null>(null);
  const [items, setItems] = useState<XeroCode[] | null>(null);
  // #2109 fee-schedule look-through preview, computed server-side from the fee
  // schedule and the other fee configs.
  const [feeScheduleItemCodes, setFeeScheduleItemCodes] = useState<string[]>([]);
  const [overlappingCodes, setOverlappingCodes] = useState<string[]>([]);
  const [xeroYearEndMonth, setXeroYearEndMonth] = useState<number | null>(null);
  const [ageTiers, setAgeTiers] = useState<AgeTierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        // Only fetch an area's endpoints when the viewer holds it, so a narrow
        // custom role never fires a request that would 403. A skipped fetch
        // resolves to null and leaves its state at the default (same as today's
        // non-ok handling), and the matrix hides the matching section below.
        const [lockoutRes, mappingsRes, accountsRes, itemsRes, orgRes, tiersRes] =
          await Promise.all([
            canMembership
              ? fetch("/api/admin/membership-lockout-settings", {
                  credentials: "same-origin",
                })
              : null,
            canFinance
              ? fetch("/api/admin/xero/account-mappings", {
                  credentials: "same-origin",
                })
              : null,
            canFinance
              ? fetch("/api/admin/xero/chart-of-accounts", {
                  credentials: "same-origin",
                })
              : null,
            canFinance
              ? fetch("/api/admin/xero/items", { credentials: "same-origin" })
              : null,
            canFinance
              ? fetch("/api/admin/xero/organisation", {
                  credentials: "same-origin",
                })
              : null,
            canBookings
              ? fetch("/api/admin/age-tier-settings", {
                  credentials: "same-origin",
                })
              : null,
          ]);

        // In-panel backstop: the settings are the membership-area backbone, so a
        // denial here (matrix↔enforcement drift or a mid-session revocation)
        // hides the whole panel quietly rather than stalling on "Loading…".
        if (
          lockoutRes &&
          (lockoutRes.status === 401 || lockoutRes.status === 403)
        ) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              "SubscriptionLockoutSettingsPanel: lockout-settings fetch denied; hiding panel (matrix/enforcement drift or revoked session?)",
            );
          }
          setForbidden(true);
          return;
        }

        const lockoutBody = lockoutRes?.ok ? await lockoutRes.json() : null;
        if (lockoutBody?.settings) {
          setSettings(lockoutBody.settings as LockoutSettings);
        }
        if (lockoutBody) {
          setFeeScheduleItemCodes(
            (lockoutBody.feeScheduleItemCodes as string[]) ?? [],
          );
          setOverlappingCodes((lockoutBody.overlappingCodes as string[]) ?? []);
        }

        const mappingsBody = mappingsRes?.ok ? await mappingsRes.json() : null;
        if (mappingsBody?.subscriptionIncome) {
          setSubscriptionCode(mappingsBody.subscriptionIncome.code ?? null);
          setSubscriptionItemCode(
            mappingsBody.subscriptionIncome.itemCode ?? null,
          );
        }

        // Xero reference data is only available when Xero is connected.
        if (accountsRes?.ok) {
          const body = await accountsRes.json();
          setAccounts((body.accounts as XeroCode[]) ?? []);
        }
        if (itemsRes?.ok) {
          const body = await itemsRes.json();
          setItems((body.items as XeroCode[]) ?? []);
        }
        if (orgRes?.ok) {
          const body = await orgRes.json();
          setXeroYearEndMonth(body.financialYearEndMonth ?? null);
        }
        if (tiersRes?.ok) {
          const body = await tiersRes.json();
          setAgeTiers((body.settings as AgeTierRow[]) ?? []);
        }
      } catch {
        toast.error("Failed to load lockout settings");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [canMembership, canFinance, canBookings]);

  function update(patch: Partial<LockoutSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      // Membership-area write: gated on membership edit. A membership-view admin
      // (finance-only editor) skips it — the lockout/year/text controls are
      // disabled for them, so there is nothing to persist and the route would
      // 403.
      if (membershipCanEdit) {
        const lockoutRes = await fetch(
          "/api/admin/membership-lockout-settings",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              mode: settings.mode,
              financialYearEndMonthOverride:
                settings.financialYearEndMonthOverride,
              textFallbackEnabled: settings.textFallbackEnabled,
              useFeeScheduleItemCodes: settings.useFeeScheduleItemCodes,
            }),
          },
        );
        const lockoutBody = await lockoutRes.json().catch(() => ({}));
        if (!lockoutRes.ok) {
          toast.error(lockoutBody.error ?? "Failed to save settings");
          return;
        }
        if (lockoutBody.settings) {
          setSettings(lockoutBody.settings as LockoutSettings);
        }
        if (lockoutBody.feeScheduleItemCodes !== undefined) {
          setFeeScheduleItemCodes(
            (lockoutBody.feeScheduleItemCodes as string[]) ?? [],
          );
        }
        if (lockoutBody.overlappingCodes !== undefined) {
          setOverlappingCodes((lockoutBody.overlappingCodes as string[]) ?? []);
        }
      }

      // Persist the detection codes via the shared Xero account-mappings row so
      // there is a single source of truth with the Xero mappings panel. Send
      // only the subscriptionIncome key so other mappings are untouched. Gated on
      // finance edit: a viewer without finance edit has their detection card
      // hidden or read-only, so writing them would 403 and — worse — attempt to
      // null out a mapping they cannot change.
      if (financeCanEdit) {
        const mappingsRes = await fetch("/api/admin/xero/account-mappings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            subscriptionIncome: {
              code: subscriptionCode,
              itemCode: subscriptionItemCode,
            },
          }),
        });
        if (!mappingsRes.ok) {
          const body = await mappingsRes.json().catch(() => ({}));
          toast.error(body.error ?? "Failed to save detection codes");
          return;
        }
      }

      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  // The panel is membership-backed: without `settings` nothing can render, so a
  // viewer lacking membership (or a drift denial) gets a quiet render-nothing
  // rather than a stuck "Loading settings…". The page keeps its own heading.
  if (forbidden || !canMembership) {
    return null;
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It is rendered in the loading branch too
    so the region exists from the first paint rather than from whenever the
    settings fetch settles, and it sits OUTSIDE the `space-y-*` stack so the
    empty wrapper an edit-capable admin gets costs no layout.

    The narrower finance-scoped `AdminViewOnlyNotice` further down stays put: it
    covers only the subscription account and item codes inside that one card, and
    a membership-edit admin can still change the other fields there, so it is not
    the same statement as this section-level banner.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={membershipCanEdit} className="mb-6">
      Your admin role can view the membership booking-lockout settings but
      cannot change them.
    </AdminViewOnlySectionBanner>
  );

  if (loading || !settings) {
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading settings…</p>
      </div>
    );
  }

  const xeroConnected = accounts !== null;
  const overrideValue =
    settings.financialYearEndMonthOverride == null
      ? FOLLOW_XERO
      : String(settings.financialYearEndMonthOverride);
  const effectiveMonth =
    settings.financialYearEndMonthOverride ?? xeroYearEndMonth ?? 3;
  const requiredTiers = ageTiers.filter(
    (t) => t.subscriptionRequiredForBooking,
  );
  const exemptTiers = ageTiers.filter(
    (t) => !t.subscriptionRequiredForBooking,
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Booking lockout</CardTitle>
          <CardDescription>
            What happens when a member with an unpaid Annual Membership Fee tries
            to book.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* #2543 — three mutually exclusive answers, as radio buttons rather
              than a dropdown: the choice moves MONEY, so all three consequences
              should be readable at once instead of hidden behind a click. */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">
              When a member&rsquo;s subscription is unpaid
            </legend>
            {LOCKOUT_MODE_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-start gap-3">
                <input
                  type="radio"
                  className="mt-1"
                  name="subscription-lockout-mode"
                  value={option.value}
                  checked={settings.mode === option.value}
                  disabled={!membershipCanEdit}
                  onChange={() => update({ mode: option.value })}
                />
                <span className="text-sm">
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {settings.mode === "NON_MEMBER_PRICING" ? (
            <div className="rounded-md border border-info-6 bg-info-3 p-3 text-sm text-info-11">
              <span className="font-medium">What members will see:</span> anyone
              whose subscription is unpaid is charged the non-member rate for
              their own nights and is told why on the quote. Their booking must
              still include at least one adult member whose subscription IS paid;
              if it does not, the booking is refused and they can ask a Booking
              Officer to allow it. The bed is held while that request is pending.
              An unpaid member also stops counting as the adult member who hosts
              non-member guests.
            </div>
          ) : null}

          {/* Xero connection status is finance-area; only shown to a finance
              viewer so we never assert "not connected" to someone who simply
              cannot see finance (the Xero fetches were skipped for them). */}
          {canFinance ? (
            settings.mode !== "NO_BLOCK" && !xeroConnected ? (
              <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
                <span className="font-medium">Heads up:</span> the lockout is on,
                but Xero is not connected, so the system cannot read anyone&rsquo;s
                paid status. While Xero is disconnected the lockout has no effect
                and all members can book at member rates.{" "}
                <Link href="/admin/xero/setup" className="font-medium underline">
                  Connect Xero
                </Link>{" "}
                to enforce it.
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                The lockout has no effect while Xero is disconnected, since a paid
                status can only come from Xero. It also respects the per-age-tier
                rule below.
              </p>
            )
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Financial year</CardTitle>
          <CardDescription>
            Sets the subscription season window (when an annual invoice is raised
            and the period it covers).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Reads the Xero organisation's year-end (finance area); hidden from a
              non-finance viewer so we do not assert a Xero connection state they
              cannot verify. The override control below is a membership setting. */}
          {canFinance ? (
            <p className="text-sm">
              {xeroYearEndMonth
                ? `Your Xero organisation's financial year ends in ${monthName(
                    xeroYearEndMonth,
                  )}.`
                : "Could not read the financial year from Xero (not connected, or unavailable). The March default applies unless you set an override."}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="fy-override">Financial year-end month</Label>
            <Select
              value={overrideValue}
              disabled={!membershipCanEdit}
              onValueChange={(value) =>
                update({
                  financialYearEndMonthOverride:
                    value === FOLLOW_XERO ? null : Number(value),
                })
              }
            >
              <SelectTrigger id="fy-override" className="w-full sm:w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW_XERO}>
                  Follow Xero{xeroYearEndMonth ? ` (${monthName(xeroYearEndMonth)})` : ""}
                </SelectItem>
                {MONTH_NAMES.map((name, index) => (
                  <SelectItem key={name} value={String(index + 1)}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Leave on &quot;Follow Xero&quot; unless your membership subscription
              year differs from your accounting year. The season currently runs
              from {monthName((effectiveMonth % 12) + 1)} to{" "}
              {monthName(effectiveMonth)}.
            </p>
          </div>

          {settings.financialYearEndMonthOverride != null && (
            <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
              Changing the financial year-end month changes how every existing
              and future subscription season is calculated. Only set an override
              if your membership year genuinely differs from your Xero accounting
              year. Existing subscription records are not migrated.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Paid-subscription detection reads and writes Xero account/item codes —
          finance area. Hidden from a viewer without finance access. */}
      {canFinance ? (
      <Card>
        <CardHeader>
          <CardTitle>Paid-subscription detection</CardTitle>
          <CardDescription>
            How a Xero invoice is recognised as a paid membership subscription.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!financeCanEdit ? (
            // Scoped to the finance-gated fields only (the subscription account
            // and item codes). A membership-edit admin can still change the
            // item-code matching mode and the invoice-text fallback in this card,
            // so the notice must not claim they cannot change anything here.
            <AdminViewOnlyNotice canEdit={financeCanEdit}>
              Your admin role can view the subscription account and item codes
              but cannot change them.
            </AdminViewOnlyNotice>
          ) : null}

          {!xeroConnected && (
            <p className="text-sm text-muted-foreground">
              <Link href="/admin/xero/setup" className="font-medium underline">
                Connect Xero
              </Link>{" "}
              to choose account and item codes from your chart of accounts.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="sub-account">Subscription account code</Label>
            <Select
              value={subscriptionCode ?? NONE}
              onValueChange={(value) =>
                setSubscriptionCode(value === NONE ? null : value)
              }
              disabled={!xeroConnected || !financeCanEdit}
            >
              <SelectTrigger id="sub-account" className="w-full sm:w-[360px]">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  <span className="text-muted-foreground">Not set</span>
                </SelectItem>
                {(accounts ?? []).map((a) => (
                  <SelectItem key={a.code} value={a.code}>
                    {a.code} - {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              An invoice line posted to this chart-of-account code counts as a
              subscription. Defaults to 203 (Annual Subs) when unset.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sub-item">Subscription item code (optional)</Label>
            <Select
              value={subscriptionItemCode ?? NONE}
              onValueChange={(value) =>
                setSubscriptionItemCode(value === NONE ? null : value)
              }
              disabled={!xeroConnected || !financeCanEdit}
            >
              <SelectTrigger id="sub-item" className="w-full sm:w-[360px]">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  <span className="text-muted-foreground">Not set</span>
                </SelectItem>
                {(items ?? []).map((i) => (
                  <SelectItem key={i.code} value={i.code}>
                    {i.code} - {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {settings.useFeeScheduleItemCodes
                ? "Fallback item code — always included in matching, alongside every membership fee item code below."
                : "An invoice line using this Xero item also counts, even if its account code differs."}
            </p>
          </div>

          {/* Item-code matching mode (#2109). This is a membership setting saved
              via the membership-lockout-settings route, so it is gated on
              membership edit even though it sits in the finance detection card
              (same as the text fallback below). */}
          <div className="space-y-1.5">
            <Label htmlFor="item-code-mode">Item code matching</Label>
            <Select
              value={
                settings.useFeeScheduleItemCodes
                  ? ITEM_CODE_MODE_FEE_SCHEDULE
                  : ITEM_CODE_MODE_SINGLE
              }
              disabled={!membershipCanEdit}
              onValueChange={(value) =>
                update({
                  useFeeScheduleItemCodes:
                    value === ITEM_CODE_MODE_FEE_SCHEDULE,
                })
              }
            >
              <SelectTrigger
                id="item-code-mode"
                className="w-full sm:w-[360px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ITEM_CODE_MODE_SINGLE}>
                  Single item code
                </SelectItem>
                <SelectItem value={ITEM_CODE_MODE_FEE_SCHEDULE}>
                  Use membership fee item codes (per type + age tier)
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              With look-through on, an invoice also counts when a line uses any
              item code from your{" "}
              <Link
                href="/admin/fee-configuration"
                className="font-medium underline"
              >
                fee configuration
              </Link>{" "}
              (every membership type and age tier, across all seasons). The
              fallback item code above is always included.
            </p>
          </div>

          {settings.useFeeScheduleItemCodes && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                Membership fee item codes matched as paid
              </p>
              {feeScheduleItemCodes.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {feeScheduleItemCodes.map((code) => (
                    <span
                      key={code}
                      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${
                        overlappingCodes.includes(code)
                          ? "border-warning-6 bg-warning-3 text-warning-11"
                          : "border-border bg-muted text-foreground"
                      }`}
                    >
                      {code}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No item codes are configured on your fee schedule yet, so only
                  the fallback item code and account code above are matched. Add
                  item codes on the{" "}
                  <Link
                    href="/admin/fee-configuration"
                    className="font-medium underline"
                  >
                    fee configuration
                  </Link>{" "}
                  page.
                </p>
              )}
              {overlappingCodes.length > 0 && (
                <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
                  <span className="font-medium">Overlap warning:</span> the item
                  code{overlappingCodes.length > 1 ? "s" : ""}{" "}
                  {overlappingCodes.join(", ")} also identif
                  {overlappingCodes.length > 1 ? "y" : "ies"} a hut-fee, joining-fee,
                  or promo line. With look-through on, an unpaid invoice using{" "}
                  {overlappingCodes.length > 1 ? "one of these" : "this"} could be
                  mistaken for a paid subscription. Give subscriptions their own
                  dedicated item codes to avoid false matches.
                </div>
              )}
            </div>
          )}

          <label className="flex items-start gap-3">
            <Checkbox
              className="mt-0.5"
              checked={settings.textFallbackEnabled}
              disabled={!membershipCanEdit}
              onCheckedChange={(checked) =>
                update({ textFallbackEnabled: checked === true })
              }
            />
            <span className="text-sm">
              <span className="font-medium">Match on invoice text as well</span>
              <span className="block text-muted-foreground">
                Also count an invoice whose reference or a line description reads
                like a membership subscription. Useful as a safety net, but can
                cause false matches; turn off for strict code-only matching.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>
      ) : null}

      {/* Age tiers are a bookings-area setting. Hidden from a viewer without
          bookings access. */}
      {canBookings ? (
      <Card>
        <CardHeader>
          <CardTitle>Age tiers</CardTitle>
          <CardDescription>
            Which age tiers must have a paid subscription to book. Edit these on
            the age tier settings page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {ageTiers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Age tier settings unavailable.
            </p>
          ) : (
            <div className="text-sm">
              <p>
                <span className="font-medium">Subscription required:</span>{" "}
                {requiredTiers.length > 0
                  ? requiredTiers.map((t) => t.label).join(", ")
                  : "None"}
              </p>
              <p className="mt-1">
                <span className="font-medium">Exempt:</span>{" "}
                {exemptTiers.length > 0
                  ? exemptTiers.map((t) => t.label).join(", ")
                  : "None"}
              </p>
            </div>
          )}
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/age-tier-settings">Edit age tier settings</Link>
          </Button>
        </CardContent>
      </Card>
      ) : null}

      {/*
        `canSave` is `membershipCanEdit || financeCanEdit`, so whenever this
        button is gated `membershipCanEdit` is false and the section banner above
        is showing — the opt-out never leaves the control unexplained.
      */}
      <ViewOnlyActionButton canEdit={canSave} describeReason={false} onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </ViewOnlyActionButton>
      </div>
    </div>
  );
}
