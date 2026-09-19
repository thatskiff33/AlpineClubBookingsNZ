import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { isFullAdmin } from "@/lib/access-roles";
import { requireAdmin } from "@/lib/session-guards";
import { StaleCredentialWriteError } from "@/lib/integration-credential-actor";
import { INTEGRATION_CREDENTIAL_VALUE_MAX_LENGTH } from "@/lib/integration-credentials";
import { WeakAuthSecretError } from "@/lib/integration-crypto";
import { clearMirotalkSecret, setMirotalkSecret } from "@/lib/mirotalk-config-write";
import {
  MIROTALK_CREDENTIAL_KEYS,
  MIROTALK_CREDENTIAL_LABELS,
  MIROTALK_PROVIDER,
  isMirotalkCredentialKey,
  type MirotalkCredentialKey,
} from "@/lib/mirotalk-settings-shared";
import { describeMirotalkJwtKeyWeakness } from "@/lib/mirotalk-token";
import logger from "@/lib/logger";

/**
 * The three MiroTalk secrets (#2940) — write-only, Full Admin.
 *
 * POST   store or replace one.
 * DELETE remove one, which returns that secret to the environment fallback.
 *
 * ## Why these are not on the shared credentials route
 *
 * `/api/admin/integrations/credentials` writes every other provider's secrets
 * and passes `{ expect: "any" }`, with the reasoning stated there: the form
 * posts the value it wants stored, so there is no read-modify-write for a
 * second Full Admin to make stale. That reasoning holds for a pure overwrite
 * and does not hold here, because this screen also offers CLEAR. An
 * administrator presses Clear having been told a secret is stored; if somebody
 * replaced it in between, an unconditional delete would remove the replacement
 * and report success — a lost race reported as a win, which is exactly what
 * #2723's fence exists to remove. So every write from this screen declares
 * what it expects to find.
 *
 * ## The browser never gets to ask for an unconditional write
 *
 * The request carries a `version` — the token the status GET returned, or null
 * for "I was told nothing is stored" — and this route turns it into the
 * expectation. `{ expect: "any" }` is therefore unreachable over the wire: a
 * client cannot request an overwrite that is stale by construction, only
 * declare what it saw.
 *
 * ## Exposure
 *
 * No value is returned, logged, or put in an audit row. The store writes the
 * audit row itself, inside the same transaction as the secret, from a type
 * with no field a value fits into.
 */

/**
 * The longest concurrency token this route will read.
 *
 * #2723 defines it as a hex SHA-256, so 64 characters; the bound is generous
 * enough to outlive a change of digest and short enough that nothing unbounded
 * reaches the store. ONE constant because the POST and the DELETE must agree:
 * the POST capped it and the DELETE read it off the query string unbounded, so
 * the two doors to the same store disagreed about what a token can be (#2940
 * review, S3).
 */
const MIROTALK_VERSION_MAX_LENGTH = 128;

const setBodySchema = z
  .object({
    key: z.string().min(1).max(64),
    // Capped by the store's own bound, which the shared credentials route reads
    // too — the same fact, from the same place. Never logged, never returned.
    value: z.string().min(1).max(INTEGRATION_CREDENTIAL_VALUE_MAX_LENGTH),
    // The token the status GET handed out, or null when it said "not set".
    version: z.string().min(1).max(MIROTALK_VERSION_MAX_LENGTH).nullable(),
  })
  .strict();

/**
 * THE REFUSAL IS AUDITED, for the same reason the sibling settings route audits
 * its own: `finance: edit` admits a Treasurer-shaped custom role, so somebody
 * reaching this gate is an admin trying to write a capability secret they may
 * not write, and that is the event worth having a row for. It was missing while
 * the LOWER-risk settings write recorded one, which left the higher-risk door
 * the quieter of the two.
 */
