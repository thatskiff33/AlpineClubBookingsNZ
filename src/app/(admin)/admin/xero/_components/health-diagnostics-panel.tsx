"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgeTier } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { fetchJson, postJson } from "./api";
import {
  healthBudgetToneClass,
  HealthStatCard,
  SectionCard,
  shortId,
  type ToggleSection,
} from "./shared";
import type {
  ContactGroupMismatchResponse,
  ContactLinkMismatchResponse,
  MissingInvoicesResponse,
  SectionKey,
  XeroHealthSnapshot,
} from "./types";
import Link from "next/link";

type Props = {
  connected: boolean;
  currentXeroPath: string;
  healthOpen: boolean;
  contactGroupMismatchesOpen: boolean;
  contactLinkMismatchesOpen: boolean;
  onToggle: ToggleSection;
  onMessage: (message: string) => void;
  onRefreshOperations: () => void;
  refreshToken: number;
  scrollToSection: (section: SectionKey) => void;
};

export function HealthAndDiagnosticsPanels({
  connected,
  currentXeroPath,
  healthOpen,
  contactGroupMismatchesOpen,
  contactLinkMismatchesOpen,
  onToggle,
  onMessage,
  onRefreshOperations,
  refreshToken,
  scrollToSection,
}: Props) {
  const [health, setHealth] = useState<XeroHealthSnapshot | null>(null);
  const [healthError, setHealthError] = useState("");
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [missingInvoices, setMissingInvoices] =
    useState<MissingInvoicesResponse | null>(null);
  const [loadingMissingInvoices, setLoadingMissingInvoices] = useState(false);
  const [showMissingInvoices, setShowMissingInvoices] = useState(false);
  const [triggeringMissingInvoices, setTriggeringMissingInvoices] =
    useState(false);

  const [groupMismatches, setGroupMismatches] =
    useState<ContactGroupMismatchResponse | null>(null);
  const [groupError, setGroupError] = useState("");
  const [loadingGroupMismatches, setLoadingGroupMismatches] = useState(false);

  const [linkMismatches, setLinkMismatches] =
    useState<ContactLinkMismatchResponse | null>(null);
  const [linkError, setLinkError] = useState("");
  const [loadingLinkMismatches, setLoadingLinkMismatches] = useState(false);
  const [unlinkingMemberId, setUnlinkingMemberId] = useState<string | null>(
    null,
  );

  const fetchHealth = useCallback(async () => {
    setLoadingHealth(true);
    setHealthError("");
    try {
      setHealth(
        await fetchJson<XeroHealthSnapshot>(
          "/api/admin/xero/health",
          undefined,
          "Failed to fetch Xero health",
        ),
      );
    } catch (err) {
      setHealthError(
        err instanceof Error
          ? err.message
          : "Failed to load Xero health snapshot",
      );
    } finally {
      setLoadingHealth(false);
    }
  }, []);

  const fetchMissingInvoices = useCallback(async () => {
    setLoadingMissingInvoices(true);
    setHealthError("");
    try {
      setMissingInvoices(
        await fetchJson<MissingInvoicesResponse>(
          "/api/admin/xero/missing-invoices",
          undefined,
          "Failed to fetch missing invoices",
        ),
      );
    } catch (err) {
      setHealthError(
        err instanceof Error
          ? err.message
          : "Failed to load bookings missing Xero invoices",
      );
    } finally {
      setLoadingMissingInvoices(false);
    }
  }, []);

  const fetchGroupMismatches = useCallback(async () => {
    setLoadingGroupMismatches(true);
    setGroupError("");
    try {
      setGroupMismatches(
        await fetchJson<ContactGroupMismatchResponse>(
          "/api/admin/xero/contact-group-mismatches?limit=200",
          undefined,
          "Failed to fetch contact group mismatches",
        ),
      );
    } catch (err) {
      setGroupError(
        err instanceof Error
          ? err.message
          : "Failed to load Xero contact group mismatches",
      );
    } finally {
      setLoadingGroupMismatches(false);
    }
  }, []);

  const fetchLinkMismatches = useCallback(async () => {
    setLoadingLinkMismatches(true);
    setLinkError("");
    try {
      setLinkMismatches(
        await fetchJson<ContactLinkMismatchResponse>(
          "/api/admin/xero/contact-link-mismatches?limit=200",
          undefined,
          "Failed to fetch contact link mismatches",
        ),
      );
    } catch (err) {
      setLinkError(
        err instanceof Error
          ? err.message
          : "Failed to load Xero contact link mismatches",
      );
    } finally {
      setLoadingLinkMismatches(false);
    }
  }, []);

  useEffect(() => {
    if (connected && healthOpen && !health && !loadingHealth)
      void fetchHealth();
  }, [connected, fetchHealth, health, healthOpen, loadingHealth]);

  useEffect(() => {
    if (
      connected &&
      contactGroupMismatchesOpen &&
      !groupMismatches &&
      !loadingGroupMismatches
    )
      void fetchGroupMismatches();
  }, [
    connected,
    contactGroupMismatchesOpen,
    fetchGroupMismatches,
    groupMismatches,
    loadingGroupMismatches,
  ]);

  useEffect(() => {
    if (
      connected &&
      contactLinkMismatchesOpen &&
      !linkMismatches &&
      !loadingLinkMismatches
    )
      void fetchLinkMismatches();
  }, [
    connected,
    contactLinkMismatchesOpen,
    fetchLinkMismatches,
    linkMismatches,
    loadingLinkMismatches,
  ]);

  useEffect(() => {
    if (!connected || refreshToken === 0) return;
    if (healthOpen) void fetchHealth();
    if (contactGroupMismatchesOpen) void fetchGroupMismatches();
    if (contactLinkMismatchesOpen) void fetchLinkMismatches();
  }, [
    connected,
    contactGroupMismatchesOpen,
    contactLinkMismatchesOpen,
    fetchGroupMismatches,
    fetchHealth,
    fetchLinkMismatches,
    healthOpen,
    refreshToken,
  ]);

  useEffect(() => {
    if (!connected) {
      setHealth(null);
      setGroupMismatches(null);
      setLinkMismatches(null);
      setMissingInvoices(null);
      setShowMissingInvoices(false);
    }
  }, [connected]);

  const toggleMissingInvoices = async () => {
    const nextOpen = !showMissingInvoices;
    setShowMissingInvoices(nextOpen);
    if (nextOpen && !missingInvoices && !loadingMissingInvoices)
      await fetchMissingInvoices();
  };

  const triggerMissingInvoices = async () => {
    setTriggeringMissingInvoices(true);
    setHealthError("");
    onMessage("");
    try {
      const data = await postJson<{ message?: string }>(
        "/api/admin/xero/missing-invoices",
        undefined,
        "Failed to queue missing invoices",
      );
      onMessage(data.message || "Queued missing booking invoices.");
      await Promise.all([fetchHealth(), fetchMissingInvoices()]);
      onRefreshOperations();
    } catch (err) {
      setHealthError(
        err instanceof Error ? err.message : "Failed to queue missing invoices",
      );
    } finally {
      setTriggeringMissingInvoices(false);
    }
  };

  const unlinkContactMismatch = async (memberId: string) => {
    setUnlinkingMemberId(memberId);
    setLinkError("");
    onMessage("");
    try {
      await postJson<{ message?: string }>(
        `/api/admin/members/${memberId}/xero-unlink`,
        undefined,
        "Failed to unlink member from Xero",
      );
      onMessage(
        "Member unlinked from Xero. Open the member record to relink the correct contact.",
      );
      await Promise.all([
        fetchHealth(),
        fetchLinkMismatches(),
        groupMismatches ? fetchGroupMismatches() : Promise.resolve(),
      ]);
    } catch (err) {
      setLinkError(
        err instanceof Error
          ? err.message
          : "Failed to unlink member from Xero",
      );
    } finally {
      setUnlinkingMemberId(null);
    }
  };

  return (
    <>
      <SectionCard
        id="xero-section-health"
        title="Health Snapshot"
        description="Quick checks for link coverage, stuck work, missing invoices, and daily Xero budget pressure."
        open={healthOpen}
        onToggle={(nextOpen) => onToggle("health", nextOpen)}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchHealth()}
            disabled={loadingHealth}
          >
            {loadingHealth ? "Refreshing..." : "Refresh Health"}
          </Button>
        }
      >
        {healthError ? (
          <p className="mb-3 text-sm text-red-600">{healthError}</p>
        ) : null}
        {loadingHealth && !health ? (
          <p className="text-sm text-muted-foreground">
            Loading health snapshot...
          </p>
        ) : health ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              <HealthStatCard
                label="Unlinked members"
                value={health.unlinkedMembers.count}
                subtitle="Active members without a Xero contact link."
                href={health.unlinkedMembers.href}
              />
              <HealthStatCard
                label="Active failed issues"
                value={health.failedOperations.count}
                subtitle={
                  health.failedOperations.legacyCount > 0
                    ? `Replayable failures that still need action. ${health.failedOperations.legacyCount} older failed rows are already repaired or superseded.`
                    : "Replayable failures that still need action."
                }
                badge={
                  <Badge
                    className={
                      health.failedOperations.count > 0
                        ? "bg-red-600"
                        : "bg-green-600"
                    }
                  >
                    {health.failedOperations.count > 0
                      ? "Needs attention"
                      : "Clear"}
                  </Badge>
                }
                onClick={() => scrollToSection("operations")}
              />
              <HealthStatCard
                label="Pending operations"
                value={health.pendingOperations.count}
                subtitle="Queued or running work that has not completed yet."
                badge={
                  <Badge
                    className={
                      health.pendingOperations.count > 0
                        ? "bg-slate-600"
                        : "bg-green-600"
                    }
                  >
                    {health.pendingOperations.count > 0 ? "In flight" : "Idle"}
                  </Badge>
                }
                onClick={() => scrollToSection("operations")}
              />
              <HealthStatCard
                label="Last membership refresh"
                value={
                  <span className="text-base font-semibold">
                    {health.lastMembershipRefresh.at
                      ? new Date(
                          health.lastMembershipRefresh.at,
                        ).toLocaleString("en-NZ")
                      : "Never"}
                  </span>
                }
                subtitle={
                  health.lastMembershipRefresh.lastCronStatus
                    ? `Last cron status: ${health.lastMembershipRefresh.lastCronStatus}`
                    : "No cron run recorded yet."
                }
                onClick={() => scrollToSection("membershipSync")}
              />
              <HealthStatCard
                label="Group mismatches"
                value={health.contactGroupMismatches.count}
                subtitle={
                  health.contactGroupMismatches.cacheReady
                    ? "Linked members whose managed Xero group does not match their current age tier."
                    : "Refresh Xero contact groups before mismatch checks can run."
                }
                badge={
                  <Badge
                    className={
                      !health.contactGroupMismatches.cacheReady
                        ? "bg-slate-600"
                        : health.contactGroupMismatches.count > 0
                          ? "bg-amber-500"
                          : "bg-green-600"
                    }
                  >
                    {!health.contactGroupMismatches.cacheReady
                      ? "Cache needed"
                      : health.contactGroupMismatches.count > 0
                        ? "Review"
                        : "Clear"}
                  </Badge>
                }
                onClick={() => scrollToSection("contactGroupMismatches")}
              />
              <HealthStatCard
                label="Link mismatches"
                value={health.contactLinkMismatches.count}
                subtitle={
                  health.contactLinkMismatches.cacheReady
                    ? "Linked members whose local name does not match the cached Xero contact name."
                    : "Run contact sync before name mismatch checks can run."
                }
                badge={
                  <Badge
                    className={
                      !health.contactLinkMismatches.cacheReady
                        ? "bg-slate-600"
                        : health.contactLinkMismatches.count > 0
                          ? "bg-amber-500"
                          : "bg-green-600"
                    }
                  >
                    {!health.contactLinkMismatches.cacheReady
                      ? "Cache needed"
                      : health.contactLinkMismatches.count > 0
                        ? "Review"
                        : "Clear"}
                  </Badge>
                }
                onClick={() => scrollToSection("contactLinkMismatches")}
              />
              <HealthStatCard
                label="API budget"
                value={
                  health.apiBudget.usagePercent != null
                    ? `${Math.round(health.apiBudget.usagePercent * 100)}%`
                    : "Unknown"
                }
                subtitle={
                  health.apiBudget.totalCalls != null
                    ? `${health.apiBudget.totalCalls} calls today, ${health.apiBudget.failedCalls ?? 0} failed`
                    : "Usage snapshot not available yet."
                }
                badge={
                  <Badge
                    className={healthBudgetToneClass(health.apiBudget.status)}
                  >
                    {health.apiBudget.status}
                  </Badge>
                }
                onClick={() => scrollToSection("usage")}
              />
            </div>

            <div className="rounded-lg border p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">
                      Missing invoice detector
                    </h3>
                    <Badge
                      className={
                        health.missingInvoices.count > 0
                          ? "bg-amber-500"
                          : "bg-green-600"
                      }
                    >
                      {health.missingInvoices.count}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Bookings with a payment but no successful Xero invoice sync
                    on record.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void toggleMissingInvoices()}
                  >
                    {showMissingInvoices ? "Hide Details" : "Show Details"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void triggerMissingInvoices()}
                    disabled={
                      triggeringMissingInvoices ||
                      health.missingInvoices.count === 0
                    }
                  >
                    {triggeringMissingInvoices
                      ? "Queueing..."
                      : "Trigger All Missing"}
                  </Button>
                </div>
              </div>
              {showMissingInvoices ? (
                <MissingInvoicesList
                  loading={loadingMissingInvoices}
                  details={missingInvoices}
                  currentXeroPath={currentXeroPath}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No health data recorded yet.
          </p>
        )}
      </SectionCard>

      <ContactGroupMismatchPanel
        open={contactGroupMismatchesOpen}
        data={groupMismatches}
        loading={loadingGroupMismatches}
        error={groupError}
        currentXeroPath={currentXeroPath}
        onToggle={onToggle}
        onRefresh={fetchGroupMismatches}
      />
      <ContactLinkMismatchPanel
        open={contactLinkMismatchesOpen}
        data={linkMismatches}
        loading={loadingLinkMismatches}
        error={linkError}
        currentXeroPath={currentXeroPath}
        onToggle={onToggle}
        onRefresh={fetchLinkMismatches}
        unlinkingMemberId={unlinkingMemberId}
        onUnlink={unlinkContactMismatch}
      />
    </>
  );
}

