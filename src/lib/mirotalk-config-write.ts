import "server-only";

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import {
  deleteIntegrationCredential,
  setIntegrationCredential,
} from "@/lib/integration-credentials";
import type {
  CredentialActor,
  CredentialDeleteExpectation,
  CredentialRequestContext,
  CredentialWriteExpectation,
} from "@/lib/integration-credential-actor";
import {
  MIROTALK_SETTINGS_ID,
  readMirotalkStoredSettings,
  type MirotalkStoredSettings,
} from "@/lib/mirotalk-config";
import {
  MIROTALK_PROVIDER,
  MIROTALK_WRITABLE_CREDENTIAL_KEYS,
  type MirotalkCredentialKey,
  type MirotalkSettingsDraft,
} from "@/lib/mirotalk-settings-shared";

/**
 * THE FOUR MiroTalk WRITES (#2940) — everything an administrator's Save or
 * Clear does, and nothing a join link does.
 *
 * The seam is direction, not size. `mirotalk-config.ts` answers "what is the
 * configuration right now": it reads the singleton, resolves each field through
 * database -> environment -> derived, and hands the join builder a URL. Nothing
 * on that path writes. These four are the other direction, reached only from
 * the two admin routes under `/api/admin/integrations/mirotalk`, and they are
 * the only code in this feature that mutates a row or writes an audit entry.
 *
 * Keeping them apart is what stops a member clicking Join from dragging the
 * audit writer and the credential MUTATORS into that request's module graph —
 * the resolver reaches the credential store for its read and its cache
 * invalidation only, and for none of its writes. It also gives the
 * credential-actor census (#2723) one file to name for this feature's three
 * mutator call sites instead of a file it shares with the resolver.
 *
 * They import the resolver and it never imports them, so the edge stays
 * one-directional: settings-write -> config -> settings-shared.
 */

/**
 * Save the non-secret settings an administrator staged.
 *
 * An empty string clears the column, which is what returns that field to the
 * environment fallback — there is no other way back, and a club that sets an
 * address once must be able to undo it. Validation has already run in the API
 * route (and again in the resolver), so what arrives here is storable.
 *
 * LAST WRITE WINS, deliberately, and it is a different answer from the secrets
 * below. Every value here is visible in the form to both administrators, so a
 * concurrent overwrite is something they can see and correct on the next load.
 * A secret is not: nobody can read back what the other person stored, which is
 * why those writes declare an expectation and lose deterministically instead.
 */
export async function writeMirotalkSettings(params: {
  draft: MirotalkSettingsDraft;
  memberId: string;
  changedFields: string[];
  /**
   * The address before and after, when it moved. RECORDED IN FULL, and this is
   * the one field on this screen where that is the right answer: the address is
   * not a secret — the status hands it to any finance-view admin and the page
   * renders it — so writing it down costs no confidentiality, and without it the
   * REFUSAL below is audited with more specificity than the acceptance. Redirect
   * the address, wait for somebody to click Join, restore it, and the only trace
   * left anywhere would be "changed: meeting server address".
   */
  addressChange?: { from: string | null; to: string | null };
  /** Secrets dropped because the address moved (see the clear helper below). */
  secretsCleared?: readonly MirotalkCredentialKey[];
}): Promise<MirotalkStoredSettings> {
  const data = {
    baseUrl: params.draft.baseUrl.trim() || null,
    presenterEnabled: params.draft.presenterEnabled,
    tokenLifetime: params.draft.tokenLifetime.trim() || null,
    updatedByMemberId: params.memberId,
  };

  await prisma.mirotalkSettings.upsert({
    where: { id: MIROTALK_SETTINGS_ID },
    create: { id: MIROTALK_SETTINGS_ID, ...data },
    update: data,
  });

  const move = params.addressChange;
  const cleared = params.secretsCleared ?? [];
  await createAuditLog({
    action: "mirotalk.settings.update",
    category: "admin",
    severity: "info",
    outcome: "success",
    memberId: params.memberId,
    actorMemberId: params.memberId,
    entityType: "MirotalkSettings",
    entityId: MIROTALK_SETTINGS_ID,
    summary: "Updated the video-meeting settings",
    details:
      `changed: ${params.changedFields.join(", ") || "none"}` +
      (move
        ? `; meeting server address ${move.from ?? "(not set)"} -> ${move.to ?? "(not set)"}`
        : "") +
      (cleared.length
        ? `; stored secrets cleared because the address moved: ${cleared.join(", ")}`
        : ""),
    metadata: move
      ? { baseUrlBefore: move.from, baseUrlAfter: move.to }
      : undefined,
  });

  return readMirotalkStoredSettings();
}

