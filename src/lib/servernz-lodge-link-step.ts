import "server-only";
import {
  labelOwnedLodges,
  saveCentralLodgeLinks,
  suggestedCentralLodgeId,
} from "@/lib/central-lodge-link";
import { syncOwnOtherLodgesFromFees } from "@/lib/other-lodge-fees-sync";
import type { OwnedCentralLodge } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { assertStoredServerVersionMatches } from "@/lib/servernz-api";
import { downloadOtherClubsFromServer } from "@/lib/servernz-other-lodges-sync";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { auditDownload } from "@/lib/servernz-sync-response";
import { withOtherLodgesSyncClaim } from "@/lib/servernz-sync-claim";

/**
 * The setup page's second step after a key save: pull the central server's
 * lodges, then link this club's lodges to the ones the server says it owns
 * (`Lodge.centralLodgeId`, #62), so the central lodge search can ask about
 * free beds without the administrator finding the Central lodge card.
 *
 * NOTHING IS LINKED WITHOUT THE ADMINISTRATOR'S SAVE (owner decision,
 * 24 Oct 2026, #4262: every club links explicitly, a one-lodge club
 * included). A club with one active lodge and one owned central lodge gets the
 * dialog with that link preselected, so one press of Save links it; every
 * other club gets the choice with its current links preselected. A saved link
 * is never changed without the administrator choosing it.
 *
 * The download runs under the Other lodges sync claim, with no transaction
 * held across it (INV-INT-003); the link save is its own short transaction
 * (`saveCentralLodgeLinks`). Repeating the step is harmless: a download is
 * idempotent, and a linked lodge is reported, never re-linked.
 */

export interface LinkStepLodge {
  id: string;
  name: string;
  active: boolean;
  centralLodgeId: string | null;
  /** What the dialog preselects when the lodge has no link. */
  suggestedCentralLodgeId: string | null;
}

export type LodgeLinkStep =
  /** Other Clubs sharing is off, so nothing was downloaded or linked. */
  | { kind: "sharing-off" }
  /** The server has said this club owns no lodge (pending, or none requested). */
  | { kind: "no-owned" }
  /** No local lodge to link. */
  | { kind: "no-lodges" }
  /** Another sync held the claim and no owned list is stored yet: try again shortly. */
  | { kind: "download-running" }
  /** Every owned central lodge is already linked to an active lodge. */
  | { kind: "already-linked" }
  | {
      kind: "choose";
      lodges: LinkStepLodge[];
      owned: Array<{ id: string; name: string; label: string }>;
    };

export interface LodgeLinkStepResult {
  step: LodgeLinkStep;
  /** The download's own outcome: `running` when another pass held the claim. */
  download: "downloaded" | "running" | "skipped";
}

/**
 * Run the step. Throws what the download throws (a version pause, a refused
 * or unreachable server) for the route to answer as the Download button does.
 */
export async function runLodgeLinkStep(actorMemberId: string): Promise<LodgeLinkStepResult> {
  const settings = await loadServerNzSettings();
  if (!settings.otherLodgesEnabled) return { step: { kind: "sharing-off" }, download: "skipped" };
  // The recorded version first, as the Download button does (#66).
  if (settings.baseUrl) assertStoredServerVersionMatches(settings.serverVersion);
  const pulled = await withOtherLodgesSyncClaim(() => downloadOtherClubsFromServer());
  if (pulled !== null) {
    await auditDownload(pulled, actorMemberId, "Downloaded Other Clubs from Alpine Central Server after the API key was saved");
  }
  // A held claim means another pass is downloading now; the stored list is
  // still the best answer to link from.
  const download = pulled === null ? "running" : "downloaded";
  const owned = (await loadServerNzSettings()).otherLodgesOwnedLodges;
  // A key save forgot the owned list; without a download of our own, "none
  // listed" would name the wrong cause.
  if (owned === null && download === "running") return { step: { kind: "download-running" }, download };
  return { step: await decideLinks(owned), download };
}

async function decideLinks(owned: ReadonlyArray<OwnedCentralLodge> | null): Promise<LodgeLinkStep> {
  if (!owned || owned.length === 0) return { kind: "no-owned" };
  const ownedIds = owned.map((l) => l.id);
  // The active lodges, and any inactive one holding an owned link: the dialog
  // must show that one too, or its central lodge could not be moved.
  const lodges = await prisma.lodge.findMany({
    where: { OR: [{ active: true }, { centralLodgeId: { in: ownedIds } }] },
    select: { id: true, name: true, active: true, centralLodgeId: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (lodges.length === 0) return { kind: "no-lodges" };
  const active = lodges.filter((l) => l.active);
  const linkedActive = new Set(active.flatMap((l) => (l.centralLodgeId ? [l.centralLodgeId] : [])));
  if (ownedIds.every((id) => linkedActive.has(id))) return { kind: "already-linked" };

  const suggested = suggestedCentralLodgeId(owned, active);
  const [onlyActive] = active;
  // Not offered when another lodge (an inactive one) holds that link.
  const heldElsewhere = lodges.some((l) => l.centralLodgeId === owned[0]?.id);

  return {
    kind: "choose",
    lodges: lodges.map((l) => ({
      ...l,
      suggestedCentralLodgeId: l.id === onlyActive?.id && !heldElsewhere ? suggested : null,
    })),
    owned: await labelOwnedLodges(owned),
  };
}

/**
 * Save the dialog's choices, every row in one transaction, then fill the own
 * lodge's rates from the Fees page now that it is linked.
 */
export async function saveLodgeLinkChoices(
  links: ReadonlyArray<{ lodgeId: string; centralLodgeId: string | null; expectCurrent: string | null }>,
  actorMemberId: string,
) {
  const saved = await saveCentralLodgeLinks(links, actorMemberId);
  if (saved.ok) await syncOwnOtherLodgesFromFees("central lodge linked", actorMemberId);
  return saved;
}
