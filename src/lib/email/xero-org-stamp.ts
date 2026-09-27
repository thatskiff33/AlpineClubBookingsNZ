import { applyXeroOrgShortCode } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";

/**
 * Stamp the club's Xero organisation onto an outbound deep link, at SEND time
 * (#2314, owner decision 1 Aug 2026). Shared by the finance alerts and the
 * kept internet banking hold alert (#3643), so it is its own leaf.
 *
 * The URLs reaching these alerts are organisation-agnostic: some are read
 * straight off a `XeroSyncOperation` / `XeroObjectLink` row, which #2314
 * deliberately keeps generic so a reconnect to a different Xero organisation
 * cannot leave stored links aimed at books the club no longer owns. A screen can
 * re-render and pick the current organisation up; an email cannot. So an email
 * is the surface that most needs the organisation named, and send time is the
 * last honest moment to name it — the alert is already a point-in-time snapshot
 * of everything else it reports.
 *
 * The organisation is CONFIRMED with Xero at send time rather than read from
 * the 12-hour cache (`confirmLive`, #2314 review). The cache is per process and
 * its invalidation only reaches the process that handled a reconnect, so a cron
 * or worker process can otherwise hold the previous organisation's short code
 * for hours — and an email stamped with it is stamped forever.
 *
 * Failure degrades, never blocks: no short code (Xero disconnected, the
 * organisation read failed, or Xero reported none) leaves the generic
 * `go.xero.com` link, which is live — it may just ask a multi-organisation
 * admin which organisation they meant. It also STRIPS any organisation the
 * stored URL already carried, so an unconfirmable organisation is never the one
 * an email points at.
 */
export async function stampXeroOrganisation(
  url: string | null | undefined,
): Promise<string | null> {
  if (!url) return null;
  return applyXeroOrgShortCode(url, {
    shortCode: await getXeroOrgShortCode({ confirmLive: true }),
  });
}
