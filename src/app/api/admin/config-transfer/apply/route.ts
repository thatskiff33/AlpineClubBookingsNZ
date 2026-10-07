import { NextResponse } from "next/server";

import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  applyConfigImport,
  ConfigImportBackupError,
  ConfigImportDriftError,
  ConfigImportValidationError,
} from "@/lib/config-transfer/apply";
import { ConfigTransferBundleError } from "@/lib/config-transfer/bundle";
import {
  readBundleUpload,
  requireFullAdminForConfigTransfer,
} from "@/lib/config-transfer/route-helpers";
import { configTransferErrorResponse } from "@/lib/config-transfer/route-error";
import { primeClubIdentitySync } from "@/lib/club-identity-settings";
import { invalidateAgeTierCache } from "@/lib/age-tier";
import { primeEmailPalette } from "@/lib/email-theme";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import {
  invalidatePublicLayoutConfig,
  PUBLIC_LAYOUT_CACHE_TAGS,
} from "@/lib/public-layout-cache";
import { clubFormatValues } from "@/lib/club-format-server";

// POST /api/admin/config-transfer/apply — full-admin only.
// Applies a previewed bundle: backup → one transaction { advisory lock →
// re-plan → refuse on validation errors or fingerprint drift → upsert }.
// Multipart: 'bundle' file + 'expectedFingerprint' + mode/categories/resolutions
// from the dry-run. Failed/refused applies are audit-logged too (ADR-002).

export async function POST(request: Request) {
  const guard = await requireFullAdminForConfigTransfer();
  if (!guard.ok) return guard.response;

  const uploaded = await readBundleUpload(request);
  if (!uploaded.ok) return uploaded.response;
  const { bytes, mode, selectedCategories, resolutions, expectedFingerprint } =
    uploaded.upload;
  if (!expectedFingerprint) {
    return NextResponse.json(
      { error: "Missing 'expectedFingerprint' (run the dry-run first)." },
      { status: 400 },
    );
  }

  const auditFailure = async (reason: string, detail?: string) => {
    await createAuditLog({
      action: "configuration.import_refused",
      memberId: guard.memberId,
      category: "admin",
      severity: "important",
      outcome: "failure",
      summary: `Configuration import refused (${reason})`,
      metadata: { reason, ...(detail ? { detail: detail.slice(0, 500) } : {}), mode },
    });
  };

  // The club's format (#3565), resolved once per request, before the apply
  // transaction.
  const format = await clubFormatValues();

  try {
    const result = await applyConfigImport({
      prisma,
      bundleBytes: bytes,
      actorMemberId: guard.memberId,
      expectedFingerprint,
      mode,
      selectedCategories,
      resolutions,
      format,
    });
    revalidatePublicPageContent();
    invalidatePublicLayoutConfig(
      PUBLIC_LAYOUT_CACHE_TAGS.modules,
      PUBLIC_LAYOUT_CACHE_TAGS.theme,
      PUBLIC_LAYOUT_CACHE_TAGS.capacity,
      PUBLIC_LAYOUT_CACHE_TAGS.banners,
      PUBLIC_LAYOUT_CACHE_TAGS.identity,
    );
    // Config transfer can replace ClubTheme outside the site-style route.
    // Refresh the process-local email palette alongside the public theme tag
    // so web and email colours converge immediately (#1912/#1915).
    await primeEmailPalette();
    // Likewise, config transfer can replace ClubIdentitySettings / the default
    // Lodge: refresh the sync identity accessor alongside the identity tag so
    // sync call sites (TOTP issuer) see the imported identity immediately
    // (E3 #1929; precedent 5107a136 for the email theme).
    await primeClubIdentitySync();
    // Age-tier classification and per-tier pricing read a 5-minute in-process
    // cache (getAgeTierSettings). A boundary-shifting import must clear it so the
    // imported tiers take effect immediately, exactly as the admin PUT does —
    // gated on the age-tier entity actually changing so an unrelated import does
    // not needlessly drop the cache (#2200).
    if (result.appliedEntities.includes("age-tier")) {
      invalidateAgeTierCache();
    }
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ConfigImportDriftError) {
      await auditFailure("fingerprint drift");
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ConfigImportValidationError) {
      await auditFailure("validation errors", error.errors.join("; "));
      return NextResponse.json(
        { error: error.message, errors: error.errors },
        { status: 422 },
      );
    }
    if (error instanceof ConfigImportBackupError) {
      await auditFailure("backup failed", error.message);
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof ConfigTransferBundleError) {
      await auditFailure("invalid bundle", error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    await auditFailure("unexpected error");
    return configTransferErrorResponse("Apply", error);
  }
}
