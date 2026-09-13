import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Non-secret Alpine Central Server (ServerNZ) connection settings — a singleton
 * row keyed on the fixed id "default" (mirrors LodgeSettings). The API key is
 * NOT here; it lives in the encrypted IntegrationCredential store (see
 * `servernz-config.ts`).
 */

export const SERVERNZ_SETTINGS_ID = "default";

export interface ServerNzSettingsValues {
  baseUrl: string | null;
  otherLodgesEnabled: boolean;
  otherLodgesLastUploadAt: string | null;
  otherLodgesLastDownloadAt: string | null;
  otherLodgesCursor: string | null;
}

const DEFAULTS: ServerNzSettingsValues = {
  baseUrl: null,
  otherLodgesEnabled: false,
  otherLodgesLastUploadAt: null,
  otherLodgesLastDownloadAt: null,
  otherLodgesCursor: null,
};

/**
 * Read the ServerNZ settings with safe defaults. A missing row or query failure
 * falls back to defaults so the setup page keeps rendering.
 */
export async function loadServerNzSettings(): Promise<ServerNzSettingsValues> {
  try {
    const row = await prisma.serverNzSettings.findUnique({
      where: { id: SERVERNZ_SETTINGS_ID },
    });
    if (!row) return { ...DEFAULTS };
    return {
      baseUrl: row.baseUrl,
      otherLodgesEnabled: row.otherLodgesEnabled,
      otherLodgesLastUploadAt: row.otherLodgesLastUploadAt?.toISOString() ?? null,
      otherLodgesLastDownloadAt:
        row.otherLodgesLastDownloadAt?.toISOString() ?? null,
      otherLodgesCursor: row.otherLodgesCursor,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Normalise a base URL: trim, drop a trailing slash, or null when blank. */
export function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Hosts a sync destination may never resolve to.
 *
 * This is the FIRST request-input-driven outbound fetch in the codebase — every
 * other provider (Xero, Stripe, Google, Anthropic) pins its endpoint in code —
 * so it is also the first place an admin-supplied string decides where a
 * credential is sent. `docs/SECURITY-ATTACK-SURFACE.md` argues `/api/deploy/warmup`
 * is safe precisely BECAUSE no request input reaches it; this endpoint cannot
 * make that argument and needs a real allowlist instead.
 *
 * Literal-form only, deliberately. A DNS name that RESOLVES to a private address
 * is not caught here and cannot be without resolving at request time and pinning
 * the answer (a TOCTOU fix of its own). What this does close is the direct,
 * typed-in case — cloud metadata at 169.254.169.254, `localhost`, and RFC1918
 * space — which is the shape an admin-supplied field actually takes.
 */
function isBlockedSyncHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // `.local` (mDNS) and `.internal` (common private zone, incl. GCP metadata).
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // IPv6 loopback / unspecified, and IPv4-mapped forms of the same.
  if (host === "::1" || host === "::" || host.startsWith("::ffff:")) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    // Fail CLOSED, not open: the 4-group match guarantees both octets are
    // present, but this function gates an outbound SSRF surface, so an
    // unreachable gap here must read as "blocked", never as "not blocked".
    if (a === undefined || b === undefined) return true;
    if ([a, b].some((n) => Number.isNaN(n) || n > 255)) return true;
    if (a === 127 || a === 0 || a === 10) return true; // loopback, "this host", RFC1918
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
    if (a >= 224) return true; // multicast and reserved
  }
  return false;
}

export interface BaseUrlValidation {
  ok: boolean;
  /** Present when `ok`; the normalised origin-and-path to store. */
  value?: string;
  /** Present when not `ok`; safe to show an admin. */
  reason?: string;
}

/**
 * Validate an operator-supplied central-server base URL.
 *
 * `https` is REQUIRED rather than preferred: `servernz-api.ts` sends the stored
 * API key as `Authorization: Bearer`, so permitting `http://` would put a
 * long-lived credential on the wire in cleartext on every sync.
 */
export function validateCentralServerBaseUrl(value: string): BaseUrlValidation {
  const trimmed = normalizeBaseUrl(value);
  if (!trimmed) return { ok: false, reason: "Enter the central server's base URL." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason:
        "The base URL must start with https:// — the API key is sent to it as a bearer token, so an http:// address would put it on the wire in cleartext.",
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Remove the username or password from the URL." };
  }
  if (isBlockedSyncHost(parsed.hostname)) {
    return {
      ok: false,
      reason:
        "That address is a private, loopback or link-local host. The central server must be a public address.",
    };
  }
  return { ok: true, value: normalizeBaseUrl(parsed.toString()) ?? trimmed };
}

/** Update the connection settings (base URL and/or the per-item enable flag). */
export async function updateServerNzSettings(input: {
  baseUrl?: string | null;
  otherLodgesEnabled?: boolean;
  updatedByMemberId: string;
}): Promise<ServerNzSettingsValues> {
  const data: {
    baseUrl?: string | null;
    otherLodgesEnabled?: boolean;
    updatedByMemberId: string;
  } = { updatedByMemberId: input.updatedByMemberId };
  if (input.baseUrl !== undefined) data.baseUrl = normalizeBaseUrl(input.baseUrl);
  if (input.otherLodgesEnabled !== undefined)
    data.otherLodgesEnabled = input.otherLodgesEnabled;

  await prisma.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: { id: SERVERNZ_SETTINGS_ID, ...data },
    update: data,
  });
  return loadServerNzSettings();
}

/**
 * Record a successful upload of the Other Clubs registry.
 *
 * `otherLodgesLastUploadAt` doubles as the incremental-upload watermark: the
 * next upload only sends local rows whose `updatedAt` is newer than this. Pass
 * the newest `updatedAt` among the rows just uploaded so the watermark advances
 * on the same clock as the rows themselves (both DB-generated). Falls back to
 * `now()` when no explicit watermark is given.
 */
export async function recordOtherLodgesUpload(at: Date = new Date()): Promise<void> {
  await prisma.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: {
      id: SERVERNZ_SETTINGS_ID,
      otherLodgesLastUploadAt: at,
    },
    update: { otherLodgesLastUploadAt: at },
  });
}

/** Record a successful download, persisting the incremental cursor. */
export async function recordOtherLodgesDownload(cursor: string | null): Promise<void> {
  await prisma.serverNzSettings.upsert({
    where: { id: SERVERNZ_SETTINGS_ID },
    create: {
      id: SERVERNZ_SETTINGS_ID,
      otherLodgesLastDownloadAt: new Date(),
      otherLodgesCursor: cursor,
    },
    update: {
      otherLodgesLastDownloadAt: new Date(),
      ...(cursor ? { otherLodgesCursor: cursor } : {}),
    },
  });
}