/**
 * Drop every STORED MiroTalk secret, because the meeting server address moved.
 *
 * WHY THIS IS RIGHT, and it is the Alpine Central Server remedy copied on its
 * own terms: these three are meaningful only to the MiroTalk instance they were
 * paired with. The signing key has to equal that instance's `JWT_KEY` and the
 * username/password have to match one of its `HOST_USERS` entries, so a genuine
 * address move invalidates them exactly as it invalidates the central server's
 * API key. It also makes the Full-Admin gate robust rather than merely correct:
 * a redirected join link has no stored credential left to carry.
 *
 * WHAT IT DOES NOT FIX, stated here because the honest version of this remedy
 * has to carry its own limit. Clearing the stored secrets falls back to
 * `MIRO_JWT_KEY` / `MIRO_MEETING_USERNAME` / `MIRO_MEETING_PASSWORD`, which were
 * set for the OLD server, so on an install that still has them this is
 * cosmetic — the redirected host receives a token minted with the environment
 * credentials. On the install shape `.env.example` now recommends, where those
 * variables are left empty and everything is set on the page, there is nothing
 * to fall back to: the resolver returns unset, the join builder takes the
 * no-token branch and the redirected host receives nothing at all. So this is
 * strictly better in every install and worse in none, and it is the ONLY lever
 * the club has, because a Full Admin cannot read a stored secret back out to
 * re-supply it. Suppressing the environment fallback whenever the address is
 * database-sourced would close the remaining half, and is deliberately NOT done
 * here: it breaks the mixed migration path this change exists to support, so it
 * is an owner's trade rather than an implementor's.
 *
 * `{ expect: "any" }` rather than a version, unlike everything else this screen
 * writes. The fence exists for a read-modify-write an administrator performed
 * against a value the screen showed them; this is a consequence of a different
 * write, and the intended end state is "gone" however many times somebody else
 * replaced it in between. A key that is absent already is a silent no-op that
 * audits nothing, which is why the caller is told WHICH keys were really there.
 */
export async function clearMirotalkSecretsForAddressMove(params: {
  actor: CredentialActor;
  request?: CredentialRequestContext;
}): Promise<MirotalkCredentialKey[]> {
  const rows = await prisma.integrationCredential.findMany({
    where: {
      provider: MIROTALK_PROVIDER,
      key: { in: [...MIROTALK_WRITABLE_CREDENTIAL_KEYS] },
    },
    select: { key: true },
  });
  const stored = new Set(rows.map((row) => row.key));
  const cleared: MirotalkCredentialKey[] = [];
  for (const key of MIROTALK_WRITABLE_CREDENTIAL_KEYS) {
    if (!stored.has(key)) continue;
    await deleteIntegrationCredential({
      provider: MIROTALK_PROVIDER,
      key,
      actor: params.actor,
      expect: { expect: "any" },
      request: params.request,
    });
    cleared.push(key);
  }
  return cleared;
}

/**
 * Store (or replace) one MiroTalk secret.
 *
 * THE EXPECTATION IS THE CALLER'S, and it is what makes two open tabs safe:
 * the screen read the status, saw "set" or "not set", and says so here. A
 * second administrator who saved in between changed the stored tuple, so this
 * write matches nothing, throws `StaleCredentialWriteError`, changes nothing
 * and audits nothing — instead of quietly replacing a key the first
 * administrator has already told their MiroTalk instance about.
 *
 * The plaintext goes no further than this argument: `setIntegrationCredential`
 * encrypts before the transaction opens, and the audit row it writes inside
 * that transaction is built from a type with no field a value fits into
 * (#2723).
 */
export async function setMirotalkSecret(params: {
  key: MirotalkCredentialKey;
  value: string;
  actor: CredentialActor;
  expect: CredentialWriteExpectation;
  request?: CredentialRequestContext;
}): Promise<void> {
  await setIntegrationCredential({
    provider: MIROTALK_PROVIDER,
    key: params.key,
    value: params.value,
    actor: params.actor,
    expect: params.expect,
    request: params.request,
  });
}

/**
 * Remove one stored MiroTalk secret, returning that field to the environment
 * fallback (or to "not configured" when the environment has none either).
 *
 * This is the read-modify-write the delete fence was built for. An
 * administrator presses Clear because the screen told them a secret is stored;
 * if somebody replaced it in between, clearing it "successfully" would delete
 * the replacement and report a win. Declaring the version the screen read makes
 * that lose instead.
 */
export async function clearMirotalkSecret(params: {
  key: MirotalkCredentialKey;
  actor: CredentialActor;
  expect: CredentialDeleteExpectation;
  request?: CredentialRequestContext;
}): Promise<void> {
  await deleteIntegrationCredential({
    provider: MIROTALK_PROVIDER,
    key: params.key,
    actor: params.actor,
    expect: params.expect,
    request: params.request,
  });
}