function MissingInvoicesList({
  loading,
  details,
  currentXeroPath,
}: {
  loading: boolean;
  details: MissingInvoicesResponse | null;
  currentXeroPath: string;
}) {
  if (loading && !details)
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        Loading missing invoice details...
      </p>
    );
  if (!details)
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        No missing invoice details loaded yet.
      </p>
    );
  if (details.count === 0)
    return (
      <p className="mt-4 text-sm text-green-700">
        No paid or confirmed bookings are currently missing a Xero invoice.
      </p>
    );
  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        Showing {details.bookings.length} of {details.count} booking
        {details.count === 1 ? "" : "s"}.
      </p>
      {details.bookings.map((booking) => (
        <div key={booking.bookingId} className="rounded-md border p-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={buildHrefWithReturnTo(
                    `/bookings/${booking.bookingId}`,
                    currentXeroPath,
                  )}
                  className="text-sm font-medium text-blue-600 hover:underline"
                >
                  Booking {shortId(booking.bookingId)}
                </a>
                <Badge variant="outline">{booking.status}</Badge>
              </div>
              <p className="text-sm">
                <a
                  href={buildHrefWithReturnTo(
                    `/admin/members/${booking.memberId}`,
                    currentXeroPath,
                  )}
                  className="text-blue-600 hover:underline"
                >
                  {booking.memberName}
                </a>
                <span className="ml-2 text-muted-foreground">
                  {booking.memberEmail}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(booking.checkIn).toLocaleDateString("en-NZ")} to{" "}
                {new Date(booking.checkOut).toLocaleDateString("en-NZ")} -
                Payment {shortId(booking.paymentId)}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Created {new Date(booking.createdAt).toLocaleString("en-NZ")}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function ContactGroupMismatchPanel({
  open,
  data,
  loading,
  error,
  currentXeroPath,
  onToggle,
  onRefresh,
}: {
  open: boolean;
  data: ContactGroupMismatchResponse | null;
  loading: boolean;
  error: string;
  currentXeroPath: string;
  onToggle: ToggleSection;
  onRefresh: () => Promise<void>;
}) {
  return (
    <SectionCard
      id="xero-section-contactGroupMismatches"
      title="Contact Group Mismatches"
      description="Audit linked members against the managed Xero contact-group mapping configured in Age Group Settings."
      open={open}
      onToggle={(nextOpen) => onToggle("contactGroupMismatches", nextOpen)}
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </Button>
      }
    >
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      {loading && !data ? (
        <p className="text-sm text-muted-foreground">
          Loading contact group mismatches...
        </p>
      ) : data ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  Managed mapping status
                </h3>
                <Badge
                  className={
                    !data.cacheReady
                      ? "bg-slate-600"
                      : data.count > 0
                        ? "bg-amber-500"
                        : "bg-green-600"
                  }
                >
                  {!data.cacheReady
                    ? "Cache needed"
                    : `${data.count} mismatch${data.count === 1 ? "" : "es"}`}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {formatConfiguredMappings(data.configuredMappings)}
              </p>
              <p className="text-xs text-muted-foreground">
                {data.cacheReady && data.lastRefreshedAt
                  ? `Cache last refreshed ${new Date(data.lastRefreshedAt).toLocaleString("en-NZ")}.`
                  : "The shared Xero contact-group cache has not been refreshed yet."}
              </p>
            </div>
            <Link href="/admin/age-tier-settings" className="text-sm text-blue-600 hover:underline">Open Age Group Settings</Link>
          </div>
          {!data.cacheReady ? (
            <p className="text-sm text-muted-foreground">
              Refresh Xero contact groups before relying on this audit.
            </p>
          ) : data.mismatches.length === 0 ? (
            <p className="text-sm text-green-700">
              No linked members are currently mismatched against the managed
              age-tier mappings.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Showing {data.mismatches.length} of {data.count} mismatches.
              </p>
              {data.mismatches.map((mismatch) => (
                <div key={mismatch.memberId} className="rounded-md border p-3">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={buildHrefWithReturnTo(
                            `/admin/members/${mismatch.memberId}`,
                            currentXeroPath,
                          )}
                          className="text-sm font-medium text-blue-600 hover:underline"
                        >
                          {mismatch.memberName}
                        </a>
                        <Badge variant="outline">{mismatch.ageTier}</Badge>
                        {mismatch.missingExpectedGroup ? (
                          <Badge className="bg-red-600">
                            Missing accepted group
                          </Badge>
                        ) : null}
                        {mismatch.unexpectedManagedGroups.length > 0 ? (
                          <Badge className="bg-amber-500">
                            {mismatch.unexpectedManagedGroups.length} extra
                            managed group
                            {mismatch.unexpectedManagedGroups.length === 1
                              ? ""
                              : "s"}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {mismatch.memberEmail}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Accepted managed groups:{" "}
                        {mismatch.acceptedGroups
                          .map(
                            (group) =>
                              `${group.name ?? group.id}${group.isDefault ? " (default)" : ""}`,
                          )
                          .join(", ")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Actual cached groups:{" "}
                        {mismatch.actualGroups.length > 0
                          ? mismatch.actualGroups
                              .map((group) => group.name)
                              .join(", ")
                          : "None"}
                      </p>
                    </div>
                    <a
                      href={`https://go.xero.com/app/contacts/contact/${mismatch.xeroContactId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Open in Xero
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No mismatch audit has been loaded yet.
        </p>
      )}
    </SectionCard>
  );
}

function ContactLinkMismatchPanel({
  open,
  data,
  loading,
  error,
  currentXeroPath,
  onToggle,
  onRefresh,
  unlinkingMemberId,
  onUnlink,
}: {
  open: boolean;
  data: ContactLinkMismatchResponse | null;
  loading: boolean;
  error: string;
  currentXeroPath: string;
  onToggle: ToggleSection;
  onRefresh: () => Promise<void>;
  unlinkingMemberId: string | null;
  onUnlink: (memberId: string) => Promise<void>;
}) {
  return (
    <SectionCard
      id="xero-section-contactLinkMismatches"
      title="Contact Link Mismatches"
      description="Audit linked members whose local name differs from the cached Xero contact name."
      open={open}
      onToggle={(nextOpen) => onToggle("contactLinkMismatches", nextOpen)}
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </Button>
      }
    >
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      {loading && !data ? (
        <p className="text-sm text-muted-foreground">
          Loading contact link mismatches...
        </p>
      ) : data ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  Member/contact name audit
                </h3>
                <Badge
                  className={
                    !data.cacheReady
                      ? "bg-slate-600"
                      : data.count > 0
                        ? "bg-amber-500"
                        : "bg-green-600"
                  }
                >
                  {!data.cacheReady
                    ? "Cache needed"
                    : `${data.count} mismatch${data.count === 1 ? "" : "es"}`}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Compares linked members against the cached Xero contact
                snapshot. Use this to unlink bad email-based matches, then
                relink the correct contact from the member record.
              </p>
              <p className="text-xs text-muted-foreground">
                {data.cacheReady && data.lastRefreshedAt
                  ? `Contact cache last refreshed ${new Date(data.lastRefreshedAt).toLocaleString("en-NZ")}.`
                  : "The shared Xero contact cache has not been refreshed yet."}
              </p>
            </div>
          </div>
          {!data.cacheReady ? (
            <p className="text-sm text-muted-foreground">
              Run contact sync before relying on this audit.
            </p>
          ) : data.mismatches.length === 0 ? (
            <p className="text-sm text-green-700">
              No linked members are currently mismatched against the cached Xero
              contact names.
            </p>
          ) : (
            <div className="space-y-3">
              {data.mismatches.map((mismatch) => (
                <div key={mismatch.memberId} className="rounded-md border p-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={buildHrefWithReturnTo(
                            `/admin/members/${mismatch.memberId}`,
                            currentXeroPath,
                          )}
                          className="text-sm font-medium text-blue-600 hover:underline"
                        >
                          {mismatch.memberName}
                        </a>
                        <Badge
                          variant={mismatch.active ? "default" : "secondary"}
                          className={mismatch.active ? "bg-green-600" : ""}
                        >
                          {mismatch.active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {mismatch.memberEmail}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Cached Xero contact: {mismatch.xeroContactName}
                        {mismatch.xeroContactEmail
                          ? ` (${mismatch.xeroContactEmail})`
                          : ""}
                      </p>
                      <p className="text-xs text-amber-700">
                        {mismatch.reasons.join(", ")}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={buildHrefWithReturnTo(
                          `/admin/members/${mismatch.memberId}`,
                          currentXeroPath,
                        )}
                        className="inline-flex"
                      >
                        <Button variant="outline" size="sm">
                          Open Member
                        </Button>
                      </a>
                      <a
                        href={`https://go.xero.com/app/contacts/contact/${mismatch.xeroContactId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex"
                      >
                        <Button variant="outline" size="sm">
                          Open in Xero
                        </Button>
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void onUnlink(mismatch.memberId)}
                        disabled={unlinkingMemberId === mismatch.memberId}
                      >
                        {unlinkingMemberId === mismatch.memberId
                          ? "Unlinking..."
                          : "Unlink"}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No contact link mismatch audit has been loaded yet.
        </p>
      )}
    </SectionCard>
  );
}

function formatConfiguredMappings(
  mappings: ContactGroupMismatchResponse["configuredMappings"],
) {
  if (mappings.length === 0)
    return "No age-tier to Xero contact-group mappings are configured yet.";
  const groups = mappings.reduce((acc, mapping) => {
    const list = acc.get(mapping.tier) ?? [];
    list.push(
      `${mapping.groupName ?? mapping.groupId}${mapping.isDefault ? " (default)" : ""}`,
    );
    acc.set(mapping.tier, list);
    return acc;
  }, new Map<AgeTier, string[]>());
  return `Configured mappings: ${Array.from(groups)
    .map(([tier, names]) => `${tier} -> ${names.join(", ")}`)
    .join("; ")}`;
}
