import { prisma } from "@/lib/prisma";
import { SETUP_READINESS_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-system";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";
import { readXeroBaseCurrencyForViewer } from "@/lib/xero-base-currency-server";
import {
  buildSetupReadiness,
  normalizeSetupProgress,
} from "@/lib/setup-readiness";

export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const [database, progressRecord, xeroBaseCurrency] = await Promise.all([
    getSetupDatabaseSnapshot(),
    prisma.setupProgress.findUnique({ where: { id: "default" } }),
    // #3633: the Operational Xero step warns when this differs from the club's
    // currency. Only a viewer who may read the Xero organisation summary gets a
    // value; everyone else gets null, which gives no warning.
    readXeroBaseCurrencyForViewer(guard.session.user),
  ]);
  const progress = normalizeSetupProgress(
    progressRecord
      ? {
          completedStepIds: progressRecord.completedStepIds,
          skippedStepIds: progressRecord.skippedStepIds,
          completedAt: progressRecord.completedAt?.toISOString() ?? null,
          completedByMemberId: progressRecord.completedByMemberId,
        }
      : null,
  );

  return connectionJson(
    request,
    {
      readiness: buildSetupReadiness({
        database,
        progress,
        xeroBaseCurrency,
        // This process IS the running app, so its ring's first key is the
        // current one, and its fingerprint the one to give the re-encrypt (#4456).
        dataKeySource: "app",
      }),
      progress,
    },
    SETUP_READINESS_CONNECTION_SHAPE,
  );
}
