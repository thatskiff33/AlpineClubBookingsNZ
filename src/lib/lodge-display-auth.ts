import { createHmac, randomInt, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { hashActionToken, issueActionToken } from "./action-tokens";
import { prisma } from "./prisma";
import { requireAuthSecret } from "./runtime-config";

// Lobby display device auth (fork issue #27, ADR-001): a deliberately
// weakest-privileged, sessionless credential. checkDisplayAuth() resolves
// tokenHash → device → lodgeId and nothing else — it never maps to a Member
// and shares no code path with checkLodgeAuth/KioskTier, so the display token
// can never inherit a kiosk capability by accident.

export const DISPLAY_TOKEN_COOKIE = "tac_lodge_display_token";
export const DISPLAY_PAIRING_COOKIE = "tac_lodge_display_pairing";
export const DISPLAY_TOKEN_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
export const PAIRING_CODE_TTL_SECONDS = 15 * 60;
export const PAIRING_CODE_LENGTH = 6;

// Unambiguous on a TV across the room: no 0/O, 1/I.
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const PAIRING_CODE_PATTERN = new RegExp(
  `^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`
);


export function isPairingCodeFormat(code: string): boolean {
  return PAIRING_CODE_PATTERN.test(code);
}

export function normalisePairingCode(code: string): string {
  return code.trim().toUpperCase();
}

export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

interface PairingBlobPayload {
  code: string;
  exp: number; // unix seconds
}

function signPart(payloadPart: string): string {
  return createHmac("sha256", requireAuthSecret("AUTH_SECRET or NEXTAUTH_SECRET is required for lobby display pairing"))
    .update(`lodge-display-pairing:${payloadPart}`)
    .digest("base64url");
}

/**
 * Encodes the pairing blob the display device holds while waiting for an
 * admin to bind its code (ADR-001 §2): tamper-proof carrier for the code and
 * expiry, so the anonymous pairing-start endpoint persists nothing.
 */
export function encodePairingBlob(payload: PairingBlobPayload): string {
  const part = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${part}.${signPart(part)}`;
}

export function decodePairingBlob(raw: string): PairingBlobPayload | null {
  const [part, signature] = raw.split(".");
  if (!part || !signature) return null;

  const expected = Buffer.from(signPart(part), "utf8");
  const presented = Buffer.from(signature, "utf8");
  if (
    expected.length !== presented.length ||
    !timingSafeEqual(expected, presented)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8")
    ) as Partial<PairingBlobPayload>;
    if (
      typeof payload.code !== "string" ||
      !isPairingCodeFormat(payload.code) ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return { code: payload.code, exp: payload.exp };
  } catch {
    return null;
  }
}

/**
 * Admin bind step (ADR-001 §2.2): persist the code the admin read off the TV
 * onto the device record. The only server-side persistence in the pairing
 * flow — anonymous requests never write.
 */
export async function confirmDevicePairing(
  deviceId: string,
  enteredCode: string
): Promise<
  | { ok: true; expiresAt: Date }
  | { ok: false; error: "invalid-code" | "not-found" | "revoked" }
> {
  const code = normalisePairingCode(enteredCode);
  if (!isPairingCodeFormat(code)) {
    return { ok: false, error: "invalid-code" };
  }

  const device = await prisma.lodgeDisplayDevice.findUnique({
    where: { id: deviceId },
    select: { id: true, revokedAt: true },
  });
  if (!device) return { ok: false, error: "not-found" };
  if (device.revokedAt) return { ok: false, error: "revoked" };

  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000);
  await prisma.lodgeDisplayDevice.update({
    where: { id: deviceId },
    data: { pairingCode: code, pairingCodeExpiresAt: expiresAt },
  });
  return { ok: true, expiresAt };
}

// ---------------------------------------------------------------------------
// Preview grant (LTV-036, ADR-003 §5): a short-lived, signed, single-purpose
// capability that lets a SANDBOXED preview iframe authorise exactly one
// display-state preview WITHOUT a session cookie. The authoring pages render
// authored admin HTML/CSS inside an `sandbox="allow-scripts"` iframe (opaque
// origin, no cookies sent), so the framed /display cannot ride the admin's
// session; instead the admin page mints a grant
// (POST /api/admin/display/preview-grant, requireAdmin) and the frame passes it
// as ?previewGrant=<token>. The state route verifies the HMAC + expiry and
// serves exactly that template/lodge preview — nothing else.
//
// A grant is NOT a display token: it is a query-param blob, shares NO code path
// with checkDisplayAuth (which reads the httpOnly cookie and resolves a device),
// never resolves to a device credential, never stamps lastSeenAt, and is
// honoured ONLY on the state route's preview path — it cannot authorise the
// heartbeat or any admin route. A distinct HMAC domain-separation prefix means
// a pairing blob can never be replayed as a grant and vice versa.
export const PREVIEW_GRANT_TTL_SECONDS = 5 * 60;

const PREVIEW_GRANT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface PreviewGrantPayload {
  /** The authored v2 template to preview (null → the lodge's legacy board, OR a
   * draft preview when `draftNonce` is set). */
  templateId: string | null;
  /** An UNSAVED builder draft to preview (ADR-004 §7): a nonce naming an
   * ephemeral, already-rendered payload in the in-memory draft-preview store.
   * Mutually exclusive with `templateId` (a draft grant sets templateId null).
   * Present only on a draft grant; omitted otherwise. */
  draftNonce?: string;
  /** The lodge to render against — explicit, never silently the default. */
  lodgeId: string;
  /** Optional simulated window start (LTV-017), date-only YYYY-MM-DD. */
  windowStart?: string;
  /** Unix seconds; a grant past its expiry no longer decodes. */
  exp: number;
}

function signGrantPart(payloadPart: string): string {
  return createHmac("sha256", requireAuthSecret("AUTH_SECRET or NEXTAUTH_SECRET is required for lobby display pairing"))
    .update(`lodge-display-preview-grant:${payloadPart}`)
    .digest("base64url");
}

/**
 * Encode a signed preview grant (ADR-003 §5). Stateless: nothing is persisted,
 * the signature is the whole authority, and the 5-minute expiry lives inside the
 * signed payload so it cannot be extended by tampering.
 */
export function encodePreviewGrant(payload: PreviewGrantPayload): string {
  const part = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${part}.${signGrantPart(part)}`;
}

/**
 * Verify and decode a preview grant. Returns null on any failure — bad shape,
 * a tampered/forged signature (timing-safe compare), or an expired grant — so
 * the state route can treat every non-null result as a genuine, unexpired,
 * admin-minted capability.
 */
export function decodePreviewGrant(raw: string): PreviewGrantPayload | null {
  const [part, signature] = raw.split(".");
  if (!part || !signature) return null;

  const expected = Buffer.from(signGrantPart(part), "utf8");
  const presented = Buffer.from(signature, "utf8");
  if (
    expected.length !== presented.length ||
    !timingSafeEqual(expected, presented)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8")
    ) as Partial<PreviewGrantPayload>;
    if (
      typeof payload.lodgeId !== "string" ||
      payload.lodgeId.length === 0 ||
      typeof payload.exp !== "number" ||
      (payload.templateId != null && typeof payload.templateId !== "string") ||
      (payload.draftNonce != null && typeof payload.draftNonce !== "string") ||
      (payload.windowStart != null &&
        !(
          typeof payload.windowStart === "string" &&
          PREVIEW_GRANT_DATE_PATTERN.test(payload.windowStart)
        ))
    ) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      templateId: payload.templateId ?? null,
      ...(payload.draftNonce ? { draftNonce: payload.draftNonce } : {}),
      lodgeId: payload.lodgeId,
      ...(payload.windowStart ? { windowStart: payload.windowStart } : {}),
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

export interface ClaimedDisplayToken {
  token: string;
  device: { id: string; lodgeId: string; name: string };
}

/**
 * Device claim step (ADR-001 §2.3): the display presents its signed blob;
 * if an admin has bound that exact code to a device, issue the long-lived
 * display token (hash at rest), clearing the pairing fields (single-use).
 * A successful claim on a previously paired device REPLACES tokenHash —
 * the device-swap story; the old token dies immediately.
 */
export async function claimDisplayToken(
  code: string
): Promise<ClaimedDisplayToken | null> {
  const normalised = normalisePairingCode(code);
  if (!isPairingCodeFormat(normalised)) return null;

  const device = await prisma.lodgeDisplayDevice.findFirst({
    where: {
      pairingCode: normalised,
      pairingCodeExpiresAt: { gt: new Date() },
      revokedAt: null,
    },
    select: { id: true, lodgeId: true, name: true },
  });
  if (!device) return null;

  const { token, tokenHash } = issueActionToken();
  await prisma.lodgeDisplayDevice.update({
    where: { id: device.id },
    data: {
      tokenHash,
      pairingCode: null,
      pairingCodeExpiresAt: null,
    },
  });

  return { token, device };
}

export interface DisplayAuthResult {
  device: {
    id: string;
    lodgeId: string;
    name: string;
    templateId: string | null;
    // Per-device state-poll cadence override in seconds (LTV-039); null = the
    // client default. The state route clamps it before serving it to the client.
    pollSeconds: number | null;
  };
}

/**
 * The display-surface guard. Authorises ONLY the display page shell, the
 * display-state API, and the heartbeat — resolved purely from the hashed
 * token to its device and the device's lodge FK. Rejections never update
 * lastSeenAt (issue #27 AC6).
 */
export async function checkDisplayAuth(
  request: NextRequest
): Promise<DisplayAuthResult | null> {
  const raw = request.cookies.get(DISPLAY_TOKEN_COOKIE)?.value;
  if (!raw || raw.trim().length === 0) return null;

  const device = await prisma.lodgeDisplayDevice.findUnique({
    where: { tokenHash: hashActionToken(raw.trim()) },
    select: {
      id: true,
      lodgeId: true,
      name: true,
      templateId: true,
      pollSeconds: true,
      revokedAt: true,
      lodge: { select: { active: true } },
    },
  });

  if (!device || device.revokedAt || !device.lodge.active) return null;

  return {
    device: {
      id: device.id,
      lodgeId: device.lodgeId,
      name: device.name,
      templateId: device.templateId,
      pollSeconds: device.pollSeconds,
    },
  };
}

/** Heartbeat bookkeeping: only ever called after checkDisplayAuth passes. */
export async function markDisplaySeen(deviceId: string): Promise<void> {
  await prisma.lodgeDisplayDevice.update({
    where: { id: deviceId },
    data: { lastSeenAt: new Date() },
  });
}