async function requireFullAdmin(action: "store" | "clear") {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return { ok: false as const, response: guard.response };
  const memberId = guard.session.user.id;
  if (!isFullAdmin({ accessRoles: guard.session.user.accessRoles })) {
    await createAuditLog({
      action: "mirotalk.credentials.denied",
      category: "security",
      severity: "important",
      outcome: "failure",
      memberId,
      actorMemberId: memberId,
      entityType: "IntegrationCredential",
      entityId: MIROTALK_PROVIDER,
      summary: `Refused a non-Full-Admin attempt to ${action} a video-meeting host sign-in value`,
    });
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Full admin access is required." },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, memberId };
}

function staleResponse(key: MirotalkCredentialKey) {
  return NextResponse.json(
    {
      error: `Somebody else changed the ${MIROTALK_CREDENTIAL_LABELS[key].toLowerCase()} first, so this change was not applied. Reload the page to see what is stored now.`,
    },
    { status: 409 },
  );
}

export async function POST(request: Request) {
  const guard = await requireFullAdmin("store");
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = setBodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { key, value, version } = parsed.data;
  if (!isMirotalkCredentialKey(key)) {
    return NextResponse.json(
      { error: "Unknown credential key." },
      { status: 400 },
    );
  }

  try {
    await setMirotalkSecret({
      key,
      value,
      actor: { kind: "admin", memberId: guard.memberId },
      expect: version === null ? { expect: "absent" } : { expect: "version", version },
      request: getAuditRequestContext(request),
    });
  } catch (error) {
    if (error instanceof StaleCredentialWriteError) return staleResponse(key);
    if (error instanceof WeakAuthSecretError) {
      // The app's own encryption secret is too weak to wrap anything. Plain
      // English and safe to surface — it names no stored value.
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Never echo the request body or the value in the error.
    logger.error(
      { provider: "mirotalk", key, err: error instanceof Error ? error.name : "unknown" },
      "Failed to store MiroTalk credential",
    );
    return NextResponse.json(
      { error: "Could not store that value." },
      { status: 500 },
    );
  }

  // Advisory, never blocking (#2841): a weak signing key still mints working
  // links, because a meeting link that silently stops working is a worse
  // failure for a club than a guessable one. Until now the warning went only
  // to the server log, where the club never saw it; the person who just typed
  // the key is the one who can fix it.
  const warning =
    key === MIROTALK_CREDENTIAL_KEYS.jwtKey
      ? describeMirotalkJwtKeyWeakness(value)
      : null;

  return NextResponse.json({
    ok: true,
    key,
    warning: warning
      ? `The signing key ${warning}. It both signs every join link and encrypts the host sign-in inside it, so a guessable value lets anyone open your meetings as host. Generate one with "openssl rand -base64 32" and set the same value as MiroTalk's own JWT_KEY. Links keep working either way.`
      : null,
  });
}

export async function DELETE(request: Request) {
  const guard = await requireFullAdmin("clear");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "";
  const version = url.searchParams.get("version") ?? "";
  if (!isMirotalkCredentialKey(key)) {
    return NextResponse.json({ error: "Unknown credential key." }, { status: 400 });
  }
  if (!version || version.length > MIROTALK_VERSION_MAX_LENGTH) {
    // A clear with nothing to compare against is the unconditional delete this
    // route exists to refuse, so it is a bad request rather than a silent
    // `{ expect: "any" }`. The same length bound the POST applies: a token is
    // a token whichever door it arrives at, and an unbounded query parameter
    // reaching the store was the asymmetry (#2940 review, S3).
    return NextResponse.json(
      { error: "Reload the page and try again." },
      { status: 400 },
    );
  }

  try {
    await clearMirotalkSecret({
      key,
      actor: { kind: "admin", memberId: guard.memberId },
      expect: { expect: "version", version },
      request: getAuditRequestContext(request),
    });
  } catch (error) {
    if (error instanceof StaleCredentialWriteError) return staleResponse(key);
    logger.error(
      { provider: "mirotalk", key, err: error instanceof Error ? error.name : "unknown" },
      "Failed to clear MiroTalk credential",
    );
    return NextResponse.json(
      { error: "Could not clear that value." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, key });
}
