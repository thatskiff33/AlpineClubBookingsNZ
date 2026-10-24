import "server-only";
import type { Prisma } from "@prisma/client";

import { readIntegrationCredentialRow } from "@/lib/integration-credentials";
import { prisma } from "@/lib/prisma";
import {
  assertStoredServerVersionMatches,
  refreshStoredServerVersion,
  ServerNzNotConfiguredError,
} from "@/lib/servernz-api";
import { SERVERNZ_CREDENTIAL_KEYS, SERVERNZ_PROVIDER } from "@/lib/servernz-config";
import {
  loadServerNzSettings,
  recordServerVersionCheck,
  lockServerNzSettings,
  SERVERNZ_SETTINGS_ID,
  validateCentralServerBaseUrl,
} from "@/lib/servernz-settings";

/** Never log this snapshot: `api` contains the request's plaintext credential. */
export async function captureServerNzSyncConnection() {
  const snapshot = await prisma.$transaction(async (tx) => {
    await lockServerNzSettings(tx);
    const settings = await loadServerNzSettings(tx);
    const row = await tx.serverNzSettings.findUnique({
      where: { id: SERVERNZ_SETTINGS_ID },
      select: { otherLodgesSyncStartedAt: true },
    });
    // Read through the database, never the cross-process credential cache: the
    // value sent and the identity fenced below must describe the SAME row.
    const key = await readIntegrationCredentialRow(tx, SERVERNZ_PROVIDER, SERVERNZ_CREDENTIAL_KEYS.apiKey);
    if (!settings.baseUrl || key.status !== "configured") {
      throw new ServerNzNotConfiguredError("The Alpine Central Server connection is not configured.");
    }
    const address = validateCentralServerBaseUrl(settings.baseUrl);
    if (!address.ok) throw new ServerNzNotConfiguredError("The stored Alpine Central Server base URL is not usable.");
    return {
      settings,
      api: { baseUrl: address.value as string, apiKey: key.value },
      version: key.version,
      claim: row?.otherLodgesSyncStartedAt?.toISOString() ?? null,
    };
  });
  // Version discovery is a provider call too: it belongs OUTSIDE the row lock.
  const version = snapshot.settings.serverVersion ?? await refreshStoredServerVersion(
    snapshot.api, (answer) => recordServerNzSyncVersion(snapshot, answer),
  );
  assertStoredServerVersionMatches(version);
  return snapshot;
}

type ServerNzSyncConnection = {
  settings: Awaited<ReturnType<typeof loadServerNzSettings>>;
  api: { baseUrl: string; apiKey: string };
  version: string;
  claim: string | null;
};

export class ServerNzSyncSupersededError extends Error {
  constructor() {
    super("The Alpine Central Server connection changed or the sync claim was superseded. Download again.");
    this.name = "ServerNzSyncSupersededError";
  }
}

/** Settings -> credential read -> domain rows; no provider call under this lock. */
export async function withServerNzSyncTransaction<T>(
  snapshot: ServerNzSyncConnection,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockServerNzSettings(tx);
    const current = await tx.serverNzSettings.findUnique({
      where: { id: SERVERNZ_SETTINGS_ID },
      select: {
        baseUrl: true, otherLodgesCursor: true, otherLodgesKeyedAt: true,
        otherLodgesSyncStartedAt: true,
      },
    });
    const key = await readIntegrationCredentialRow(tx, SERVERNZ_PROVIDER, SERVERNZ_CREDENTIAL_KEYS.apiKey);
    if (
      !current || current.baseUrl !== snapshot.settings.baseUrl ||
      key.status !== "configured" || key.version !== snapshot.version ||
      (current.otherLodgesSyncStartedAt?.toISOString() ?? null) !== snapshot.claim ||
      current.otherLodgesCursor !== snapshot.settings.otherLodgesCursor ||
      (current.otherLodgesKeyedAt?.toISOString() ?? null) !== snapshot.settings.otherLodgesKeyedAt
    ) throw new ServerNzSyncSupersededError();
    return work(tx);
  });
}

/** Version discovery and 409 answers describe this same captured connection. */
export async function recordServerNzSyncVersion(snapshot: ServerNzSyncConnection, answer: string) {
  return withServerNzSyncTransaction(snapshot, async (tx) => {
    await recordServerVersionCheck(answer, new Date(), tx);
    return answer;
  });
}
