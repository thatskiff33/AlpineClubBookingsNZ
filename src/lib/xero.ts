/**
 * Xero Integration Library
 *
 * Handles OAuth2 flow, token management, invoice creation, credit notes,
 * contact sync, and membership subscription verification.
 */

import { XeroClient, Contact, ContactGroup, Invoice, LineItem, LineAmountTypes, CreditNote, Payment as XeroPayment, Phone, Address } from "xero-node";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { prisma } from "./prisma";
import { sendPasswordResetEmail } from "./email";
import { AgeTier, CreditType, EntranceFeeCategory, Prisma } from "@prisma/client";
import { getSeasonYear, getStayNights } from "./pricing";
import { formatXeroPhone } from "./phone";
import logger from "@/lib/logger";
import { recordXeroApiUsage, type XeroRateLimitCategory } from "@/lib/xero-api-usage";
import { getXeroErrorHeader, getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import {
  getOperationalXeroConfig,
  getOperationalXeroEncryptionKey,
} from "@/lib/xero-config";
import { buildXeroContactUrl, buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";

// ---------------------------------------------------------------------------
// Rate limit error
// ---------------------------------------------------------------------------

export class XeroDailyLimitError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(
      `Xero daily API limit reached. Retry after ${retryAfterSec} seconds (~${Math.round(retryAfterSec / 3600)} hours). Please try again tomorrow.`
    );
    this.name = "XeroDailyLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

export class XeroContactValidationError extends Error {
  missingFields: string[];

  constructor(missingFields: string[]) {
    super(
      `Member is missing required fields for Xero contact creation: ${missingFields.join(", ")}`
    );
    this.name = "XeroContactValidationError";
    this.missingFields = missingFields;
  }
}

export interface FindOrCreateXeroContactOptions {
  createdByMemberId?: string;
  repairExistingLink?: boolean;
}

export interface EntranceFeeContext {
  category: EntranceFeeCategory;
  feeMapping: {
    itemCode: string | null;
    amountCents: number | null;
  };
}

export interface CreateXeroEntranceFeeInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
  precomputedEntranceFee?: EntranceFeeContext;
}

export interface CreateXeroBookingInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface CreateXeroRefundCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface CreateXeroSupplementaryInvoiceOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface CreateXeroModificationCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface CreateXeroUnappliedCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const MEMBERSHIP_SYNC_CURSOR_RESOURCE = "MEMBERSHIP_INVOICE_SYNC";
const CONTACT_SYNC_CURSOR_RESOURCE = "CONTACT_SYNC";
const CONTACT_GROUP_CACHE_CURSOR_RESOURCE = "CONTACT_GROUP_CACHE";
const DEFAULT_XERO_SYNC_SCOPE = "default";
const CONTACT_SYNC_CURSOR_OVERLAP_MS = 2 * 60 * 1000;
const MEMBERSHIP_CURSOR_OVERLAP_MS = 2 * 60 * 1000;
const MEMBERSHIP_SYNC_THROTTLE_MS = 1200;
const XERO_PAGE_SIZE = 100;
const XERO_CONTACT_ID_BATCH_SIZE = 50;

// Xero tokens expire after 30 minutes; refresh 10 minutes early
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes — buffer for long-running bulk ops (contact sync, membership refresh)

// Cache the daily-limit cooldown in-process so we stop hammering Xero until Retry-After expires.
let xeroDailyLimitUntilMs = 0;

interface XeroSyncCursorMetadata {
  retryMemberIds?: string[];
  retryContactIds?: string[];
  changedInvoiceCount?: number;
  changedContactCount?: number;
  affectedMemberCount?: number;
  groupCount?: number;
  membershipCount?: number;
  windowStart?: string;
  windowEnd?: string;
}

interface SyncContactsFromXeroOptions {
  fullResync?: boolean;
  backfillJoinedDates?: boolean;
}

interface ImportMembersFromXeroGroupsOptions {
  allowLiveXeroFetch?: boolean;
}

export interface CachedXeroContact {
  contactId: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  emailAddress: string | null;
  companyNumber: string | null;
  contactStatus: string;
  phoneCountryCode: string | null;
  phoneAreaCode: string | null;
  phoneNumber: string | null;
  streetAddressLine1: string | null;
  streetAddressLine2: string | null;
  streetCity: string | null;
  streetRegion: string | null;
  streetPostalCode: string | null;
  streetCountry: string | null;
  postalAddressLine1: string | null;
  postalAddressLine2: string | null;
  postalCity: string | null;
  postalRegion: string | null;
  postalPostalCode: string | null;
  postalCountry: string | null;
}

export interface RefreshXeroContactGroupMembershipCacheForContactResult {
  contactId: string | null;
  observed: boolean;
  contactGroupsSeen: number;
  membershipsAdded: number;
  membershipsRemoved: number;
  groupsTouched: number;
  reason?: string;
}

export interface RefreshXeroContactCachesFromContactResult {
  cachedContact: CachedXeroContact | null;
  groupMemberships: RefreshXeroContactGroupMembershipCacheForContactResult;
}

interface CheckMembershipStatusOptions {
  changedInvoiceIds?: Set<string>;
  forceRefreshOnlineInvoiceUrl?: boolean;
}

interface RefreshedXeroContactGroup {
  id: string;
  name: string;
  contactCount: number;
  contacts: Array<{ id: string; name: string | null }>;
}

function toPrismaJson(
  value: XeroSyncCursorMetadata | undefined
): Prisma.InputJsonValue | undefined {
  return value as Prisma.InputJsonValue | undefined;
}

// ---------------------------------------------------------------------------
// Encryption helpers (for token storage at rest)
// ---------------------------------------------------------------------------

function getEncryptionKey(): Buffer {
  const key = getOperationalXeroEncryptionKey();
  if (!key) {
    throw new Error("XERO_ENCRYPTION_KEY environment variable is required (32-byte hex string)");
  }
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error("XERO_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return buf;
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptToken(encrypted: string): string {
  const key = getEncryptionKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }
  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const ciphertext = parts[2];
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ---------------------------------------------------------------------------
// Xero Client setup
// ---------------------------------------------------------------------------

export function createXeroClient(state?: string): XeroClient {
  return new XeroClient({
    ...getOperationalXeroConfig(),
    ...(state ? { state } : {}),
  });
}

/**
 * Build the Xero OAuth2 consent URL for admin to connect.
 */
export async function getXeroConsentUrl(state?: string): Promise<string> {
  const xero = createXeroClient(state);
  await xero.initialize();
  return xero.buildConsentUrl();
}

/**
 * Handle the OAuth2 callback from Xero.
 * Exchanges the authorization code for tokens and stores them encrypted.
 */
export async function handleXeroCallback(url: string, state?: string): Promise<void> {
  const xero = createXeroClient(state);
  await xero.initialize();
  const tokenSet = await xero.apiCallback(url);
  await xero.updateTenants();

  const tenants = xero.tenants;
  const tenantId = tenants.length > 0 ? tenants[0].tenantId : null;

  await saveXeroTokens({
    accessToken: tokenSet.access_token!,
    refreshToken: tokenSet.refresh_token!,
    expiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
    tenantId: tenantId ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Token persistence (encrypted at rest)
// ---------------------------------------------------------------------------

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId?: string;
}

async function saveXeroTokens(tokens: TokenData): Promise<void> {
  const encryptedAccess = encryptToken(tokens.accessToken);
  const encryptedRefresh = encryptToken(tokens.refreshToken);

  // Atomic upsert via transaction to prevent concurrent token refresh race conditions.
  // Two concurrent refreshes could both read the same row and overwrite each other.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.xeroToken.findFirst();
    if (existing) {
      await tx.xeroToken.update({
        where: { id: existing.id },
        data: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiresAt: tokens.expiresAt,
          tenantId: tokens.tenantId ?? existing.tenantId,
        },
      });
    } else {
      await tx.xeroToken.create({
        data: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiresAt: tokens.expiresAt,
          tenantId: tokens.tenantId ?? null,
        },
      });
    }
  });
}

async function loadXeroTokens(): Promise<(TokenData & { id: string }) | null> {
  const record = await prisma.xeroToken.findFirst();
  if (!record) return null;

  return {
    id: record.id,
    accessToken: decryptToken(record.accessToken),
    refreshToken: decryptToken(record.refreshToken),
    expiresAt: record.expiresAt,
    tenantId: record.tenantId ?? undefined,
  };
}

/**
 * Check if Xero is currently connected (tokens exist and tenant is set).
 */
export async function isXeroConnected(): Promise<boolean> {
  const record = await prisma.xeroToken.findFirst();
  return record !== null && record.tenantId !== null;
}

// ---------------------------------------------------------------------------
// Account Mapping (XAM-05)
// ---------------------------------------------------------------------------

/** Default fallbacks if no DB record exists or code is null */
const ACCOUNT_MAPPING_DEFAULTS: Record<string, string | null> = {
  hutFeesIncome: "200",
  hutFeeRefunds: "200",
  stripeBankAccount: "606",
  stripeFees: null,
  subscriptionIncome: "203",
};

type ResolvedAccountMapping = {
  code: string | null;
  itemCode: string | null;
  codeExplicitlyConfigured: boolean;
};

async function getResolvedAccountMapping(key: string): Promise<ResolvedAccountMapping> {
  try {
    const mapping = await prisma.xeroAccountMapping.findUnique({
      where: { key },
      select: { code: true, itemCode: true },
    });
    return {
      code: mapping?.code ?? ACCOUNT_MAPPING_DEFAULTS[key] ?? null,
      itemCode: mapping?.itemCode ?? null,
      codeExplicitlyConfigured: mapping?.code != null,
    };
  } catch {
    return {
      code: ACCOUNT_MAPPING_DEFAULTS[key] ?? null,
      itemCode: null,
      codeExplicitlyConfigured: false,
    };
  }
}

/**
 * Read a Xero account code from the DB, falling back to the hard-coded default.
 * Returns null for unconfigured optional mappings (e.g. stripeFees).
 */
export async function getAccountMapping(key: string): Promise<string | null> {
  const mapping = await getResolvedAccountMapping(key);
  return mapping.code;
}

/**
 * Get the Xero Item Code for a given mapping key.
 * Returns null if not configured.
 */
export async function getItemCodeMapping(key: string): Promise<string | null> {
  const mapping = await getResolvedAccountMapping(key);
  return mapping.itemCode;
}

// ---------------------------------------------------------------------------
// Granular Item Code Mappings (per age tier / season / member status)
// ---------------------------------------------------------------------------

/**
 * Build a lookup map for hut fee item codes keyed by "${ageTier}_${seasonType}_${isMember}".
 * Falls back to the legacy flat `hutFeeItem` from XeroAccountMapping if the new table is empty.
 */
export async function getHutFeeItemCodeMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  const rows = await prisma.xeroItemCodeMapping.findMany({
    where: { category: "HUT_FEE" },
  });

  for (const row of rows) {
    if (row.ageTier && row.seasonType && row.isMember !== null && row.itemCode) {
      map.set(`${row.ageTier}_${row.seasonType}_${row.isMember}`, row.itemCode);
    }
  }

  if (map.size === 0) {
    // Fallback: use legacy flat hutFeeItem for all combinations
    const legacyItemCode = await getItemCodeMapping("hutFeeItem");
    if (legacyItemCode) {
      for (const tier of ["INFANT", "CHILD", "YOUTH", "ADULT"]) {
        for (const season of ["WINTER", "SUMMER"]) {
          for (const member of [true, false]) {
            map.set(`${tier}_${season}_${member}`, legacyItemCode);
          }
        }
      }
    }
  }

  return map;
}

/**
 * Get the entrance fee item code and amount for a specific category.
 * Falls back to the legacy flat entranceFeeItem/entranceFeeAmountCents if the new table is empty.
 */
export async function getEntranceFeeMapping(
  category: EntranceFeeCategory
): Promise<{ itemCode: string | null; amountCents: number | null }> {
  const row = await prisma.xeroItemCodeMapping.findFirst({
    where: { category: "ENTRANCE_FEE", entranceFeeCategory: category },
  });

  if (row) {
    return { itemCode: row.itemCode, amountCents: row.amountCents };
  }

  // Fallback to legacy flat mappings
  const [legacyItemCode, legacyAmount] = await Promise.all([
    getItemCodeMapping("entranceFeeItem"),
    prisma.xeroAccountMapping.findUnique({
      where: { key: "entranceFeeAmountCents" },
      select: { code: true },
    }),
  ]);

  const amountCents = legacyAmount?.code ? parseInt(legacyAmount.code, 10) : null;
  return {
    itemCode: legacyItemCode,
    amountCents: isNaN(amountCents as number) ? null : amountCents,
  };
}

/**
 * Determine the entrance fee category for a member based on their age tier
 * and family group membership.
 *
 * - FAMILY: adult in a family group that has ≥2 adults AND ≥1 child/youth/infant
 * - ADULT: adult member (standalone or no qualifying family group)
 * - YOUTH: youth-tier member
 * - CHILD: child or infant-tier member
 */
export async function determineEntranceFeeCategory(
  memberId: string
): Promise<EntranceFeeCategory> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { ageTier: true },
  });

  if (!member) return "ADULT";

  if (member.ageTier === "YOUTH") return "YOUTH";
  if (member.ageTier === "CHILD" || member.ageTier === "INFANT") return "CHILD";

  // ADULT tier — check if they qualify for FAMILY rate
  const familyMemberships = await prisma.familyGroupMember.findMany({
    where: { memberId },
    select: { familyGroupId: true },
  });

  for (const fm of familyMemberships) {
    const groupMembers = await prisma.familyGroupMember.findMany({
      where: { familyGroupId: fm.familyGroupId },
      include: { member: { select: { ageTier: true } } },
    });

    const adults = groupMembers.filter((gm) =>
      gm.member.ageTier === "ADULT"
    );
    const dependents = groupMembers.filter((gm) =>
      gm.member.ageTier === "CHILD" || gm.member.ageTier === "YOUTH" || gm.member.ageTier === "INFANT"
    );

    if (adults.length >= 2 && dependents.length >= 1) {
      return "FAMILY";
    }
  }

  return "ADULT";
}

export async function getEntranceFeeContext(
  memberId: string
): Promise<EntranceFeeContext> {
  const category = await determineEntranceFeeCategory(memberId);
  const feeMapping = await getEntranceFeeMapping(category);

  return { category, feeMapping };
}

export function buildEntranceFeeInvoiceIdempotencyKey(
  memberId: string,
  category: EntranceFeeCategory,
  amountCents: number
) {
  return buildXeroIdempotencyKey(
    "member",
    memberId,
    "entrance-fee-invoice",
    category,
    amountCents,
    "v1"
  );
}

/**
 * Get connection status details for the admin page.
 */
export async function getXeroConnectionStatus(): Promise<{
  connected: boolean;
  tenantId: string | null;
  tokenExpiresAt: Date | null;
}> {
  const record = await prisma.xeroToken.findFirst();
  if (!record) {
    return { connected: false, tenantId: null, tokenExpiresAt: null };
  }
  return {
    connected: true,
    tenantId: record.tenantId,
    tokenExpiresAt: record.expiresAt,
  };
}

/**
 * Disconnect Xero by removing stored tokens.
 */
export async function disconnectXero(): Promise<void> {
  const tokens = await loadXeroTokens();
  if (tokens) {
    try {
      const xero = createXeroClient();
      await xero.initialize();
      xero.setTokenSet({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
      });
      await xero.revokeToken();
    } catch {
      // Best-effort revocation; continue with local cleanup
    }
  }
  await prisma.xeroToken.deleteMany();
}

// ---------------------------------------------------------------------------
// Authenticated Xero client (with auto-refresh)
// ---------------------------------------------------------------------------

// Simple mutex to prevent concurrent token refreshes from using the same refresh token
let _tokenRefreshPromise: Promise<{ xero: XeroClient; tenantId: string }> | null = null;

/**
 * Get an authenticated XeroClient with valid tokens.
 * Automatically refreshes if token is about to expire.
 */
export async function getAuthenticatedXeroClient(): Promise<{
  xero: XeroClient;
  tenantId: string;
}> {
  throwIfXeroDailyLimitActive();

  const tokens = await loadXeroTokens();
  if (!tokens) {
    throw new Error("Xero is not connected. Please connect via admin panel.");
  }
  if (!tokens.tenantId) {
    throw new Error("Xero tenant ID not found. Please reconnect Xero.");
  }

  const xero = createXeroClient();
  await xero.initialize();

  // Check if token needs refresh
  const now = Date.now();
  const expiresAt = tokens.expiresAt.getTime();

  if (now >= expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    // Mutex: if a refresh is already in progress, wait for it instead of double-refreshing
    if (_tokenRefreshPromise) {
      return _tokenRefreshPromise;
    }
    // Token expired or about to expire - refresh it (wrapped in mutex)
    const refreshWork = (async () => {
      xero.setTokenSet({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
      });
      const config = getXeroConfig();
      try {
        const newTokenSet = await xero.refreshWithRefreshToken(
          config.clientId,
          config.clientSecret,
          tokens.refreshToken
        );

        await saveXeroTokens({
          accessToken: newTokenSet.access_token!,
          refreshToken: newTokenSet.refresh_token!,
          expiresAt: new Date(Date.now() + (newTokenSet.expires_in ?? 1800) * 1000),
          tenantId: tokens.tenantId,
        });

        return { xero, tenantId: tokens.tenantId! };
      } catch (err) {
        logger.error({ err }, "Xero token refresh failed");
        import("./xero-error-alert").then(({ notifyXeroSyncError }) =>
          notifyXeroSyncError({
            errorType: "Token Refresh Failure",
            operation: "getAuthenticatedXeroClient",
            errorMessage: err instanceof Error ? err.message : String(err),
          })
        ).catch(() => {});
        throw new Error("Xero token refresh failed. Please reconnect Xero via the admin panel.");
      } finally {
        _tokenRefreshPromise = null;
      }
    })();
    _tokenRefreshPromise = refreshWork;
    return refreshWork;
  }

  // Token still valid
  xero.setTokenSet({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
  });

  return { xero, tenantId: tokens.tenantId };
}

// ---------------------------------------------------------------------------
// Contact management
// ---------------------------------------------------------------------------

/**
 * Find or create a Xero Contact for a member.
 * Updates the member's xeroContactId if a new contact is created.
 */
export async function findOrCreateXeroContact(
  memberId: string,
  options?: FindOrCreateXeroContactOptions
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    // Advisory lock prevents concurrent duplicate creation for same member
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;

    const member = await tx.member.findUnique({
      where: { id: memberId },
    });
    if (!member) throw new Error(`Member not found: ${memberId}`);

    // Trust the persisted contact link on steady-state write paths and avoid
    // a read-before-write. Retry/repair paths can opt in to relinking.
    if (member.xeroContactId && !options?.repairExistingLink) {
      await upsertXeroObjectLink({
        localModel: "Member",
        localId: memberId,
        xeroObjectType: "CONTACT",
        xeroObjectId: member.xeroContactId,
        xeroObjectUrl: buildXeroContactUrl(member.xeroContactId),
        role: "CONTACT",
      });
      return member.xeroContactId;
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const previousXeroContactId = member.xeroContactId;

    // Search by email first.
    // Email quotes are stripped to keep the OData filter syntactically valid;
    // z.string().email() at the API boundary ensures only RFC-valid emails
    // reach this point, so no further escaping is needed.
    try {
      const contactsResponse = await callXeroApi(
        () =>
          xero.accountingApi.getContacts(
            tenantId,
            undefined, // ifModifiedSince
            `EmailAddress="${member.email.replace(/"/g, "")}"` // where clause
          ),
        {
          operation: "getContacts",
          resourceType: "CONTACT",
          workflow: "findOrCreateXeroContact",
          context: `findOrCreateXeroContact searchByEmail(${member.email})`,
        }
      );
      const contacts = contactsResponse.body.contacts;
      if (contacts && contacts.length > 0) {
        const contactId = contacts[0].contactID!;
        await tx.member.update({
          where: { id: memberId },
          data: { xeroContactId: contactId },
        });
        await upsertXeroObjectLink({
          localModel: "Member",
          localId: memberId,
          xeroObjectType: "CONTACT",
          xeroObjectId: contactId,
          xeroObjectUrl: buildXeroContactUrl(contactId),
          role: "CONTACT",
          metadata: {
            linkedVia: options?.repairExistingLink ? "email_match_repair" : "email_match",
            repairedFromXeroContactId:
              options?.repairExistingLink && previousXeroContactId !== contactId
                ? previousXeroContactId
                : undefined,
          },
        });
        return contactId;
      }
    } catch (searchErr) {
      // Rate-limit errors must propagate — swallowing them would cause a new
      // contact to be created and waste the daily quota further.
      if (searchErr instanceof XeroDailyLimitError) throw searchErr;
      // Any other error (network timeout, transient 5xx) is logged and we
      // fall through to contact creation. This is intentional: a failed
      // search is recoverable, whereas failing to create the invoice is not.
      logger.warn(
        { err: searchErr, memberId, email: member.email },
        "Xero email search failed; falling through to contact creation"
      );
    }

    // Create new contact
    const contact: Contact = {
      name: `${member.firstName} ${member.lastName}`,
      firstName: member.firstName,
      lastName: member.lastName,
      emailAddress: member.email,
      companyNumber: formatDateOfBirthForXero(member.dateOfBirth),
      phones: member.phoneNumber
        ? [{ phoneType: Phone.PhoneTypeEnum.MOBILE, phoneCountryCode: member.phoneCountryCode || "", phoneAreaCode: member.phoneAreaCode || "", phoneNumber: member.phoneNumber }]
        : [],
      addresses: buildXeroAddresses(member),
    };

    const idempotencyKey = buildXeroIdempotencyKey(
      "member",
      memberId,
      "contact",
      "find-or-create",
      "v1"
    );
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "CREATE",
      localModel: "Member",
      localId: memberId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload: { contacts: [contact] },
      createdByMemberId: options?.createdByMemberId ?? null,
    });

    try {
      const response = await callXeroApi(
        () =>
          xero.accountingApi.createContacts(
            tenantId,
            { contacts: [contact] },
            undefined,
            idempotencyKey
          ),
        {
          operation: "createContacts",
          resourceType: "CONTACT",
          workflow: "findOrCreateXeroContact",
          context: `createContacts(findOrCreate ${memberId})`,
        }
      );
      const createdContact = response.body.contacts?.[0];
      if (!createdContact?.contactID) {
        throw new Error("Failed to create Xero contact");
      }

      await tx.member.update({
        where: { id: memberId },
        data: { xeroContactId: createdContact.contactID },
      });

      await completeXeroSyncOperation(operation.id, {
        responsePayload: response.body,
        xeroObjectType: "CONTACT",
        xeroObjectId: createdContact.contactID,
        xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
        extraLinks: [
          {
            localModel: "Member",
            localId: memberId,
            xeroObjectType: "CONTACT",
            xeroObjectId: createdContact.contactID,
            xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
            role: "CONTACT",
          },
        ],
      });

      return createdContact.contactID;
    } catch (error) {
      await failXeroSyncOperation(operation.id, error);
      throw error;
    }
  });
}

/**
 * Create a brand-new Xero contact for a member and link it locally.
 * Unlike findOrCreateXeroContact, this does not try to match existing contacts by email.
 */
export async function createXeroContactForMember(
  memberId: string,
  options?: { createdByMemberId?: string }
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;

    const member = await tx.member.findUnique({ where: { id: memberId } });
    if (!member) throw new Error(`Member not found: ${memberId}`);

    const missingFields = getMissingFieldsForXeroContactCreate(member);
    if (missingFields.length > 0) {
      throw new XeroContactValidationError(missingFields);
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();

    const contact: Contact = {
      name: `${member.firstName} ${member.lastName}`,
      firstName: member.firstName,
      lastName: member.lastName,
      emailAddress: member.email,
      companyNumber: formatDateOfBirthForXero(member.dateOfBirth),
      phones: [
        {
          phoneType: Phone.PhoneTypeEnum.MOBILE,
          phoneCountryCode: member.phoneCountryCode || "",
          phoneAreaCode: member.phoneAreaCode || "",
          phoneNumber: member.phoneNumber || "",
        },
      ],
      addresses: buildXeroAddresses(member),
    };

    const idempotencyKey = buildXeroIdempotencyKey(
      "member",
      memberId,
      "contact",
      "create",
      "v1"
    );
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "CREATE",
      localModel: "Member",
      localId: memberId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload: { contacts: [contact] },
      createdByMemberId: options?.createdByMemberId ?? null,
    });

    try {
      const response = await callXeroApi(
        () =>
          xero.accountingApi.createContacts(
            tenantId,
            { contacts: [contact] },
            undefined,
            idempotencyKey
          ),
        {
          operation: "createContacts",
          resourceType: "CONTACT",
          workflow: "createXeroContactForMember",
          context: `createContacts(member ${memberId})`,
        }
      );
      const createdContact = response.body.contacts?.[0];
      if (!createdContact?.contactID) {
        throw new Error("Failed to create Xero contact");
      }

      await tx.member.update({
        where: { id: memberId },
        data: { xeroContactId: createdContact.contactID },
      });

      await completeXeroSyncOperation(operation.id, {
        responsePayload: response.body,
        xeroObjectType: "CONTACT",
        xeroObjectId: createdContact.contactID,
        xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
        extraLinks: [
          {
            localModel: "Member",
            localId: memberId,
            xeroObjectType: "CONTACT",
            xeroObjectId: createdContact.contactID,
            xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
            role: "CONTACT",
          },
        ],
      });

      return createdContact.contactID;
    } catch (error) {
      await failXeroSyncOperation(operation.id, error);
      throw error;
    }
  });
}

/**
 * Fetch the earliest invoice date for a Xero contact.
 * Used to determine when a member first joined (their first invoice = membership start).
 */
async function getContactFirstInvoiceDate(
  xero: XeroClient,
  tenantId: string,
  contactID: string
): Promise<Date | null> {
  try {
    const response = await callXeroApi(
      () => xero.accountingApi.getInvoices(
        tenantId,
        undefined, // ifModifiedSince
        undefined, // where
        "Date ASC", // order - earliest first
        undefined, // iDs
        undefined, // invoiceNumbers
        [contactID], // contactIDs
        undefined, // statuses
        1, // page
        false, // includeArchived
        false, // createdByMyApp
        undefined, // unitdp
        false // summaryOnly
      ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "getContactFirstInvoiceDate",
        context: `getContactFirstInvoiceDate(${contactID})`,
      }
    );
    const invoices = response.body.invoices ?? [];
    if (invoices.length > 0 && invoices[0].date) {
      return new Date(invoices[0].date);
    }
    return null;
  } catch (err) {
    // Let daily limit errors propagate so callers can abort
    if (err instanceof XeroDailyLimitError) throw err;
    logger.warn({ err, contactID }, "Failed to fetch first invoice date from Xero");
    return null;
  }
}

/** Throttle helper: wait ms milliseconds */
function throttle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRemainingXeroDailyLimitSeconds(): number {
  const remainingMs = xeroDailyLimitUntilMs - Date.now();
  if (remainingMs <= 0) {
    xeroDailyLimitUntilMs = 0;
    return 0;
  }
  return Math.ceil(remainingMs / 1000);
}

function throwIfXeroDailyLimitActive(): void {
  const remainingSec = getRemainingXeroDailyLimitSeconds();
  if (remainingSec > 0) {
    throw new XeroDailyLimitError(remainingSec);
  }
}

function rememberXeroDailyLimit(retryAfterSec: number): void {
  const clampedRetryAfterSec = Math.max(0, retryAfterSec);
  const nextLimitUntilMs = Date.now() + clampedRetryAfterSec * 1000;

  if (nextLimitUntilMs > xeroDailyLimitUntilMs) {
    xeroDailyLimitUntilMs = nextLimitUntilMs;
    logger.warn(
      {
        retryAfterSec: clampedRetryAfterSec,
        availableAt: new Date(nextLimitUntilMs).toISOString(),
      },
      "Xero daily API limit reached, suppressing further Xero calls until cooldown expires"
    );
  }
}

export function resetXeroRateLimitStateForTests(): void {
  xeroDailyLimitUntilMs = 0;
}

interface XeroRetryRateLimitEvent {
  attempt: number;
  retryAfterSec: number;
  rateLimitCategory: XeroRateLimitCategory;
}

interface XeroRetryOptions {
  maxRetries?: number;
  maxWaitSec?: number;
  context?: string;
  onRateLimit?: (event: XeroRetryRateLimitEvent) => void;
}

export interface MeteredXeroCallOptions extends XeroRetryOptions {
  operation: string;
  resourceType: string;
  workflow?: string;
}

function getObservedXeroRateLimitCategory(err: unknown): XeroRateLimitCategory {
  if (err instanceof XeroDailyLimitError) {
    return "day";
  }

  if (getXeroErrorStatusCode(err) !== 429) {
    return null;
  }

  const rateLimitProblem = getXeroErrorHeader(err, "x-rate-limit-problem");
  if (rateLimitProblem === "day" || rateLimitProblem === "minute") {
    return rateLimitProblem;
  }

  return "unknown";
}

function getXeroUsageErrorMessage(err: unknown): string | null {
  if (err instanceof Error) {
    return err.message;
  }

  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }

  return err ? String(err) : null;
}

async function persistMeteredXeroApiUsage(
  options: MeteredXeroCallOptions,
  success: boolean,
  durationMs: number,
  err?: unknown,
  observedRateLimitCategory?: XeroRateLimitCategory
): Promise<void> {
  await recordXeroApiUsage({
    operation: options.operation,
    resourceType: options.resourceType,
    workflow: options.workflow ?? options.context,
    success,
    rateLimitCategory: observedRateLimitCategory ?? getObservedXeroRateLimitCategory(err),
    statusCode: err ? getXeroErrorStatusCode(err) ?? null : null,
    durationMs,
    errorMessage: getXeroUsageErrorMessage(err),
  });
}

export async function callXeroApi<T>(
  fn: () => Promise<T>,
  options: MeteredXeroCallOptions
): Promise<T> {
  const startedAt = Date.now();
  let observedRateLimitCategory: XeroRateLimitCategory = null;

  try {
    const result = await withXeroRetry(fn, {
      ...options,
      onRateLimit: (event) => {
        observedRateLimitCategory = event.rateLimitCategory;
        options.onRateLimit?.(event);
      },
    });
    await persistMeteredXeroApiUsage(
      options,
      true,
      Date.now() - startedAt,
      undefined,
      observedRateLimitCategory
    );
    return result;
  } catch (err) {
    await persistMeteredXeroApiUsage(
      options,
      false,
      Date.now() - startedAt,
      err,
      observedRateLimitCategory
    );
    throw err;
  }
}

interface XeroContactRepairOperationKeys {
  idempotencyKey?: string | null;
  correlationKey?: string | null;
}

interface RetryXeroWriteWithContactRepairOptions<T> {
  memberId: string;
  currentContactId: string;
  workflow: string;
  operationId?: string;
  repairExistingLink?: boolean;
  createdByMemberId?: string;
  buildRequestPayload: (contactId: string) => unknown;
  buildOperationKeys?: (contactId: string) => XeroContactRepairOperationKeys;
  run: (input: {
    contactId: string;
    idempotencyKey?: string | null;
  }) => Promise<T>;
  repairContactLink?: (
    memberId: string,
    options?: FindOrCreateXeroContactOptions
  ) => Promise<string>;
  persistUpdatedOperation?: (input: {
    operationId: string;
    requestPayload: unknown;
    keys?: XeroContactRepairOperationKeys;
  }) => Promise<void>;
}

function getXeroErrorSearchText(error: unknown): string {
  const values = new Set<string>();

  const addValue = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      values.add(value.toLowerCase());
    }
  };

  if (error instanceof Error) {
    addValue(error.message);
  }

  if (typeof error === "string") {
    addValue(error);
  }

  if (error && typeof error === "object") {
    const candidate = error as {
      body?: { Detail?: unknown; Message?: unknown; Title?: unknown };
      message?: unknown;
    };

    addValue(candidate.message);
    addValue(candidate.body?.Detail);
    addValue(candidate.body?.Message);
    addValue(candidate.body?.Title);

    try {
      addValue(JSON.stringify(error));
    } catch {
      // Ignore non-serializable values.
    }
  }

  return Array.from(values).join("\n");
}

export function isRetryableXeroContactReferenceError(error: unknown): boolean {
  const statusCode = getXeroErrorStatusCode(error);
  if (statusCode !== undefined && statusCode !== 400 && statusCode !== 404) {
    return false;
  }

  const text = getXeroErrorSearchText(error);
  if (!text.includes("contact")) {
    return false;
  }

  return [
    "not found",
    "does not exist",
    "invalid reference",
    "invalid_reference",
    "invalid contact",
    "not a valid contact",
    "could not be found",
  ].some((fragment) => text.includes(fragment));
}

async function persistUpdatedXeroOperationRequest(input: {
  operationId: string;
  requestPayload: unknown;
  keys?: XeroContactRepairOperationKeys;
}) {
  await prisma.xeroSyncOperation.update({
    where: { id: input.operationId },
    data: {
      requestPayload: sanitizeForJson(input.requestPayload),
      idempotencyKey: input.keys?.idempotencyKey,
      correlationKey: input.keys?.correlationKey,
    },
  });
}

export async function retryXeroWriteWithContactRepair<T>(
  options: RetryXeroWriteWithContactRepairOptions<T>
): Promise<T> {
  const initialKeys = options.buildOperationKeys?.(options.currentContactId);

  try {
    return await options.run({
      contactId: options.currentContactId,
      idempotencyKey: initialKeys?.idempotencyKey ?? null,
    });
  } catch (error) {
    if (
      options.repairExistingLink ||
      !isRetryableXeroContactReferenceError(error)
    ) {
      throw error;
    }

    const repairContactLink =
      options.repairContactLink ?? findOrCreateXeroContact;
    const repairedContactId = await repairContactLink(options.memberId, {
      createdByMemberId: options.createdByMemberId,
      repairExistingLink: true,
    });
    const repairedPayload = options.buildRequestPayload(repairedContactId);
    const repairedKeys = options.buildOperationKeys?.(repairedContactId);

    if (options.operationId) {
      const persistUpdatedOperation =
        options.persistUpdatedOperation ?? persistUpdatedXeroOperationRequest;
      await persistUpdatedOperation({
        operationId: options.operationId,
        requestPayload: repairedPayload,
        keys: repairedKeys,
      });
    }

    logger.warn(
      {
        workflow: options.workflow,
        memberId: options.memberId,
        previousContactId: options.currentContactId,
        repairedContactId,
      },
      "Retrying Xero write after repairing a stale contact link"
    );

    return options.run({
      contactId: repairedContactId,
      idempotencyKey: repairedKeys?.idempotencyKey ?? null,
    });
  }
}

/**
 * Retry wrapper for Xero API calls with 429 rate-limit handling.
 * - On daily limit: throws XeroDailyLimitError immediately (no point waiting hours).
 * - On minute/app limit: waits Retry-After seconds (capped at maxWaitSec) and retries.
 * - Non-429 errors pass through unchanged.
 */
export async function withXeroRetry<T>(
  fn: () => Promise<T>,
  options?: XeroRetryOptions
): Promise<T> {
  throwIfXeroDailyLimitActive();

  const maxRetries = options?.maxRetries ?? 3;
  const maxWaitSec = options?.maxWaitSec ?? 120;
  const context = options?.context ?? "Xero API call";

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const statusCode = getXeroErrorStatusCode(err);
      if (statusCode !== 429) throw err;

      const retryAfter = getXeroErrorHeader(err, "retry-after");
      const rateLimitProblem = getXeroErrorHeader(err, "x-rate-limit-problem");
      const parsedRetryAfterSec = parseInt(
        retryAfter || (rateLimitProblem === "day" ? "86400" : "30"),
        10
      );
      const rateLimitCategory =
        rateLimitProblem === "day" || rateLimitProblem === "minute"
          ? rateLimitProblem
          : "unknown";

      options?.onRateLimit?.({
        attempt: attempt + 1,
        retryAfterSec: parsedRetryAfterSec,
        rateLimitCategory,
      });

      // Daily limit — abort immediately, no point retrying for hours
      if (rateLimitProblem === "day") {
        const retryAfterSec = parsedRetryAfterSec;
        rememberXeroDailyLimit(retryAfterSec);
        throw new XeroDailyLimitError(retryAfterSec);
      }

      // Minute/app limit — retry if we have attempts left
      if (attempt < maxRetries) {
        const waitSec = Math.min(parsedRetryAfterSec, maxWaitSec);
        logger.warn(
          { context, attempt: attempt + 1, maxRetries, waitSec, rateLimitProblem },
          "Xero 429 rate limit hit, retrying after backoff"
        );
        await throttle(waitSec * 1000);
      }
    }
  }
  throw lastError;
}

/**
 * Bulk import contacts from Xero into the system.
 * Matches by email address and links xeroContactId.
 * Returns count of matched and linked contacts.
 */
export interface SyncReport {
  created: Array<{ name: string; email: string; xeroContactId: string; group?: string }>;
  updated: Array<{ name: string; memberId: string; xeroContactId: string; changes: string[] }>;
  skippedNoChanges: number;
  skippedNoEmail: Array<{ name: string; xeroContactId: string }>;
  skippedOther: Array<{ name: string; xeroContactId?: string; reason: string }>;
  errors: Array<{ name: string; xeroContactId?: string; error: string }>;
  total: number;
}

export async function syncContactsFromXero(
  options: SyncContactsFromXeroOptions = {}
): Promise<SyncReport> {
  const syncStartedAt = new Date();
  const cursor = options.fullResync
    ? null
    : await getXeroSyncCursor(
        CONTACT_SYNC_CURSOR_RESOURCE,
        DEFAULT_XERO_SYNC_SCOPE
      );
  const cursorMetadata = getXeroSyncCursorMetadata(cursor?.metadata);
  const ifModifiedSince =
    !options.fullResync && cursor?.cursorDateTime
      ? new Date(
          cursor.cursorDateTime.getTime() - CONTACT_SYNC_CURSOR_OVERLAP_MS
        )
      : undefined;
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const report: SyncReport = {
    created: [],
    updated: [],
    skippedNoChanges: 0,
    skippedNoEmail: [],
    skippedOther: [],
    errors: [],
    total: 0,
  };

  const changedContacts = await fetchChangedXeroContactsFromXero({
    xero,
    tenantId,
    ifModifiedSince,
  });
  const retryContactIds = options.fullResync
    ? []
    : Array.from(new Set(cursorMetadata.retryContactIds ?? []));
  const contactsById = new Map<string, Contact>();

  for (const contact of changedContacts) {
    if (contact.contactID) {
      contactsById.set(contact.contactID, contact);
    }
  }

  if (retryContactIds.length > 0) {
    const retryContacts = await fetchXeroContactsByIdsFromXero({
      xero,
      tenantId,
      contactIds: retryContactIds,
      workflow: "syncContactsFromXero",
      contextPrefix: "syncContacts retry",
    });

    for (const contact of retryContacts) {
      if (contact.contactID) {
        contactsById.set(contact.contactID, contact);
      }
    }
  }

  report.total = contactsById.size;
  const fetchedAt = new Date();
  const nextRetryContactIds: string[] = [];

  for (const contact of contactsById.values()) {
    const contactName = getXeroContactDisplayName(contact);

    if (!contact.contactID) {
      report.skippedOther.push({
        name: contactName,
        reason: "No Xero contact ID",
      });
      continue;
    }

    try {
      const { cachedContact } = await refreshXeroContactCachesFromContact(
        contact,
        fetchedAt
      );
      if (!cachedContact) {
        report.skippedOther.push({
          name: contactName,
          reason: "Failed to cache Xero contact snapshot",
        });
        continue;
      }

      const alreadyLinked = await prisma.member.findFirst({
        where: { xeroContactId: contact.contactID },
      });
      if (alreadyLinked) {
        const changes: string[] = [];
        const updateData: Record<string, unknown> = {};

        if (!alreadyLinked.joinedDate && options.backfillJoinedDates) {
          const invoiceDate = await getContactFirstInvoiceDate(
            xero,
            tenantId,
            contact.contactID
          );
          if (invoiceDate) {
            updateData.joinedDate = invoiceDate;
            changes.push(
              `Joined date set to ${invoiceDate.toISOString().split("T")[0]}`
            );
          }
          await throttle(1500);
        }

        if (!alreadyLinked.phoneNumber && cachedContact.phoneNumber) {
          updateData.phoneCountryCode = cachedContact.phoneCountryCode;
          updateData.phoneAreaCode = cachedContact.phoneAreaCode;
          updateData.phoneNumber = cachedContact.phoneNumber;
          changes.push(
            `Phone set to ${
              formatXeroPhone({
                phoneCountryCode: cachedContact.phoneCountryCode,
                phoneAreaCode: cachedContact.phoneAreaCode,
                phoneNumber: cachedContact.phoneNumber,
              }) ?? cachedContact.phoneNumber
            }`
          );
        }

        if (
          !alreadyLinked.streetAddressLine1 &&
          cachedContact.streetAddressLine1
        ) {
          updateData.streetAddressLine1 = cachedContact.streetAddressLine1;
          updateData.streetAddressLine2 = cachedContact.streetAddressLine2;
          updateData.streetCity = cachedContact.streetCity;
          updateData.streetRegion = cachedContact.streetRegion;
          updateData.streetPostalCode = cachedContact.streetPostalCode;
          updateData.streetCountry = cachedContact.streetCountry;
          changes.push("Street address set from Xero");
        }
        if (
          !alreadyLinked.postalAddressLine1 &&
          cachedContact.postalAddressLine1
        ) {
          updateData.postalAddressLine1 = cachedContact.postalAddressLine1;
          updateData.postalAddressLine2 = cachedContact.postalAddressLine2;
          updateData.postalCity = cachedContact.postalCity;
          updateData.postalRegion = cachedContact.postalRegion;
          updateData.postalPostalCode = cachedContact.postalPostalCode;
          updateData.postalCountry = cachedContact.postalCountry;
          changes.push("Postal address set from Xero");
        }

        if (Object.keys(updateData).length > 0) {
          await prisma.member.update({
            where: { id: alreadyLinked.id },
            data: updateData,
          });
          report.updated.push({
            name: `${alreadyLinked.firstName} ${alreadyLinked.lastName}`,
            memberId: alreadyLinked.id,
            xeroContactId: contact.contactID,
            changes,
          });
        } else {
          report.skippedNoChanges += 1;
        }
        continue;
      }

      if (!cachedContact.emailAddress) {
        report.skippedNoEmail.push({
          name: contactName,
          xeroContactId: contact.contactID,
        });
        continue;
      }

      const member = await prisma.member.findFirst({
        where: {
          email: cachedContact.emailAddress.toLowerCase(),
          canLogin: true,
        },
      });

      if (!member) {
        report.skippedOther.push({
          name: contactName,
          xeroContactId: contact.contactID,
          reason: "No matching member by email",
        });
        continue;
      }

      const changes: string[] = [];
      const updateData: Record<string, unknown> = {};

      if (member.xeroContactId !== contact.contactID) {
        updateData.xeroContactId = contact.contactID;
        changes.push("Linked to Xero contact");
      }

      if (!member.joinedDate && options.backfillJoinedDates) {
        const invoiceDate = await getContactFirstInvoiceDate(
          xero,
          tenantId,
          contact.contactID
        );
        if (invoiceDate) {
          updateData.joinedDate = invoiceDate;
          changes.push(
            `Joined date set to ${invoiceDate.toISOString().split("T")[0]}`
          );
        }
        await throttle(1500);
      }

      if (!member.phoneNumber && cachedContact.phoneNumber) {
        updateData.phoneCountryCode = cachedContact.phoneCountryCode;
        updateData.phoneAreaCode = cachedContact.phoneAreaCode;
        updateData.phoneNumber = cachedContact.phoneNumber;
        changes.push(
          `Phone set to ${
            formatXeroPhone({
              phoneCountryCode: cachedContact.phoneCountryCode,
              phoneAreaCode: cachedContact.phoneAreaCode,
              phoneNumber: cachedContact.phoneNumber,
            }) ?? cachedContact.phoneNumber
          }`
        );
      }

      if (!member.streetAddressLine1 && cachedContact.streetAddressLine1) {
        updateData.streetAddressLine1 = cachedContact.streetAddressLine1;
        updateData.streetAddressLine2 = cachedContact.streetAddressLine2;
        updateData.streetCity = cachedContact.streetCity;
        updateData.streetRegion = cachedContact.streetRegion;
        updateData.streetPostalCode = cachedContact.streetPostalCode;
        updateData.streetCountry = cachedContact.streetCountry;
        changes.push("Street address set from Xero");
      }
      if (!member.postalAddressLine1 && cachedContact.postalAddressLine1) {
        updateData.postalAddressLine1 = cachedContact.postalAddressLine1;
        updateData.postalAddressLine2 = cachedContact.postalAddressLine2;
        updateData.postalCity = cachedContact.postalCity;
        updateData.postalRegion = cachedContact.postalRegion;
        updateData.postalPostalCode = cachedContact.postalPostalCode;
        updateData.postalCountry = cachedContact.postalCountry;
        changes.push("Postal address set from Xero");
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.member.update({
          where: { id: member.id },
          data: updateData,
        });
        report.updated.push({
          name: `${member.firstName} ${member.lastName}`,
          memberId: member.id,
          xeroContactId: contact.contactID,
          changes,
        });
      } else {
        report.skippedNoChanges += 1;
      }
    } catch (err) {
      nextRetryContactIds.push(contact.contactID);
      report.errors.push({
        name: contactName,
        xeroContactId: contact.contactID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const completedAt = new Date();
  await upsertXeroSyncCursor({
    resourceType: CONTACT_SYNC_CURSOR_RESOURCE,
    scope: DEFAULT_XERO_SYNC_SCOPE,
    cursorDateTime: syncStartedAt,
    lastSuccessfulSyncAt: completedAt,
    metadata: {
      retryContactIds: Array.from(new Set(nextRetryContactIds)),
      changedContactCount: changedContacts.length,
      windowStart: ifModifiedSince?.toISOString(),
      windowEnd: syncStartedAt.toISOString(),
    },
  });

  return report;
}

// ---------------------------------------------------------------------------
// Contact group import (Xero -> TAC)
// ---------------------------------------------------------------------------

/**
 * Fetch all contact groups from Xero for the admin UI to display.
 */
async function getXeroSyncCursor(resourceType: string, scope: string) {
  return prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType,
        scope,
      },
    },
    select: {
      cursorDateTime: true,
      lastSuccessfulSyncAt: true,
      metadata: true,
    },
  });
}

async function upsertXeroSyncCursor(input: {
  resourceType: string;
  scope: string;
  cursorDateTime?: Date | null;
  lastSuccessfulSyncAt?: Date | null;
  metadata?: XeroSyncCursorMetadata;
}) {
  await prisma.xeroSyncCursor.upsert({
    where: {
      resourceType_scope: {
        resourceType: input.resourceType,
        scope: input.scope,
      },
    },
    create: {
      resourceType: input.resourceType,
      scope: input.scope,
      cursorDateTime: input.cursorDateTime ?? null,
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt ?? null,
      metadata: toPrismaJson(input.metadata),
    },
    update: {
      cursorDateTime: input.cursorDateTime ?? null,
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt ?? null,
      metadata: toPrismaJson(input.metadata),
    },
  });
}

function getXeroSyncCursorMetadata(
  metadata: unknown
): XeroSyncCursorMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const value = metadata as Record<string, unknown>;
  return {
    retryMemberIds: Array.isArray(value.retryMemberIds)
      ? value.retryMemberIds.filter(
          (memberId): memberId is string => typeof memberId === "string"
        )
      : [],
    retryContactIds: Array.isArray(value.retryContactIds)
      ? value.retryContactIds.filter(
          (contactId): contactId is string => typeof contactId === "string"
        )
      : [],
    changedInvoiceCount:
      typeof value.changedInvoiceCount === "number"
        ? value.changedInvoiceCount
        : undefined,
    changedContactCount:
      typeof value.changedContactCount === "number"
        ? value.changedContactCount
        : undefined,
    affectedMemberCount:
      typeof value.affectedMemberCount === "number"
        ? value.affectedMemberCount
        : undefined,
    groupCount:
      typeof value.groupCount === "number"
        ? value.groupCount
        : undefined,
    membershipCount:
      typeof value.membershipCount === "number"
        ? value.membershipCount
        : undefined,
    windowStart:
      typeof value.windowStart === "string" ? value.windowStart : undefined,
    windowEnd:
      typeof value.windowEnd === "string" ? value.windowEnd : undefined,
  };
}

async function fetchXeroContactGroupsFromXero(): Promise<
  RefreshedXeroContactGroup[]
> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getContactGroups(tenantId),
    {
      operation: "getContactGroups",
      resourceType: "CONTACT_GROUP",
      workflow: "refreshXeroContactGroupCache",
      context: "refreshXeroContactGroupCache getContactGroups",
    }
  );
  const groups = (response.body.contactGroups ?? []).filter(
    (group) =>
      group.contactGroupID &&
      group.name &&
      group.status === ContactGroup.StatusEnum.ACTIVE
  );

  const refreshedGroups: RefreshedXeroContactGroup[] = [];
  for (const group of groups) {
    const detail = await callXeroApi(
      () => xero.accountingApi.getContactGroup(tenantId, group.contactGroupID!),
      {
        operation: "getContactGroup",
        resourceType: "CONTACT_GROUP",
        workflow: "refreshXeroContactGroupCache",
        context: `refreshXeroContactGroupCache getContactGroup(${group.name})`,
      }
    );

    const contacts = (detail.body.contactGroups?.[0]?.contacts ?? [])
      .filter((contact) => contact.contactID)
      .map((contact) => ({
        id: contact.contactID!,
        name:
          contact.name ??
          [contact.firstName, contact.lastName].filter(Boolean).join(" ") ??
          null,
      }));

    refreshedGroups.push({
      id: group.contactGroupID!,
      name: group.name!,
      contactCount: contacts.length,
      contacts,
    });
  }

  refreshedGroups.sort((left, right) => left.name.localeCompare(right.name));
  return refreshedGroups;
}

export async function refreshXeroContactGroupCache(): Promise<
  Array<{ id: string; name: string; contactCount: number }>
> {
  const refreshStartedAt = new Date();
  const refreshedGroups = await fetchXeroContactGroupsFromXero();
  const refreshedAt = new Date();
  const membershipCount = refreshedGroups.reduce(
    (total, group) => total + group.contacts.length,
    0
  );

  await prisma.$transaction(async (tx) => {
    const refreshedGroupIds = refreshedGroups.map((group) => group.id);

    if (refreshedGroupIds.length > 0) {
      await tx.xeroContactGroupMembershipCache.deleteMany({
        where: { contactGroupId: { notIn: refreshedGroupIds } },
      });
      await tx.xeroContactGroupCache.deleteMany({
        where: { contactGroupId: { notIn: refreshedGroupIds } },
      });
    } else {
      await tx.xeroContactGroupMembershipCache.deleteMany({});
      await tx.xeroContactGroupCache.deleteMany({});
    }

    for (const group of refreshedGroups) {
      await tx.xeroContactGroupCache.upsert({
        where: { contactGroupId: group.id },
        create: {
          contactGroupId: group.id,
          name: group.name,
          status: "ACTIVE",
          contactCount: group.contactCount,
          fetchedAt: refreshedAt,
        },
        update: {
          name: group.name,
          status: "ACTIVE",
          contactCount: group.contactCount,
          fetchedAt: refreshedAt,
        },
      });

      await tx.xeroContactGroupMembershipCache.deleteMany({
        where: { contactGroupId: group.id },
      });

      if (group.contacts.length > 0) {
        await tx.xeroContactGroupMembershipCache.createMany({
          data: group.contacts.map((contact) => ({
            contactGroupId: group.id,
            contactId: contact.id,
            contactName: contact.name,
            fetchedAt: refreshedAt,
          })),
          skipDuplicates: true,
        });
      }
    }

    await tx.xeroSyncCursor.upsert({
      where: {
        resourceType_scope: {
          resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
          scope: DEFAULT_XERO_SYNC_SCOPE,
        },
      },
        create: {
          resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
          scope: DEFAULT_XERO_SYNC_SCOPE,
          cursorDateTime: refreshStartedAt,
          lastSuccessfulSyncAt: refreshedAt,
          metadata: toPrismaJson({
            groupCount: refreshedGroups.length,
            membershipCount,
          }),
        },
        update: {
          cursorDateTime: refreshStartedAt,
          lastSuccessfulSyncAt: refreshedAt,
          metadata: toPrismaJson({
            groupCount: refreshedGroups.length,
            membershipCount,
          }),
        },
      });
  });

  return refreshedGroups.map((group) => ({
    id: group.id,
    name: group.name,
    contactCount: group.contactCount,
  }));
}

export async function getXeroContactGroups(options?: {
  refreshFromXero?: boolean;
}): Promise<Array<{ id: string; name: string; contactCount: number }>> {
  if (options?.refreshFromXero) {
    return refreshXeroContactGroupCache();
  }

  const groups = await prisma.xeroContactGroupCache.findMany({
    where: { status: "ACTIVE" },
    orderBy: [{ name: "asc" }],
    select: {
      contactGroupId: true,
      name: true,
      contactCount: true,
    },
  });

  return groups.map((group) => ({
    id: group.contactGroupId,
    name: group.name,
    contactCount: group.contactCount,
  }));
}

export async function getXeroContactGroupMemberships(
  contactIds: string[]
): Promise<Record<string, Array<{ id: string; name: string }>>> {
  const uniqueContactIds = Array.from(new Set(contactIds));
  if (uniqueContactIds.length === 0) {
    return {};
  }

  const cursor = await getXeroSyncCursor(
    CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  if (!cursor?.lastSuccessfulSyncAt) {
    return {};
  }

  const memberships: Record<string, Array<{ id: string; name: string }>> =
    Object.fromEntries(uniqueContactIds.map((contactId) => [contactId, []]));

  const rows = await prisma.xeroContactGroupMembershipCache.findMany({
    where: {
      contactId: { in: uniqueContactIds },
      group: { is: { status: "ACTIVE" } },
    },
    select: {
      contactId: true,
      group: {
        select: {
          contactGroupId: true,
          name: true,
        },
      },
    },
  });

  for (const row of rows) {
    memberships[row.contactId].push({
      id: row.group.contactGroupId,
      name: row.group.name,
    });
  }

  for (const groups of Object.values(memberships)) {
    groups.sort((left, right) => left.name.localeCompare(right.name));
  }

  return memberships;
}

/**
 * Get all Xero contact IDs that belong to a specific contact group.
 */
export async function getXeroContactIdsForGroup(
  groupId: string
): Promise<string[]> {
  const cursor = await getXeroSyncCursor(
    CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  if (!cursor?.lastSuccessfulSyncAt) {
    return [];
  }

  const memberships = await prisma.xeroContactGroupMembershipCache.findMany({
    where: { contactGroupId: groupId },
    select: { contactId: true },
  });

  return memberships.map((membership) => membership.contactId);
}

/**
 * Find the best phone from a Xero contact's phones array and return structured fields.
 * Prefers MOBILE, falls back to any phone with a number.
 */
function getXeroContactPhoneStructured(phones?: Array<{ phoneType?: Phone.PhoneTypeEnum; phoneCountryCode?: string; phoneAreaCode?: string; phoneNumber?: string }>): { phoneCountryCode: string | null; phoneAreaCode: string | null; phoneNumber: string } | null {
  if (!phones) return null;
  const mobile = phones.find((p) => p.phoneNumber && p.phoneType === Phone.PhoneTypeEnum.MOBILE);
  const best = mobile || phones.find((p) => p.phoneNumber);
  if (!best || !best.phoneNumber) return null;
  return {
    phoneCountryCode: best.phoneCountryCode || null,
    phoneAreaCode: best.phoneAreaCode || null,
    phoneNumber: best.phoneNumber,
  };
}

/**
 * Extract structured address data from a Xero contact's addresses array.
 * Returns STREET and POBOX addresses separately.
 */
function getXeroContactAddresses(addresses?: Array<{
  addressType?: Address.AddressTypeEnum;
  addressLine1?: string; addressLine2?: string;
  city?: string; region?: string; postalCode?: string; country?: string;
}>): {
  street: { addressLine1: string | null; addressLine2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null } | null;
  postal: { addressLine1: string | null; addressLine2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null } | null;
} {
  if (!addresses) return { street: null, postal: null };

  const extract = (addr: typeof addresses[0]) => ({
    addressLine1: addr.addressLine1 || null,
    addressLine2: addr.addressLine2 || null,
    city: addr.city || null,
    region: addr.region || null,
    postalCode: addr.postalCode || null,
    country: addr.country || null,
  });

  const streetAddr = addresses.find((a) => a.addressType === Address.AddressTypeEnum.STREET && a.addressLine1);
  const postalAddr = addresses.find((a) => a.addressType === Address.AddressTypeEnum.POBOX && a.addressLine1);

  return {
    street: streetAddr ? extract(streetAddr) : null,
    postal: postalAddr ? extract(postalAddr) : null,
  };
}

/**
 * Build Xero addresses array from a member's address fields.
 */
function buildXeroAddresses(member: {
  streetAddressLine1?: string | null; streetAddressLine2?: string | null;
  streetCity?: string | null; streetRegion?: string | null;
  streetPostalCode?: string | null; streetCountry?: string | null;
  postalAddressLine1?: string | null; postalAddressLine2?: string | null;
  postalCity?: string | null; postalRegion?: string | null;
  postalPostalCode?: string | null; postalCountry?: string | null;
}): Address[] {
  const addresses: Address[] = [];
  if (member.streetAddressLine1) {
    addresses.push({
      addressType: Address.AddressTypeEnum.STREET,
      addressLine1: member.streetAddressLine1,
      addressLine2: member.streetAddressLine2 || "",
      city: member.streetCity || "",
      region: member.streetRegion || "",
      postalCode: member.streetPostalCode || "",
      country: member.streetCountry || "",
    });
  }
  if (member.postalAddressLine1) {
    addresses.push({
      addressType: Address.AddressTypeEnum.POBOX,
      addressLine1: member.postalAddressLine1,
      addressLine2: member.postalAddressLine2 || "",
      city: member.postalCity || "",
      region: member.postalRegion || "",
      postalCode: member.postalPostalCode || "",
      country: member.postalCountry || "",
    });
  }
  return addresses;
}

function formatDateOfBirthForXero(dateOfBirth?: Date | null): string | undefined {
  if (!dateOfBirth) return undefined;

  const day = String(dateOfBirth.getUTCDate()).padStart(2, "0");
  const month = String(dateOfBirth.getUTCMonth() + 1).padStart(2, "0");
  const year = dateOfBirth.getUTCFullYear();

  return `${day}/${month}/${year}`;
}

function getMissingFieldsForXeroContactCreate(member: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  streetAddressLine1?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
  dateOfBirth?: Date | null;
  joinedDate?: Date | null;
}): string[] {
  const missingFields: string[] = [];

  if (!member.firstName?.trim()) missingFields.push("First Name");
  if (!member.lastName?.trim()) missingFields.push("Last Name");
  if (!member.email?.trim()) missingFields.push("Email");
  if (
    !member.phoneCountryCode?.trim() ||
    !member.phoneAreaCode?.trim() ||
    !member.phoneNumber?.trim()
  ) {
    missingFields.push("Phone");
  }
  if (!member.dateOfBirth) missingFields.push("Date of Birth");
  if (!member.joinedDate) missingFields.push("Joined Date");
  if (
    !member.streetAddressLine1?.trim() ||
    !member.streetCity?.trim() ||
    !member.streetRegion?.trim() ||
    !member.streetPostalCode?.trim() ||
    !member.streetCountry?.trim()
  ) {
    missingFields.push("Physical Address");
  }
  if (
    !member.postalAddressLine1?.trim() ||
    !member.postalCity?.trim() ||
    !member.postalRegion?.trim() ||
    !member.postalPostalCode?.trim() ||
    !member.postalCountry?.trim()
  ) {
    missingFields.push("Postal Address");
  }

  return missingFields;
}

function getXeroContactDisplayName(contact: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  return (
    contact.name ||
    [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
    "Unknown"
  );
}

function parseXeroCompanyNumberDate(
  companyNumber?: string | null
): Date | null {
  if (!companyNumber) {
    return null;
  }

  const match = companyNumber.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return null;
  }

  const [, dd, mm, yyyy] = match;
  const parsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getXeroContactSourceUpdatedAt(contact: Contact): Date | null {
  if (!contact.updatedDateUTC) {
    return null;
  }

  const updatedAt = new Date(contact.updatedDateUTC.toString());
  return Number.isNaN(updatedAt.getTime()) ? null : updatedAt;
}

function buildCachedXeroContact(contact: Contact): CachedXeroContact | null {
  if (!contact.contactID) {
    return null;
  }

  const phone = getXeroContactPhoneStructured(contact.phones);
  const addresses = getXeroContactAddresses(contact.addresses);

  return {
    contactId: contact.contactID,
    name: contact.name ?? null,
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
    emailAddress: contact.emailAddress ?? null,
    companyNumber: contact.companyNumber ?? null,
    contactStatus: contact.contactStatus?.toString() || "ACTIVE",
    phoneCountryCode: phone?.phoneCountryCode ?? null,
    phoneAreaCode: phone?.phoneAreaCode ?? null,
    phoneNumber: phone?.phoneNumber ?? null,
    streetAddressLine1: addresses.street?.addressLine1 ?? null,
    streetAddressLine2: addresses.street?.addressLine2 ?? null,
    streetCity: addresses.street?.city ?? null,
    streetRegion: addresses.street?.region ?? null,
    streetPostalCode: addresses.street?.postalCode ?? null,
    streetCountry: addresses.street?.country ?? null,
    postalAddressLine1: addresses.postal?.addressLine1 ?? null,
    postalAddressLine2: addresses.postal?.addressLine2 ?? null,
    postalCity: addresses.postal?.city ?? null,
    postalRegion: addresses.postal?.region ?? null,
    postalPostalCode: addresses.postal?.postalCode ?? null,
    postalCountry: addresses.postal?.country ?? null,
  };
}

function extractActiveXeroContactGroups(contact: Contact) {
  if (!Array.isArray(contact.contactGroups)) {
    return null;
  }

  const groupsById = new Map<string, { id: string; name: string | null }>();

  for (const group of contact.contactGroups) {
    const groupId =
      typeof group.contactGroupID === "string" ? group.contactGroupID.trim() : "";
    if (!groupId || group.status === ContactGroup.StatusEnum.DELETED) {
      continue;
    }

    const groupName =
      typeof group.name === "string" && group.name.trim().length > 0
        ? group.name.trim()
        : null;

    groupsById.set(groupId, {
      id: groupId,
      name: groupName,
    });
  }

  return Array.from(groupsById.values());
}

export async function refreshXeroContactGroupMembershipCacheForContact(
  contact: Contact,
  fetchedAt: Date = new Date()
): Promise<RefreshXeroContactGroupMembershipCacheForContactResult> {
  if (!contact.contactID) {
    return {
      contactId: null,
      observed: false,
      contactGroupsSeen: 0,
      membershipsAdded: 0,
      membershipsRemoved: 0,
      groupsTouched: 0,
      reason: "Xero contact payload did not include a contactID.",
    };
  }

  const activeGroups = extractActiveXeroContactGroups(contact);
  if (!activeGroups) {
    return {
      contactId: contact.contactID,
      observed: false,
      contactGroupsSeen: 0,
      membershipsAdded: 0,
      membershipsRemoved: 0,
      groupsTouched: 0,
      reason: "Xero contact payload did not include contactGroups.",
    };
  }

  const contactId = contact.contactID;
  const sourceUpdatedAt = getXeroContactSourceUpdatedAt(contact) ?? fetchedAt;
  const contactName = getXeroContactDisplayName(contact) || null;

  return prisma.$transaction(async (tx) => {
    const previousMemberships = await tx.xeroContactGroupMembershipCache.findMany({
      where: {
        contactId,
      },
      select: {
        contactGroupId: true,
      },
    });
    const desiredGroupIds = activeGroups.map((group) => group.id);
    const previousGroupIds = previousMemberships.map(
      (membership) => membership.contactGroupId
    );
    const previousGroupIdSet = new Set(previousGroupIds);
    const desiredGroupIdSet = new Set(desiredGroupIds);
    const addedGroupIds = desiredGroupIds.filter(
      (groupId) => !previousGroupIdSet.has(groupId)
    );
    const removedGroupIds = previousGroupIds.filter(
      (groupId) => !desiredGroupIdSet.has(groupId)
    );
    const retainedGroupIds = desiredGroupIds.filter((groupId) =>
      previousGroupIdSet.has(groupId)
    );

    const existingGroups =
      desiredGroupIds.length > 0
        ? await tx.xeroContactGroupCache.findMany({
            where: {
              contactGroupId: {
                in: desiredGroupIds,
              },
            },
            select: {
              contactGroupId: true,
              name: true,
            },
          })
        : [];
    const existingGroupNames = new Map(
      existingGroups.map((group) => [group.contactGroupId, group.name])
    );

    for (const group of activeGroups) {
      await tx.xeroContactGroupCache.upsert({
        where: {
          contactGroupId: group.id,
        },
        create: {
          contactGroupId: group.id,
          name: group.name ?? existingGroupNames.get(group.id) ?? group.id,
          status: "ACTIVE",
          contactCount: 0,
          fetchedAt,
          sourceUpdatedAt,
        },
        update: {
          name: group.name ?? existingGroupNames.get(group.id) ?? group.id,
          status: "ACTIVE",
          fetchedAt,
          sourceUpdatedAt,
        },
      });
    }

    if (removedGroupIds.length > 0) {
      await tx.xeroContactGroupMembershipCache.deleteMany({
        where: {
          contactId,
          contactGroupId: {
            in: removedGroupIds,
          },
        },
      });

      for (const groupId of removedGroupIds) {
        await tx.xeroContactGroupCache.updateMany({
          where: {
            contactGroupId: groupId,
            contactCount: {
              gt: 0,
            },
          },
          data: {
            contactCount: {
              decrement: 1,
            },
            fetchedAt,
            sourceUpdatedAt,
          },
        });
      }
    }

    if (retainedGroupIds.length > 0) {
      await tx.xeroContactGroupMembershipCache.updateMany({
        where: {
          contactId,
          contactGroupId: {
            in: retainedGroupIds,
          },
        },
        data: {
          contactName,
          fetchedAt,
        },
      });
    }

    if (addedGroupIds.length > 0) {
      await tx.xeroContactGroupMembershipCache.createMany({
        data: activeGroups
          .filter((group) => addedGroupIds.includes(group.id))
          .map((group) => ({
            contactGroupId: group.id,
            contactId,
            contactName,
            fetchedAt,
          })),
        skipDuplicates: true,
      });

      for (const groupId of addedGroupIds) {
        await tx.xeroContactGroupCache.updateMany({
          where: {
            contactGroupId: groupId,
          },
          data: {
            contactCount: {
              increment: 1,
            },
            fetchedAt,
            sourceUpdatedAt,
          },
        });
      }
    }

    await tx.xeroSyncCursor.upsert({
      where: {
        resourceType_scope: {
          resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
          scope: DEFAULT_XERO_SYNC_SCOPE,
        },
      },
      create: {
        resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
        cursorDateTime: sourceUpdatedAt,
        lastSuccessfulSyncAt: fetchedAt,
      },
      update: {
        cursorDateTime: sourceUpdatedAt,
        lastSuccessfulSyncAt: fetchedAt,
      },
    });

    return {
      contactId,
      observed: true,
      contactGroupsSeen: activeGroups.length,
      membershipsAdded: addedGroupIds.length,
      membershipsRemoved: removedGroupIds.length,
      groupsTouched: Array.from(
        new Set([...desiredGroupIds, ...removedGroupIds])
      ).length,
    } satisfies RefreshXeroContactGroupMembershipCacheForContactResult;
  });
}

async function upsertXeroContactCacheEntry(
  contact: Contact,
  fetchedAt: Date
): Promise<CachedXeroContact | null> {
  const cachedContact = buildCachedXeroContact(contact);
  if (!cachedContact) {
    return null;
  }

  await prisma.xeroContactCache.upsert({
    where: { contactId: cachedContact.contactId },
    create: {
      ...cachedContact,
      sourceUpdatedAt: getXeroContactSourceUpdatedAt(contact),
      fetchedAt,
    },
    update: {
      ...cachedContact,
      sourceUpdatedAt: getXeroContactSourceUpdatedAt(contact),
      fetchedAt,
    },
  });

  return cachedContact;
}

export async function refreshXeroContactCachesFromContact(
  contact: Contact,
  fetchedAt: Date = new Date()
): Promise<RefreshXeroContactCachesFromContactResult> {
  const [cachedContact, groupMemberships] = await Promise.all([
    upsertXeroContactCacheEntry(contact, fetchedAt),
    refreshXeroContactGroupMembershipCacheForContact(contact, fetchedAt),
  ]);

  return {
    cachedContact,
    groupMemberships,
  };
}

async function fetchXeroContactsByIdsFromXero(input: {
  xero: XeroClient;
  tenantId: string;
  contactIds: string[];
  workflow: string;
  contextPrefix: string;
}): Promise<Contact[]> {
  const contacts: Contact[] = [];

  for (let index = 0; index < input.contactIds.length; index += XERO_CONTACT_ID_BATCH_SIZE) {
    const batch = input.contactIds.slice(index, index + XERO_CONTACT_ID_BATCH_SIZE);
    const response = await callXeroApi(
      () =>
        input.xero.accountingApi.getContacts(
          input.tenantId,
          undefined,
          undefined,
          undefined,
          batch
        ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: input.workflow,
        context: `${input.contextPrefix} getContacts(batch ${Math.floor(index / XERO_CONTACT_ID_BATCH_SIZE) + 1})`,
      }
    );

    contacts.push(...(response.body.contacts ?? []));
  }

  return contacts;
}

async function fetchChangedXeroContactsFromXero(input: {
  xero: XeroClient;
  tenantId: string;
  ifModifiedSince?: Date;
}): Promise<Contact[]> {
  const contacts: Contact[] = [];
  let page = 1;

  while (true) {
    const response = await callXeroApi(
      () =>
        input.xero.accountingApi.getContacts(
          input.tenantId,
          input.ifModifiedSince,
          undefined,
          "UpdatedDateUTC ASC",
          undefined,
          page,
          false
        ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "syncContactsFromXero",
        context: `syncContacts getContacts(page ${page})`,
      }
    );

    const pageContacts = response.body.contacts ?? [];
    if (pageContacts.length === 0) {
      break;
    }

    contacts.push(...pageContacts);

    if (pageContacts.length < XERO_PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  return contacts;
}

/**
 * Parse an error thrown during Xero API operations into a human-readable string.
 * Handles Error instances, xero-node SDK response objects, plain strings, and unknown types.
 */
function parseXeroError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (obj.statusCode || obj.status) {
      let msg = `HTTP ${obj.statusCode ?? obj.status}`;
      if (obj.body && typeof obj.body === "object") {
        const body = obj.body as Record<string, unknown>;
        if (body.Detail) msg += `: ${body.Detail}`;
        else if (body.Message) msg += `: ${body.Message}`;
        else if (body.Title) msg += `: ${body.Title}`;
      } else if (obj.message) {
        msg += `: ${obj.message}`;
      }
      return msg;
    }
    return JSON.stringify(err).slice(0, 200);
  }
  if (typeof err === "string") {
    return err;
  }
  return "Unknown error";
}

/**
 * Import members from Xero contact groups into TACBookings.
 * Creates new Member records and optionally sends invite emails.
 */
export async function importMembersFromXeroGroups(
  groupMappings: Array<{ groupId: string; groupName: string; ageTier: AgeTier }>,
  sendInvites: boolean,
  options: ImportMembersFromXeroGroupsOptions = {}
): Promise<{
  created: number;
  createdAsDependent: number;
  skippedExisting: number;
  linkedExisting: number;
  skippedNoEmail: number;
  skippedNoEmailDetails: Array<{ name: string; xeroContactId: string }>;
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
  groupsProcessed: string[];
}> {
  let created = 0;
  let createdAsDependent = 0;
  let skippedExisting = 0;
  let linkedExisting = 0;
  let skippedNoEmail = 0;
  const skippedNoEmailDetails: Array<{ name: string; xeroContactId: string }> = [];
  let errors = 0;
  const errorDetails: Array<{ member: string; error: string }> = [];
  const groupsProcessed: string[] = [];

  // Hash a random UUID — unguessable placeholder password
  const placeholderHash = await hash(randomBytes(32).toString("hex"), 13);
  const groupCacheCursor = await getXeroSyncCursor(
    CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  if (!groupCacheCursor?.lastSuccessfulSyncAt) {
    throw new Error(
      "Xero contact group cache is empty. Refresh cached contact groups before importing members."
    );
  }

  const uniqueGroupIds = Array.from(
    new Set(groupMappings.map((mapping) => mapping.groupId))
  );
  const membershipRows = await prisma.xeroContactGroupMembershipCache.findMany({
    where: {
      contactGroupId: {
        in: uniqueGroupIds,
      },
    },
    select: {
      contactGroupId: true,
      contactId: true,
    },
  });
  const contactIdsByGroup = new Map<string, string[]>();
  for (const row of membershipRows) {
    const existing = contactIdsByGroup.get(row.contactGroupId) ?? [];
    existing.push(row.contactId);
    contactIdsByGroup.set(row.contactGroupId, existing);
  }

  const uniqueContactIds = Array.from(
    new Set(membershipRows.map((row) => row.contactId))
  );
  const contactSyncCursor = await getXeroSyncCursor(
    CONTACT_SYNC_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  const cachedContacts = uniqueContactIds.length
    ? await prisma.xeroContactCache.findMany({
        where: {
          contactId: {
            in: uniqueContactIds,
          },
        },
        select: {
          contactId: true,
          name: true,
          firstName: true,
          lastName: true,
          emailAddress: true,
          companyNumber: true,
          contactStatus: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
          streetAddressLine1: true,
          streetAddressLine2: true,
          streetCity: true,
          streetRegion: true,
          streetPostalCode: true,
          streetCountry: true,
          postalAddressLine1: true,
          postalAddressLine2: true,
          postalCity: true,
          postalRegion: true,
          postalPostalCode: true,
          postalCountry: true,
        },
      })
    : [];
  const cachedContactsById = new Map(
    cachedContacts.map((contact) => [contact.contactId, contact])
  );
  const missingContactIds = uniqueContactIds.filter(
    (contactId) => !cachedContactsById.has(contactId)
  );

  if (missingContactIds.length > 0) {
    if (!contactSyncCursor?.lastSuccessfulSyncAt && !options.allowLiveXeroFetch) {
      throw new Error(
        "Xero contact cache is empty. Run contact sync before importing members."
      );
    }

    if (!options.allowLiveXeroFetch) {
      throw new Error(
        `Xero contact cache is missing ${missingContactIds.length} contact snapshot(s). Run contact sync first, or retry the import in repair mode.`
      );
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const repairedContacts = await fetchXeroContactsByIdsFromXero({
      xero,
      tenantId,
      contactIds: missingContactIds,
      workflow: "importMembersFromXeroGroups",
      contextPrefix: "importMembersFromXeroGroups repair",
    });
    const repairedAt = new Date();

    for (const contact of repairedContacts) {
      const cachedContact = await upsertXeroContactCacheEntry(contact, repairedAt);
      if (cachedContact) {
        cachedContactsById.set(cachedContact.contactId, cachedContact);
      }
    }
  }

  for (const mapping of groupMappings) {
    const contactIds = contactIdsByGroup.get(mapping.groupId) ?? [];
    groupsProcessed.push(mapping.groupName);
    logger.info(
      {
        groupName: mapping.groupName,
        groupContactCount: contactIds.length,
        cachedContactCount: contactIds.filter((contactId) =>
          cachedContactsById.has(contactId)
        ).length,
      },
      "Loaded cached group contacts for import"
    );

    for (const contactId of contactIds) {
      const contact = cachedContactsById.get(contactId);
      if (!contact) {
        errors++;
        errorDetails.push({
          member: `${mapping.groupName}:${contactId}`,
          error:
            "Missing cached Xero contact snapshot. Run contact sync first, or retry the import in repair mode.",
        });
        continue;
      }

      try {
        const contactName = getXeroContactDisplayName(contact);
        if (!contact.emailAddress) {
          skippedNoEmail++;
          skippedNoEmailDetails.push({
            name: contactName,
            xeroContactId: contact.contactId,
          });
          continue;
        }

        const email = contact.emailAddress.toLowerCase().trim();

        const alreadyLinked = await prisma.member.findFirst({
          where: { xeroContactId: contact.contactId },
        });
        if (alreadyLinked) {
          skippedExisting++;
          continue;
        }

        const existingPrimary = await prisma.member.findFirst({
          where: { email, canLogin: true },
        });

        if (existingPrimary) {
          const contactFirstName = (contact.firstName || "").toLowerCase().trim();
          const contactLastName = (contact.lastName || "").toLowerCase().trim();
          const primaryFirstName = existingPrimary.firstName.toLowerCase().trim();
          const primaryLastName = existingPrimary.lastName.toLowerCase().trim();

          const isSamePerson =
            (contactFirstName === primaryFirstName &&
              contactLastName === primaryLastName) ||
            (!contactFirstName && !contactLastName);

          if (isSamePerson) {
            skippedExisting++;
            const updates: Record<string, unknown> = {};

            if (!existingPrimary.xeroContactId) {
              updates.xeroContactId = contact.contactId;
            }
            if (!existingPrimary.dateOfBirth) {
              const parsedDateOfBirth = parseXeroCompanyNumberDate(
                contact.companyNumber
              );
              if (parsedDateOfBirth) {
                updates.dateOfBirth = parsedDateOfBirth;
              }
            }
            if (!existingPrimary.phoneNumber && contact.phoneNumber) {
              updates.phoneCountryCode = contact.phoneCountryCode;
              updates.phoneAreaCode = contact.phoneAreaCode;
              updates.phoneNumber = contact.phoneNumber;
            }
            if (
              !existingPrimary.streetAddressLine1 &&
              contact.streetAddressLine1
            ) {
              updates.streetAddressLine1 = contact.streetAddressLine1;
              updates.streetAddressLine2 = contact.streetAddressLine2;
              updates.streetCity = contact.streetCity;
              updates.streetRegion = contact.streetRegion;
              updates.streetPostalCode = contact.streetPostalCode;
              updates.streetCountry = contact.streetCountry;
            }
            if (
              !existingPrimary.postalAddressLine1 &&
              contact.postalAddressLine1
            ) {
              updates.postalAddressLine1 = contact.postalAddressLine1;
              updates.postalAddressLine2 = contact.postalAddressLine2;
              updates.postalCity = contact.postalCity;
              updates.postalRegion = contact.postalRegion;
              updates.postalPostalCode = contact.postalPostalCode;
              updates.postalCountry = contact.postalCountry;
            }

            if (Object.keys(updates).length > 0) {
              await prisma.member.update({
                where: { id: existingPrimary.id },
                data: updates,
              });
              if (updates.xeroContactId) {
                linkedExisting++;
              }
            }
            continue;
          }

          const existingFamilyMember = await prisma.member.findFirst({
            where: {
              email,
              canLogin: false,
              firstName: {
                equals: contact.firstName || "Unknown",
                mode: "insensitive",
              },
              lastName: {
                equals: contact.lastName || "Unknown",
                mode: "insensitive",
              },
            },
          });
          if (existingFamilyMember) {
            skippedExisting++;
            if (!existingFamilyMember.xeroContactId) {
              await prisma.member.update({
                where: { id: existingFamilyMember.id },
                data: { xeroContactId: contact.contactId },
              });
              linkedExisting++;
            }
            continue;
          }

          let depFirstName = contact.firstName || "";
          let depLastName = contact.lastName || "";
          if (!depFirstName && !depLastName && contact.name) {
            const parts = contact.name.trim().split(/\s+/);
            depFirstName = parts[0] || "Unknown";
            depLastName = parts.slice(1).join(" ") || "Unknown";
          }
          if (!depFirstName) depFirstName = "Unknown";
          if (!depLastName) depLastName = "Unknown";

          const depDob = parseXeroCompanyNumberDate(contact.companyNumber);

          const newFamilyMember = await prisma.member.create({
            data: {
              email,
              firstName: depFirstName,
              lastName: depLastName,
              passwordHash: placeholderHash,
              ageTier: mapping.ageTier,
              dateOfBirth: depDob,
              xeroContactId: contact.contactId,
              phoneCountryCode: contact.phoneCountryCode,
              phoneAreaCode: contact.phoneAreaCode,
              phoneNumber: contact.phoneNumber,
              streetAddressLine1: contact.streetAddressLine1,
              streetAddressLine2: contact.streetAddressLine2,
              streetCity: contact.streetCity,
              streetRegion: contact.streetRegion,
              streetPostalCode: contact.streetPostalCode,
              streetCountry: contact.streetCountry,
              postalAddressLine1: contact.postalAddressLine1,
              postalAddressLine2: contact.postalAddressLine2,
              postalCity: contact.postalCity,
              postalRegion: contact.postalRegion,
              postalPostalCode: contact.postalPostalCode,
              postalCountry: contact.postalCountry,
              active: true,
              emailVerified: true,
              canLogin: false,
              inheritEmailFromId: existingPrimary.id,
            },
          });

          const existingGroup = await prisma.familyGroupMember.findFirst({
            where: { memberId: existingPrimary.id },
            select: { familyGroupId: true },
          });

          if (existingGroup) {
            await prisma.familyGroupMember.create({
              data: {
                familyGroupId: existingGroup.familyGroupId,
                memberId: newFamilyMember.id,
                role: "MEMBER",
              },
            }).catch(() => {});
          } else {
            const group = await prisma.familyGroup.create({
              data: { name: `${existingPrimary.lastName} Family` },
            });
            await prisma.familyGroupMember.createMany({
              data: [
                {
                  familyGroupId: group.id,
                  memberId: existingPrimary.id,
                  role: "ADMIN",
                },
                {
                  familyGroupId: group.id,
                  memberId: newFamilyMember.id,
                  role: "MEMBER",
                },
              ],
              skipDuplicates: true,
            });
          }

          createdAsDependent++;
          continue;
        }

        let firstName = contact.firstName || "";
        let lastName = contact.lastName || "";
        if (!firstName && !lastName && contact.name) {
          const parts = contact.name.trim().split(/\s+/);
          firstName = parts[0] || "Unknown";
          lastName = parts.slice(1).join(" ") || "Unknown";
        }
        if (!firstName) firstName = "Unknown";
        if (!lastName) lastName = "Unknown";

        const dateOfBirth = parseXeroCompanyNumberDate(contact.companyNumber);

        const member = await prisma.member.create({
          data: {
            email,
            firstName,
            lastName,
            passwordHash: placeholderHash,
            ageTier: mapping.ageTier,
            dateOfBirth,
            xeroContactId: contact.contactId,
            phoneCountryCode: contact.phoneCountryCode,
            phoneAreaCode: contact.phoneAreaCode,
            phoneNumber: contact.phoneNumber,
            streetAddressLine1: contact.streetAddressLine1,
            streetAddressLine2: contact.streetAddressLine2,
            streetCity: contact.streetCity,
            streetRegion: contact.streetRegion,
            streetPostalCode: contact.streetPostalCode,
            streetCountry: contact.streetCountry,
            postalAddressLine1: contact.postalAddressLine1,
            postalAddressLine2: contact.postalAddressLine2,
            postalCity: contact.postalCity,
            postalRegion: contact.postalRegion,
            postalPostalCode: contact.postalPostalCode,
            postalCountry: contact.postalCountry,
            active: true,
            emailVerified: true,
          },
        });

        created++;

        if (sendInvites) {
          try {
            const token = randomBytes(32).toString("hex");
            const expiresAt = new Date(
              Date.now() + 7 * 24 * 60 * 60 * 1000
            );

            await prisma.passwordResetToken.create({
              data: {
                token,
                memberId: member.id,
                expiresAt,
              },
            });

            sendPasswordResetEmail(member.email, token).catch((err) => {
              logger.error(
                { err, email: member.email },
                "Failed to send invite email during member import"
              );
            });
          } catch (emailErr) {
            logger.error(
              { err: emailErr, email: member.email },
              "Failed to create invite token during member import"
            );
          }
        }
      } catch (contactErr) {
        if (contactErr instanceof XeroDailyLimitError) throw contactErr;
        logger.error(
          { err: contactErr, contactEmail: contact.emailAddress },
          "Error processing cached contact during member import"
        );
        errors++;
        errorDetails.push({
          member: contact.name || contact.emailAddress || contact.contactId,
          error: parseXeroError(contactErr),
        });
      }
    }
  }

  return {
    created,
    createdAsDependent,
    skippedExisting,
    linkedExisting,
    skippedNoEmail,
    skippedNoEmailDetails,
    errors,
    errorDetails,
    groupsProcessed,
  };
}

// ---------------------------------------------------------------------------
// Contact update (TAC -> Xero)
// ---------------------------------------------------------------------------

export interface XeroContactUpdateData {
  firstName: string;
  lastName: string;
  email: string;
  dateOfBirth?: Date | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  streetAddressLine1?: string | null;
  streetAddressLine2?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalAddressLine2?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
}

/**
 * Update a Xero contact's details when a member is edited in TACBookings.
 */
export async function updateXeroContact(
  xeroContactId: string,
  data: XeroContactUpdateData,
  options?: {
    localModel?: string;
    localId?: string;
    createdByMemberId?: string;
  }
): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  const buildContact = (contactId: string): Contact => ({
    contactID: contactId,
    name: `${data.firstName} ${data.lastName}`,
    firstName: data.firstName,
    lastName: data.lastName,
    emailAddress: data.email,
    companyNumber: formatDateOfBirthForXero(data.dateOfBirth),
    phones: data.phoneNumber
      ? [{ phoneType: Phone.PhoneTypeEnum.MOBILE, phoneCountryCode: data.phoneCountryCode || "", phoneAreaCode: data.phoneAreaCode || "", phoneNumber: data.phoneNumber }]
      : [],
    addresses: buildXeroAddresses(data),
  });
  const buildOperationKeys = (contactId: string) => {
    const payloadHash = buildXeroPayloadHash(buildContact(contactId));
    const idempotencyKey = buildXeroIdempotencyKey(
      "contact",
      contactId,
      "update",
      payloadHash,
      "v1"
    );

    return {
      idempotencyKey,
      correlationKey: idempotencyKey,
    };
  };

  const initialKeys = buildOperationKeys(xeroContactId);
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CONTACT",
    operationType: "UPDATE",
    localModel: options?.localModel,
    localId: options?.localId,
    idempotencyKey: initialKeys.idempotencyKey,
    correlationKey: initialKeys.correlationKey,
    requestPayload: { contacts: [buildContact(xeroContactId)] },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId:
        options?.localModel === "Member" && options.localId
          ? options.localId
          : "",
      currentContactId: xeroContactId,
      workflow: "updateXeroContact",
      operationId: operation.id,
      repairExistingLink:
        options?.localModel !== "Member" || !options.localId,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (contactId) => ({
        contacts: [buildContact(contactId)],
      }),
      buildOperationKeys,
      run: ({ contactId, idempotencyKey }) =>
        callXeroApi(
          () =>
            xero.accountingApi.updateContact(
              tenantId,
              contactId,
              { contacts: [buildContact(contactId)] },
              idempotencyKey ?? undefined
            ),
          {
            operation: "updateContact",
            resourceType: "CONTACT",
            workflow: "updateXeroContact",
            context: `updateContact(${contactId})`,
          }
        ),
    });
    const completedContactId =
      response.body.contacts?.[0]?.contactID ?? xeroContactId;

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "CONTACT",
      xeroObjectId: completedContactId,
      xeroObjectUrl: buildXeroContactUrl(completedContactId),
      extraLinks:
        options?.localModel && options.localId
          ? [
              {
                localModel: options.localModel,
                localId: options.localId,
                xeroObjectType: "CONTACT",
                xeroObjectId: completedContactId,
                xeroObjectUrl: buildXeroContactUrl(completedContactId),
                role: "CONTACT",
              },
            ]
          : [],
    });
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Membership subscription verification
// ---------------------------------------------------------------------------

/**
 * Determine membership subscription status for a member by checking
 * Xero invoices for the current season year.
 *
 * Looks for invoices containing "subscription" or "membership" in the
 * description for the matching season year, checks if they're paid.
 */
function getMembershipSyncCursorScope(seasonYear: number): string {
  return `season:${seasonYear}`;
}

function getMembershipSeasonWindow(seasonYear: number): {
  start: Date;
  end: Date;
} {
  return {
    start: new Date(Date.UTC(seasonYear, 3, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(seasonYear + 1, 2, 31, 23, 59, 59, 999)),
  };
}

function buildMembershipInvoiceWhereClause(
  seasonYear: number,
  xeroContactId?: string
): string {
  const conditions = [
    `Date >= DateTime(${seasonYear},4,1)`,
    `Date <= DateTime(${seasonYear + 1},3,31)`,
    `Type=="ACCREC"`,
  ];

  if (xeroContactId) {
    conditions.unshift(`Contact.ContactID=guid("${xeroContactId}")`);
  }

  return conditions.join(" AND ");
}

function didMembershipStatusChange(
  previous:
    | {
        status: string;
        xeroInvoiceId: string | null;
        paidAt: Date | null;
        xeroOnlineInvoiceUrl?: string | null;
      }
    | null,
  next: {
    status: string;
    xeroInvoiceId?: string;
    paidAt?: Date;
    xeroOnlineInvoiceUrl?: string | null;
  }
): boolean {
  return (
    !previous ||
    previous.status !== next.status ||
    previous.xeroInvoiceId !== (next.xeroInvoiceId ?? null) ||
    (previous.paidAt?.getTime() ?? null) !== (next.paidAt?.getTime() ?? null) ||
    (previous.xeroOnlineInvoiceUrl ?? null) !==
      (next.xeroOnlineInvoiceUrl ?? null)
  );
}

async function listChangedMembershipInvoices(input: {
  xero: XeroClient;
  tenantId: string;
  seasonYear: number;
  ifModifiedSince?: Date;
}): Promise<Invoice[]> {
  const invoices: Invoice[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await callXeroApi(
      () =>
        input.xero.accountingApi.getInvoices(
          input.tenantId,
          input.ifModifiedSince,
          buildMembershipInvoiceWhereClause(input.seasonYear),
          "UpdatedDateUTC ASC",
          undefined,
          undefined,
          undefined,
          undefined,
          page,
          false,
          false,
          undefined,
          false,
          XERO_PAGE_SIZE
        ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "refreshAllMembershipStatuses",
        context: `refreshAllMembershipStatuses incremental page ${page}`,
      }
    );

    const pageInvoices = response.body.invoices ?? [];
    invoices.push(...pageInvoices);

    page += 1;
    hasMore = pageInvoices.length === XERO_PAGE_SIZE;
  }

  return invoices;
}

export async function checkMembershipStatus(
  memberId: string,
  seasonYear?: number,
  options?: CheckMembershipStatusOptions
): Promise<{
  status: "PAID" | "UNPAID" | "OVERDUE" | "NOT_INVOICED";
  xeroInvoiceId?: string;
  paidAt?: Date;
  xeroOnlineInvoiceUrl?: string | null;
}> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
  });
  if (!member) throw new Error(`Member not found: ${memberId}`);
  if (!member.xeroContactId) {
    return { status: "NOT_INVOICED" };
  }

  const year = seasonYear ?? getSeasonYear(new Date());
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const existingSubscription = await prisma.memberSubscription.findUnique({
    where: {
      memberId_seasonYear: { memberId, seasonYear: year },
    },
    select: {
      id: true,
      status: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      xeroOnlineInvoiceUrl: true,
      paidAt: true,
    },
  });
  const correlationKey = buildXeroIdempotencyKey(
    "member",
    memberId,
    "subscription",
    year,
    "fetch",
    "v1"
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "SUBSCRIPTION",
    operationType: "FETCH",
    localModel: "Member",
    localId: memberId,
    correlationKey,
    requestPayload: {
      memberId,
      seasonYear: year,
      xeroContactId: member.xeroContactId,
      changedInvoiceIds: options?.changedInvoiceIds
        ? Array.from(options.changedInvoiceIds)
        : [],
    },
  });

  try {
    // Fetch invoices for this contact, filtered to the season year to avoid pagination issues.
    // Season year runs April to March, so filter invoices from season start to end.
    const response = await callXeroApi(
      () => xero.accountingApi.getInvoices(
        tenantId,
        undefined, // ifModifiedSince
        buildMembershipInvoiceWhereClause(year, member.xeroContactId ?? undefined), // where
        undefined, // order
        undefined, // iDs
        undefined, // invoiceNumbers
        undefined, // contactIDs
        undefined, // statuses
        1, // page
        false // includeArchived
      ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "checkMembershipStatus",
        context: `checkMembershipStatus(${memberId})`,
      }
    );

    const invoices = response.body.invoices ?? [];

    // Look for subscription invoices matching the season year
    const subscriptionAccountCode = await getAccountMapping("subscriptionIncome") ?? "203";
    const subscriptionInvoice = findSubscriptionInvoice(invoices, year, subscriptionAccountCode);

    if (!subscriptionInvoice) {
      await prisma.memberSubscription.upsert({
        where: {
          memberId_seasonYear: { memberId, seasonYear: year },
        },
        update: {
          status: "NOT_INVOICED",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          xeroOnlineInvoiceUrl: null,
          paidAt: null,
        },
        create: {
          memberId,
          seasonYear: year,
          status: "NOT_INVOICED",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          xeroOnlineInvoiceUrl: null,
          paidAt: null,
        },
      });

      await completeXeroSyncOperation(operation.id, {
        responsePayload: {
          fetchedInvoices: invoices.length,
          previousStatus: existingSubscription?.status ?? null,
          nextStatus: "NOT_INVOICED",
          matchedInvoiceId: null,
        },
      });

      return { status: "NOT_INVOICED" };
    }

    const status = determineSubscriptionStatus(subscriptionInvoice);
    const matchedInvoiceId = subscriptionInvoice.invoiceID ?? null;
    const matchedInvoiceNumber = subscriptionInvoice.invoiceNumber ?? null;
    const matchedInvoiceChanged = Boolean(
      matchedInvoiceId &&
        options?.changedInvoiceIds?.has(matchedInvoiceId)
    );

    let onlineInvoiceUrl =
      existingSubscription?.xeroInvoiceId === matchedInvoiceId
        ? existingSubscription.xeroOnlineInvoiceUrl ?? null
        : null;
    const shouldRefreshOnlineInvoiceUrl = Boolean(
      matchedInvoiceId &&
        (
          options?.forceRefreshOnlineInvoiceUrl ||
          !existingSubscription ||
          existingSubscription.xeroInvoiceId !== matchedInvoiceId ||
          existingSubscription.xeroInvoiceNumber !== matchedInvoiceNumber ||
          existingSubscription.status !== status.status ||
          (existingSubscription.paidAt?.getTime() ?? null) !==
            (status.paidAt?.getTime() ?? null) ||
          (matchedInvoiceChanged && !existingSubscription.xeroOnlineInvoiceUrl)
        )
    );

    if (matchedInvoiceId && shouldRefreshOnlineInvoiceUrl) {
      try {
        const onlineRes = await callXeroApi(
          () => xero.accountingApi.getOnlineInvoice(tenantId, matchedInvoiceId),
          {
            operation: "getOnlineInvoice",
            resourceType: "ONLINE_INVOICE",
            workflow: "checkMembershipStatus",
            context: `getOnlineInvoice(${matchedInvoiceId})`,
          }
        );
        const onlineInvoices = onlineRes.body.onlineInvoices;
        if (onlineInvoices && onlineInvoices.length > 0) {
          onlineInvoiceUrl = onlineInvoices[0].onlineInvoiceUrl ?? null;
        }
      } catch {
        // Non-critical — continue without online URL
      }
    }

    // Update local MemberSubscription record
    const subscriptionRecord = await prisma.memberSubscription.upsert({
      where: {
        memberId_seasonYear: { memberId, seasonYear: year },
      },
      update: {
        status: status.status,
        xeroInvoiceId: matchedInvoiceId,
        xeroInvoiceNumber: matchedInvoiceNumber,
        xeroOnlineInvoiceUrl: onlineInvoiceUrl,
        paidAt: status.paidAt,
      },
      create: {
        memberId,
        seasonYear: year,
        status: status.status,
        xeroInvoiceId: matchedInvoiceId,
        xeroInvoiceNumber: matchedInvoiceNumber,
        xeroOnlineInvoiceUrl: onlineInvoiceUrl,
        paidAt: status.paidAt,
      },
    });

    await completeXeroSyncOperation(operation.id, {
      responsePayload: {
        fetchedInvoices: invoices.length,
        matchedInvoiceId,
        matchedInvoiceNumber,
        previousStatus: existingSubscription?.status ?? null,
        nextStatus: status.status,
        previousPaidAt: existingSubscription?.paidAt ?? null,
        nextPaidAt: status.paidAt ?? null,
        onlineInvoiceUrl,
        onlineInvoiceFetched: shouldRefreshOnlineInvoiceUrl,
      },
      xeroObjectType: matchedInvoiceId ? "SUBSCRIPTION" : null,
      xeroObjectId: matchedInvoiceId,
      xeroObjectNumber: matchedInvoiceNumber,
      xeroObjectUrl: matchedInvoiceId
        ? buildXeroInvoiceUrl(matchedInvoiceId)
        : null,
      extraLinks: matchedInvoiceId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscriptionRecord.id,
              xeroObjectType: "SUBSCRIPTION",
              xeroObjectId: matchedInvoiceId,
              xeroObjectNumber: matchedInvoiceNumber,
              xeroObjectUrl: buildXeroInvoiceUrl(matchedInvoiceId),
              role: "SUBSCRIPTION_INVOICE",
              metadata: {
                seasonYear: year,
                onlineInvoiceUrl,
              },
            },
          ]
        : [],
    });

    return {
      status: status.status,
      xeroInvoiceId: matchedInvoiceId ?? undefined,
      paidAt: status.paidAt,
      xeroOnlineInvoiceUrl: onlineInvoiceUrl,
    };
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

/**
 * Find a subscription invoice among a list of Xero invoices for a given season year.
 * Exported for testing.
 */
export function findSubscriptionInvoice(
  invoices: Invoice[],
  seasonYear: number,
  subscriptionAccountCode: string = "203"
): Invoice | null {
  const SUBSCRIPTION_ACCOUNT_CODE = subscriptionAccountCode;
  const seasonStart = new Date(seasonYear, 3, 1); // April 1
  const seasonEndExclusive = new Date(seasonYear + 1, 3, 1); // April 1 next year (exclusive)

  for (const invoice of invoices) {
    // Check if invoice date falls within the season year [seasonStart, seasonEndExclusive)
    const invoiceDate = invoice.date ? new Date(invoice.date) : null;
    if (!invoiceDate) continue;

    if (invoiceDate < seasonStart || invoiceDate >= seasonEndExclusive) continue;

    // Check if any line item uses account code 203 (Annual Subs)
    const hasSubsAccountCode = invoice.lineItems?.some(
      (li) => li.accountCode === SUBSCRIPTION_ACCOUNT_CODE
    );

    // Also check invoice reference for "Annual Member Subscription"
    const ref = (invoice.reference ?? "").toLowerCase();
    const hasRefMatch = ref.includes("annual member subscription");

    if (hasSubsAccountCode || hasRefMatch) {
      return invoice;
    }
  }

  return null;
}

/**
 * Determine subscription status from a Xero invoice.
 * Exported for testing.
 */
export function determineSubscriptionStatus(invoice: Invoice): {
  status: "PAID" | "UNPAID" | "OVERDUE";
  paidAt?: Date;
} {
  const invoiceStatus = invoice.status;

  if (invoiceStatus === Invoice.StatusEnum.PAID) {
    // Use fullyPaidOnDate if available, otherwise fall back to updatedDateUTC
    const paidAt = invoice.fullyPaidOnDate
      ? new Date(invoice.fullyPaidOnDate)
      : invoice.updatedDateUTC
        ? new Date(invoice.updatedDateUTC)
        : undefined;
    return { status: "PAID", paidAt };
  }

  if (
    invoiceStatus === Invoice.StatusEnum.AUTHORISED ||
    invoiceStatus === Invoice.StatusEnum.SUBMITTED
  ) {
    // Check if it's past due
    const dueDate = invoice.dueDate ? new Date(invoice.dueDate) : null;
    if (dueDate && dueDate < new Date()) {
      return { status: "OVERDUE" };
    }
    return { status: "UNPAID" };
  }

  // Draft or voided invoices — treat as not yet properly invoiced
  return { status: "UNPAID" };
}

/**
 * Refresh membership status for all active members.
 * Called by the daily cron job.
 */
export async function refreshAllMembershipStatuses(seasonYear?: number): Promise<{
  seasonYear: number;
  cursorFrom: string | null;
  cursorTo: string | null;
  changedInvoices: number;
  changedInvoiceIds: string[];
  affectedMembers: number;
  checked: number;
  updated: number;
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
}> {
  const year = seasonYear ?? getSeasonYear(new Date());
  const syncStartedAt = new Date();
  const cursor = await getXeroSyncCursor(
    MEMBERSHIP_SYNC_CURSOR_RESOURCE,
    getMembershipSyncCursorScope(year)
  );
  const cursorMetadata = getXeroSyncCursorMetadata(cursor?.metadata);
  const ifModifiedSince = cursor?.cursorDateTime
    ? new Date(cursor.cursorDateTime.getTime() - MEMBERSHIP_CURSOR_OVERLAP_MS)
    : undefined;
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const { start: windowStart, end: windowEnd } = getMembershipSeasonWindow(year);

  const changedInvoices = await listChangedMembershipInvoices({
    xero,
    tenantId,
    seasonYear: year,
    ifModifiedSince,
  });
  const changedContactIds = Array.from(
    new Set(
      changedInvoices
        .map((invoice) => invoice.contact?.contactID)
        .filter((contactId): contactId is string => Boolean(contactId))
    )
  );
  const retryMemberIds = Array.from(new Set(cursorMetadata.retryMemberIds ?? []));
  const memberWhereClauses: Array<Record<string, unknown>> = [];
  if (changedContactIds.length > 0) {
    memberWhereClauses.push({ xeroContactId: { in: changedContactIds } });
  }
  if (retryMemberIds.length > 0) {
    memberWhereClauses.push({ id: { in: retryMemberIds } });
  }

  const affectedMembers =
    memberWhereClauses.length === 0
      ? []
      : await prisma.member.findMany({
          where: {
            active: true,
            OR: memberWhereClauses,
          },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            xeroContactId: true,
          },
        });

  logger.info(
    {
      job: "xero-membership-refresh",
      seasonYear: year,
      cursorFrom: cursor?.cursorDateTime?.toISOString() ?? null,
      changedInvoices: changedInvoices.length,
      changedContacts: changedContactIds.length,
      retryMembers: retryMemberIds.length,
      affectedMembers: affectedMembers.length,
    },
    "Refreshing membership subscriptions from the incremental Xero invoice cursor"
  );

  const changedInvoiceIdsByContact = new Map<string, Set<string>>();
  for (const invoice of changedInvoices) {
    const contactId = invoice.contact?.contactID;
    const invoiceId = invoice.invoiceID;
    if (!contactId || !invoiceId) {
      continue;
    }

    const existingIds = changedInvoiceIdsByContact.get(contactId) ?? new Set<string>();
    existingIds.add(invoiceId);
    changedInvoiceIdsByContact.set(contactId, existingIds);
  }

  let checked = 0;
  let updated = 0;
  let errors = 0;
  const errorDetails: Array<{ member: string; error: string }> = [];
  const nextRetryMemberIds: string[] = [];

  for (let index = 0; index < affectedMembers.length; index += 1) {
    const member = affectedMembers[index];
    try {
      const before = await prisma.memberSubscription.findFirst({
        where: { memberId: member.id, seasonYear: year },
        select: {
          status: true,
          xeroInvoiceId: true,
          paidAt: true,
          xeroOnlineInvoiceUrl: true,
        },
      });
      const result = await checkMembershipStatus(member.id, year, {
        changedInvoiceIds: member.xeroContactId
          ? changedInvoiceIdsByContact.get(member.xeroContactId)
          : undefined,
      });
      checked++;

      if (didMembershipStatusChange(before, result)) {
        updated++;
      }
    } catch (err) {
      if (err instanceof XeroDailyLimitError) {
        nextRetryMemberIds.push(
          member.id,
          ...affectedMembers.slice(index + 1).map((remaining) => remaining.id)
        );
        logger.warn(
          { job: "xero-membership-refresh", checked, errors, seasonYear: year },
          "Aborting membership refresh: Xero daily API limit reached"
        );
        errorDetails.push({
          member: "SYSTEM",
          error: "Xero daily API limit reached — deferring remaining affected members",
        });
        errors++;
        break;
      }

      nextRetryMemberIds.push(member.id);
      errors++;
      const memberLabel = `${member.firstName} ${member.lastName} (${member.email})`;
      errorDetails.push({ member: memberLabel, error: parseXeroError(err) });
    }

    await throttle(MEMBERSHIP_SYNC_THROTTLE_MS);
  }

  const completedAt = new Date();
  await upsertXeroSyncCursor({
    resourceType: MEMBERSHIP_SYNC_CURSOR_RESOURCE,
    scope: getMembershipSyncCursorScope(year),
    cursorDateTime: syncStartedAt,
    lastSuccessfulSyncAt: completedAt,
    metadata: {
      retryMemberIds: Array.from(new Set(nextRetryMemberIds)),
      changedInvoiceCount: changedInvoices.length,
      affectedMemberCount: affectedMembers.length,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
  });

  return {
    seasonYear: year,
    cursorFrom: cursor?.cursorDateTime?.toISOString() ?? null,
    cursorTo: syncStartedAt.toISOString(),
    changedInvoices: changedInvoices.length,
    changedInvoiceIds: Array.from(
      new Set(
        changedInvoices
          .map((invoice) => invoice.invoiceID)
          .filter((invoiceId): invoiceId is string => Boolean(invoiceId))
      )
    ),
    affectedMembers: affectedMembers.length,
    checked,
    updated,
    errors,
    errorDetails,
  };
}

// ---------------------------------------------------------------------------
// Invoice creation (TAC -> Xero)
// ---------------------------------------------------------------------------

/**
 * Build Xero invoice line items from a booking's guests and stay nights.
 * Exported for testing.
 *
 * @param itemCodeMap - Per-guest item code lookup keyed by "${ageTier}_${seasonType}_${isMember}".
 *   When provided with a seasonType, each guest gets their own item code based on their
 *   age tier, membership status, and the booking's season type.
 * @param itemCode - Legacy single item code applied to all guests (used when itemCodeMap is empty).
 */
export function buildInvoiceLineItems(
  guests: Array<{
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    priceCents: number;
  }>,
  checkIn: Date,
  checkOut: Date,
  nights: number,
  accountCode: string = "200",
  itemCode?: string | null,
  accountCodeExplicitlyConfigured: boolean = false,
  itemCodeMap?: Map<string, string>,
  seasonType?: string | null,
): LineItem[] {
  return guests.map((guest) => {
    const perNightCents = nights > 0 ? Math.round(guest.priceCents / nights) : guest.priceCents;
    const description = [
      `${guest.firstName} ${guest.lastName}`,
      `(${guest.ageTier}${guest.isMember ? ", Member" : ", Non-member"})`,
      `${nights} night${nights !== 1 ? "s" : ""}`,
      `${formatDate(checkIn)} - ${formatDate(checkOut)}`,
    ].join(" - ");

    const lineItem: LineItem = {
      description,
      quantity: nights,
      unitAmount: perNightCents / 100, // Xero uses dollars, not cents
      taxType: "OUTPUT2", // GST on Income (NZ)
    };

    // Resolve item code: prefer per-guest granular mapping, fall back to legacy flat code
    const guestItemCode = (itemCodeMap && seasonType)
      ? (itemCodeMap.get(`${guest.ageTier}_${seasonType}_${guest.isMember}`) ?? null)
      : (itemCode ?? null);

    // If itemCode is set, Xero auto-fills the account from the Item's config.
    // If accountCode is also explicitly configured, it overrides the Item's default.
    if (guestItemCode) {
      lineItem.itemCode = guestItemCode;
    }
    // Include the account code when there is no item code, when a non-default account
    // is supplied, or when the admin explicitly configured the default account code to
    // override the selected Xero Item's own default.
    if (!guestItemCode || accountCode !== "200" || accountCodeExplicitlyConfigured) {
      lineItem.accountCode = accountCode;
    }

    return lineItem;
  });
}

export function buildEntranceFeeLineItem(
  categoryLabel: string,
  amountCents: number,
  accountCode: string = "200",
  itemCode?: string | null,
  accountCodeExplicitlyConfigured: boolean = false,
): LineItem {
  const lineItem: LineItem = {
    quantity: 1,
    unitAmount: amountCents / 100,
    taxType: "OUTPUT2",
  };

  if (itemCode) {
    lineItem.itemCode = itemCode;
  } else {
    lineItem.description = `Membership entrance fee (${categoryLabel})`;
  }

  if (!itemCode || accountCode !== "200" || accountCodeExplicitlyConfigured) {
    lineItem.accountCode = accountCode;
  }

  return lineItem;
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function buildSyntheticAllocationId(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number
): string {
  return buildXeroIdempotencyKey(
    "allocation",
    creditNoteId,
    invoiceId,
    amountCents,
    "v1"
  );
}

interface CreateXeroInvoicePaymentParams {
  localModel: string;
  localId: string;
  invoiceId: string;
  amountCents: number;
  idempotencyKey: string;
  reference: string;
  role: string;
  createdByMemberId?: string;
  metadata?: Record<string, unknown>;
}

export async function createXeroPaymentForInvoice(
  params: CreateXeroInvoicePaymentParams
): Promise<string> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
  const payment: XeroPayment = {
    invoice: { invoiceID: params.invoiceId },
    account: { code: bankCode },
    amount: params.amountCents / 100,
    date: formatDate(new Date()),
    reference: params.reference,
  };

  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "PAYMENT",
    operationType: "CREATE",
    localModel: params.localModel,
    localId: params.localId,
    idempotencyKey: params.idempotencyKey,
    correlationKey: params.idempotencyKey,
    requestPayload: { payments: [payment] },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createPayments(
          tenantId,
          { payments: [payment] },
          undefined,
          params.idempotencyKey
        ),
      {
        operation: "createPayments",
        resourceType: "PAYMENT",
        workflow: "createXeroPaymentForInvoice",
        context: `createPayment(${params.localModel} ${params.localId})`,
      }
    );

    const createdPayment = response.body.payments?.[0];
    if (!createdPayment?.paymentID) {
      throw new Error("Failed to create Xero payment");
    }

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "PAYMENT",
      xeroObjectId: createdPayment.paymentID,
      xeroObjectNumber: createdPayment.invoiceNumber ?? null,
      extraLinks: [
        {
          localModel: params.localModel,
          localId: params.localId,
          xeroObjectType: "PAYMENT",
          xeroObjectId: createdPayment.paymentID,
          xeroObjectNumber: createdPayment.invoiceNumber ?? null,
          role: params.role,
          metadata: params.metadata,
        },
      ],
    });

    return createdPayment.paymentID;
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

interface CreateXeroRefundPaymentParams {
  paymentId: string;
  invoiceId: string;
  creditNoteId: string;
  refundAmountCents: number;
  createdByMemberId?: string;
}

export async function createXeroRefundPaymentForInvoice(
  params: CreateXeroRefundPaymentParams
): Promise<string> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
  const payment = {
    invoice: { invoiceID: params.invoiceId },
    account: { code: bankCode },
    amount: params.refundAmountCents / 100,
    date: formatDate(new Date()),
    reference: `Stripe Refund - TACBookings payment ${params.paymentId.slice(0, 8)}`,
    isReconciled: false,
  };
  const idempotencyKey = buildXeroIdempotencyKey(
    "payment",
    params.paymentId,
    "refund-payment",
    params.refundAmountCents,
    "v1"
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "PAYMENT",
    operationType: "CREATE",
    localModel: "Payment",
    localId: params.paymentId,
    idempotencyKey,
    correlationKey: idempotencyKey,
    requestPayload: {
      payments: [payment],
      creditNoteId: params.creditNoteId,
    },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createPayments(
          tenantId,
          { payments: [payment] },
          undefined,
          idempotencyKey
        ),
      {
        operation: "createPayments",
        resourceType: "PAYMENT",
        workflow: "createXeroRefundPaymentForInvoice",
        context: `createPayments(refund repair ${params.paymentId})`,
      }
    );

    const createdPayment = response.body.payments?.[0];
    if (!createdPayment?.paymentID) {
      throw new Error("Failed to create Xero refund payment");
    }

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "PAYMENT",
      xeroObjectId: createdPayment.paymentID,
      xeroObjectNumber: createdPayment.invoiceNumber ?? null,
      extraLinks: [
        {
          localModel: "Payment",
          localId: params.paymentId,
          xeroObjectType: "PAYMENT",
          xeroObjectId: createdPayment.paymentID,
          xeroObjectNumber: createdPayment.invoiceNumber ?? null,
          role: "REFUND_PAYMENT",
          metadata: {
            creditNoteId: params.creditNoteId,
            invoiceId: params.invoiceId,
            amountCents: params.refundAmountCents,
          },
        },
      ],
    });

    return createdPayment.paymentID;
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

/**
 * Create a Xero invoice for a confirmed booking.
 * This is the main function that other phases should call after booking confirmation.
 *
 * @param bookingId - The booking to create an invoice for
 * @returns The Xero invoice ID
 */
export async function createXeroInvoiceForBooking(
  bookingId: string,
  options?: CreateXeroBookingInvoiceOptions
): Promise<string> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      member: true,
      guests: true,
      payment: true,
    },
  });

  if (!booking) throw new Error(`Booking not found: ${bookingId}`);
  if (!booking.payment) throw new Error(`No payment record for booking: ${bookingId}`);

  // Skip if invoice already created
  if (booking.payment.xeroInvoiceId) {
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: booking.payment.id,
      xeroObjectType: "INVOICE",
      xeroObjectId: booking.payment.xeroInvoiceId,
      xeroObjectNumber: booking.payment.xeroInvoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(booking.payment.xeroInvoiceId),
      role: "PRIMARY_INVOICE",
    });
    return booking.payment.xeroInvoiceId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  const contactId = await findOrCreateXeroContact(booking.memberId, options);

  // Resolve account codes, item codes, and season type
  const [hutFeeMapping, stripeBankCode, hutFeeItemCodeMap] = await Promise.all([
    getResolvedAccountMapping("hutFeesIncome"),
    getAccountMapping("stripeBankAccount"),
    getHutFeeItemCodeMap(),
  ]);
  const incomeCode = hutFeeMapping.code ?? "200";
  const bankCode = stripeBankCode ?? "606";

  // Calculate nights using the same logic as the pricing engine
  const checkIn = new Date(booking.checkIn);
  const checkOut = new Date(booking.checkOut);
  const nights = getStayNights(checkIn, checkOut).length;

  // Determine season type from check-in date for item code mapping
  let bookingSeasonType: string | null = null;
  const season = await prisma.season.findFirst({
    where: {
      startDate: { lte: checkIn },
      endDate: { gte: checkIn },
      active: true,
    },
    select: { type: true },
  });
  if (season) {
    bookingSeasonType = season.type;
  }

  // Build line items with per-guest item codes
  const lineItems = buildInvoiceLineItems(
    booking.guests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      priceCents: g.priceCents,
    })),
    checkIn,
    checkOut,
    nights,
    incomeCode,
    hutFeeMapping.itemCode,
    hutFeeMapping.codeExplicitlyConfigured,
    hutFeeItemCodeMap.size > 0 ? hutFeeItemCodeMap : undefined,
    bookingSeasonType,
  );

  // Add discount line if applicable
  if (booking.discountCents > 0) {
    // Use the first guest's item code for the discount, or fall back to legacy
    const firstGuest = booking.guests[0];
    const discountItemCode = (hutFeeItemCodeMap.size > 0 && bookingSeasonType && firstGuest)
      ? (hutFeeItemCodeMap.get(`${firstGuest.ageTier}_${bookingSeasonType}_${firstGuest.isMember}`) ?? hutFeeMapping.itemCode)
      : hutFeeMapping.itemCode;

    const discountLineItem: LineItem = {
      description: "Discount",
      quantity: 1,
      unitAmount: -(booking.discountCents / 100),
      taxType: "OUTPUT2",
    };
    if (discountItemCode) {
      discountLineItem.itemCode = discountItemCode;
    }
    if (!discountItemCode || hutFeeMapping.codeExplicitlyConfigured || incomeCode !== "200") {
      discountLineItem.accountCode = incomeCode;
    }
    lineItems.push(discountLineItem);
  }

  const buildInvoice = (resolvedContactId: string): Invoice => ({
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: resolvedContactId },
    lineItems,
    date: formatDate(new Date()),
    dueDate: formatDate(new Date()), // Already paid
    reference: `Booking ${bookingId.slice(0, 8)}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  });

  const invoiceIdempotencyKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice",
    "v1"
  );
  let operationId = options?.syncOperationId ?? null;
  const requestPayload = { invoices: [buildInvoice(contactId)] };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: booking.payment.id,
      idempotencyKey: invoiceIdempotencyKey,
      correlationKey: invoiceIdempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroInvoiceForBooking",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        invoices: [buildInvoice(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createInvoices(
              tenantId,
              { invoices: [buildInvoice(resolvedContactId)] },
              undefined,
              undefined,
              invoiceIdempotencyKey
            ),
          {
            operation: "createInvoices",
            resourceType: "INVOICE",
            workflow: "createXeroInvoiceForBooking",
            context: `createInvoices(booking ${bookingId})`,
          }
        ),
    });

    const createdInvoice = response.body.invoices?.[0];
    if (!createdInvoice?.invoiceID) {
      throw new Error("Failed to create Xero invoice");
    }

    // Record payment against the invoice in Xero.
    // For zero-dollar bookings (100% promo discount), we still record a $0 payment so the
    // invoice shows as PAID in Xero rather than sitting as an open AUTHORISED invoice.
    let paymentResponseBody: XeroPayment | null = null;
    let paymentWriteError: unknown = null;

    if (booking.payment.status === "SUCCEEDED") {
      const payment: XeroPayment = {
        invoice: { invoiceID: createdInvoice.invoiceID },
        account: { code: bankCode },
        amount: booking.payment.amountCents / 100,
        date: formatDate(new Date()),
        reference: booking.payment.amountCents > 0
          ? `Stripe ${booking.payment.stripePaymentIntentId ?? "payment"}`
          : "Zero-dollar booking (100% promo discount)",
      };
      const paymentIdempotencyKey = buildXeroIdempotencyKey(
        "payment",
        booking.payment.id,
        "invoice-payment",
        "v1"
      );

      try {
        const paymentResponse = await callXeroApi(
          () =>
            xero.accountingApi.createPayment(
              tenantId,
              payment,
              paymentIdempotencyKey
            ),
          {
            operation: "createPayment",
            resourceType: "PAYMENT",
            workflow: "createXeroInvoiceForBooking",
            context: `createPayment(booking ${bookingId})`,
          }
        );
        paymentResponseBody = paymentResponse.body;
      } catch (error) {
        paymentWriteError = error;
        logger.warn(
          { err: error, bookingId, invoiceId: createdInvoice.invoiceID },
          "Created Xero invoice but failed to record the corresponding Xero payment"
        );
      }
    }

    // Store the Xero invoice ID and number on the payment record
    await prisma.payment.update({
      where: { id: booking.payment.id },
      data: {
        xeroInvoiceId: createdInvoice.invoiceID,
        xeroInvoiceNumber: createdInvoice.invoiceNumber ?? null,
      },
    });

    await completeXeroSyncOperation(operationId!, {
      status: paymentWriteError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        payment: paymentResponseBody,
        paymentError: paymentWriteError,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: createdInvoice.invoiceID,
      xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
      extraLinks: [
        {
          localModel: "Payment",
          localId: booking.payment.id,
          xeroObjectType: "INVOICE",
          xeroObjectId: createdInvoice.invoiceID,
          xeroObjectNumber: createdInvoice.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(createdInvoice.invoiceID),
          role: "PRIMARY_INVOICE",
        },
        ...(paymentResponseBody?.paymentID
          ? [
              {
                localModel: "Payment",
                localId: booking.payment.id,
                xeroObjectType: "PAYMENT",
                xeroObjectId: paymentResponseBody.paymentID,
                xeroObjectNumber: paymentResponseBody.invoiceNumber ?? null,
                role: "INVOICE_PAYMENT",
                metadata: {
                  invoiceId: createdInvoice.invoiceID,
                  amount: paymentResponseBody.amount ?? booking.payment.amountCents / 100,
                },
              },
            ]
          : []),
      ],
    });

    return createdInvoice.invoiceID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Credit note on refund
// ---------------------------------------------------------------------------

/**
 * Create a Xero credit note when a booking refund is processed.
 *
 * @param paymentId - The Payment record ID (not Stripe payment intent ID)
 * @param refundAmountCents - The refund amount in cents
 * @returns The Xero credit note ID
 */
export async function createXeroCreditNote(
  paymentId: string,
  refundAmountCents: number,
  options?: CreateXeroRefundCreditNoteOptions
): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      booking: {
        include: { member: true, guests: true },
      },
    },
  });

  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  if (!payment.xeroInvoiceId) {
    throw new Error(`No Xero invoice linked to payment: ${paymentId}`);
  }
  const originalInvoiceId = payment.xeroInvoiceId;
  const queuedOperationId = options?.syncOperationId ?? null;

  // Idempotency guard: skip if credit note already created for this payment
  if (payment.xeroRefundCreditNoteId) {
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: payment.xeroRefundCreditNoteId,
      role: "REFUND_CREDIT_NOTE",
    });
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          existingCreditNoteId: payment.xeroRefundCreditNoteId,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: payment.xeroRefundCreditNoteId,
        extraLinks: [
          {
            localModel: "Payment",
            localId: paymentId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: payment.xeroRefundCreditNoteId,
            role: "REFUND_CREDIT_NOTE",
          },
        ],
      });
    }
    logger.info({ paymentId, creditNoteId: payment.xeroRefundCreditNoteId }, "Xero credit note already exists, skipping");
    return payment.xeroRefundCreditNoteId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  const contactId = await findOrCreateXeroContact(payment.booking.memberId, options);
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const refundLineItem: LineItem = {
    description: `Refund for booking ${payment.booking.id.slice(0, 8)} (${formatDate(new Date(payment.booking.checkIn))} - ${formatDate(new Date(payment.booking.checkOut))})`,
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    refundLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    refundLineItem.accountCode = accountCode;
  }

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [refundLineItem],
    reference: `Refund - Booking ${payment.booking.id.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const creditNoteIdempotencyKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "refund-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = queuedOperationId;
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    allocation: {
      invoiceId: originalInvoiceId,
      amount: refundAmountCents / 100,
    },
  };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      idempotencyKey: creditNoteIdempotencyKey,
      correlationKey: creditNoteIdempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: payment.booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroCreditNote",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
        allocation: {
          invoiceId: originalInvoiceId,
          amount: refundAmountCents / 100,
        },
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              creditNoteIdempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createXeroCreditNote",
            context: `createCreditNotes(refund ${paymentId})`,
          }
        ),
    });

    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create Xero credit note");
    }

    const allocationIdempotencyKey = buildXeroIdempotencyKey(
      "payment",
      paymentId,
      "refund-credit-note-allocation",
      refundAmountCents,
      "v1"
    );

    try {
      const allocationResponse = await callXeroApi(
        () =>
          xero.accountingApi.createCreditNoteAllocation(
            tenantId,
            createdNote.creditNoteID!,
            {
              allocations: [
                {
                  invoice: { invoiceID: originalInvoiceId },
                  amount: refundAmountCents / 100,
                  date: formatDate(new Date()),
                },
              ],
            },
            undefined,
            allocationIdempotencyKey
          ),
        {
          operation: "createCreditNoteAllocation",
          resourceType: "ALLOCATION",
          workflow: "createXeroCreditNote",
          context: `createCreditNoteAllocation(refund ${paymentId})`,
        }
      );

      // Save credit note ID to prevent duplicate creation once the core reconciliation steps succeeded
      await prisma.payment.update({
        where: { id: paymentId },
        data: { xeroRefundCreditNoteId: createdNote.creditNoteID },
      });

      // QF-3: Create refund payment against Stripe bank account for auto-reconciliation
      let refundPaymentResponseBody: { paymentID?: string; invoiceNumber?: string; amount?: number } | null = null;
      let refundPaymentErr: unknown = null;

      try {
        const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
        const refundPaymentIdempotencyKey = buildXeroIdempotencyKey(
          "payment",
          paymentId,
          "refund-payment",
          refundAmountCents,
          "v1"
        );
        const refundPaymentResponse = await callXeroApi(
          () =>
            xero.accountingApi.createPayments(
              tenantId,
              {
                payments: [
                  {
                    invoice: { invoiceID: originalInvoiceId },
                    account: { code: bankCode },
                    amount: refundAmountCents / 100,
                    date: formatDate(new Date()),
                    reference: `Stripe Refund - Booking ${payment.booking.id.slice(0, 8)}`,
                    isReconciled: false,
                  },
                ],
              },
              undefined,
              refundPaymentIdempotencyKey
            ),
          {
            operation: "createPayments",
            resourceType: "PAYMENT",
            workflow: "createXeroCreditNote",
            context: `createPayments(refund ${paymentId})`,
          }
        );
        refundPaymentResponseBody = refundPaymentResponse.body.payments?.[0] ?? null;
        logger.info({ paymentId, creditNoteId: createdNote.creditNoteID }, "Xero refund payment created against Stripe bank account");
      } catch (error) {
        refundPaymentErr = error;
        logger.error({ err: error, paymentId }, "Failed to create Xero refund payment against Stripe bank account");
      }

      await completeXeroSyncOperation(operationId!, {
        status: refundPaymentErr ? "PARTIAL" : "SUCCEEDED",
        responsePayload: {
          creditNote: response.body,
          allocation: allocationResponse.body,
          refundPayment: refundPaymentResponseBody,
          refundPaymentError: refundPaymentErr,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: createdNote.creditNoteID,
        xeroObjectNumber: createdNote.creditNoteNumber ?? null,
        extraLinks: [
          {
            localModel: "Payment",
            localId: paymentId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: createdNote.creditNoteID,
            xeroObjectNumber: createdNote.creditNoteNumber ?? null,
            role: "REFUND_CREDIT_NOTE",
          },
          {
            localModel: "Payment",
            localId: paymentId,
            xeroObjectType: "ALLOCATION",
            xeroObjectId: buildSyntheticAllocationId(
              createdNote.creditNoteID,
              originalInvoiceId,
              refundAmountCents
            ),
            xeroObjectUrl: buildXeroInvoiceUrl(originalInvoiceId),
            role: "CREDIT_NOTE_ALLOCATION",
            metadata: {
              creditNoteId: createdNote.creditNoteID,
              invoiceId: originalInvoiceId,
              amountCents: refundAmountCents,
            },
          },
          ...(refundPaymentResponseBody?.paymentID
            ? [
                {
                  localModel: "Payment",
                  localId: paymentId,
                  xeroObjectType: "PAYMENT",
                  xeroObjectId: refundPaymentResponseBody.paymentID,
                  xeroObjectNumber: refundPaymentResponseBody.invoiceNumber ?? null,
                  role: "REFUND_PAYMENT",
                  metadata: {
                    creditNoteId: createdNote.creditNoteID,
                    amountCents: refundAmountCents,
                  },
                },
              ]
            : []),
        ],
      });

      return createdNote.creditNoteID;
    } catch (allocationError) {
      await completeXeroSyncOperation(operationId!, {
        status: "PARTIAL",
        responsePayload: {
          creditNote: response.body,
          allocationError,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: createdNote.creditNoteID,
        xeroObjectNumber: createdNote.creditNoteNumber ?? null,
        extraLinks: [
          {
            localModel: "Payment",
            localId: paymentId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: createdNote.creditNoteID,
            xeroObjectNumber: createdNote.creditNoteNumber ?? null,
            role: "REFUND_CREDIT_NOTE",
          },
        ],
      });
      throw allocationError;
    }
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

async function backfillCancellationCreditXeroNote(params: {
  memberId: string;
  bookingId: string;
  refundAmountCents: number;
  creditNoteId: string;
}) {
  const bookingLabel = params.bookingId.slice(0, 8);
  await prisma.memberCredit.updateMany({
    where: {
      memberId: params.memberId,
      sourceBookingId: params.bookingId,
      amountCents: params.refundAmountCents,
      type: CreditType.CANCELLATION_REFUND,
      description: `Cancellation refund for booking ${bookingLabel}`,
      xeroCreditNoteId: null,
    },
    data: {
      xeroCreditNoteId: params.creditNoteId,
    },
  });
}

/**
 * Create an UNAPPLIED Xero credit note for account credit refunds.
 * Unlike createXeroCreditNote(), this:
 * - Does NOT allocate against the original invoice
 * - Does NOT create a cash refund payment
 * The credit note stays as open credit on the member's Xero contact.
 */
export async function createUnappliedXeroCreditNote(
  paymentId: string,
  refundAmountCents: number,
  options?: CreateXeroUnappliedCreditNoteOptions
): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      booking: {
        include: { member: true },
      },
    },
  });

  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  const queuedOperationId = options?.syncOperationId ?? null;
  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "ACCOUNT_CREDIT_NOTE",
      active: true,
    },
    select: {
      xeroObjectId: true,
      xeroObjectNumber: true,
    },
  });

  if (existingLink?.xeroObjectId) {
    await backfillCancellationCreditXeroNote({
      memberId: payment.booking.memberId,
      bookingId: payment.booking.id,
      refundAmountCents,
      creditNoteId: existingLink.xeroObjectId,
    });

    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          existingCreditNoteId: existingLink.xeroObjectId,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: existingLink.xeroObjectId,
        xeroObjectNumber: existingLink.xeroObjectNumber ?? null,
        extraLinks: [
          {
            localModel: "Payment",
            localId: paymentId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingLink.xeroObjectId,
            xeroObjectNumber: existingLink.xeroObjectNumber ?? null,
            role: "ACCOUNT_CREDIT_NOTE",
          },
        ],
      });
    }

    logger.info(
      { paymentId, creditNoteId: existingLink.xeroObjectId },
      "Xero account-credit note already exists, skipping"
    );

    return existingLink.xeroObjectId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(payment.booking.memberId, options);
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const creditLineItem: LineItem = {
    description: `Account credit from booking ${payment.booking.id.slice(0, 8)} (${formatDate(new Date(payment.booking.checkIn))} - ${formatDate(new Date(payment.booking.checkOut))})`,
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    creditLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    creditLineItem.accountCode = accountCode;
  }

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [creditLineItem],
    reference: `Account Credit - Booking ${payment.booking.id.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const idempotencyKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "unapplied-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = queuedOperationId;
  const requestPayload = { creditNotes: [buildCreditNote(contactId)] };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: payment.booking.memberId,
      currentContactId: contactId,
      workflow: "createUnappliedXeroCreditNote",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              idempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createUnappliedXeroCreditNote",
            context: `createCreditNotes(unapplied ${paymentId})`,
          }
        ),
    });

    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create unapplied Xero credit note");
    }

    await backfillCancellationCreditXeroNote({
      memberId: payment.booking.memberId,
      bookingId: payment.booking.id,
      refundAmountCents,
      creditNoteId: createdNote.creditNoteID,
    });

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      extraLinks: [
        {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          role: "ACCOUNT_CREDIT_NOTE",
        },
      ],
    });

    logger.info(
      { paymentId, creditNoteId: createdNote.creditNoteID },
      "Created unapplied Xero credit note for account credit"
    );

    return createdNote.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

/**
 * Allocate an existing Xero credit note against an invoice.
 * Used when account credit (backed by a Xero credit note) is applied to a new booking.
 */
export async function allocateCreditNoteToInvoice(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
  options?: {
    localModel?: string;
    localId?: string;
    role?: string;
    createdByMemberId?: string;
  }
): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const idempotencyKey = buildXeroIdempotencyKey(
    "credit-note",
    creditNoteId,
    "invoice",
    invoiceId,
    "allocation",
    amountCents,
    "v1"
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "ALLOCATION",
    operationType: "ALLOCATE",
    localModel: options?.localModel,
    localId: options?.localId,
    idempotencyKey,
    correlationKey: idempotencyKey,
    requestPayload: {
      creditNoteId,
      invoiceId,
      amountCents,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createCreditNoteAllocation(
          tenantId,
          creditNoteId,
          {
            allocations: [
              {
                invoice: { invoiceID: invoiceId },
                amount: amountCents / 100,
                date: formatDate(new Date()),
              },
            ],
          },
          undefined,
          idempotencyKey
        ),
      {
        operation: "createCreditNoteAllocation",
        resourceType: "ALLOCATION",
        workflow: "allocateCreditNoteToInvoice",
        context: `createCreditNoteAllocation(${creditNoteId} -> ${invoiceId})`,
      }
    );

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: buildSyntheticAllocationId(creditNoteId, invoiceId, amountCents),
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
      extraLinks:
        options?.localModel && options.localId
          ? [
              {
                localModel: options.localModel,
                localId: options.localId,
                xeroObjectType: "ALLOCATION",
                xeroObjectId: buildSyntheticAllocationId(creditNoteId, invoiceId, amountCents),
                xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
                role: options.role ?? "CREDIT_NOTE_ALLOCATION",
                metadata: {
                  creditNoteId,
                  invoiceId,
                  amountCents,
                },
              },
            ]
          : [],
    });

    logger.info(
      { creditNoteId, invoiceId, amountCents },
      "Allocated Xero credit note against invoice"
    );
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// XER-01: Xero Invoice Adjustment on Booking Modification
// ---------------------------------------------------------------------------

/**
 * Create a supplementary Xero invoice when a booking modification increases
 * the price. Optionally includes a separate line item for a late-notice
 * change fee.
 *
 * Fire-and-forget: caller should catch errors and log them.
 */
export async function createXeroSupplementaryInvoice(params: {
  bookingId: string;
  priceDiffCents: number;
  changeFeeCents: number;
  bookingModificationId?: string;
  createdByMemberId?: string;
  repairExistingLink?: boolean;
  syncOperationId?: string;
}): Promise<string | null> {
  const {
    bookingId,
    priceDiffCents,
    changeFeeCents,
    bookingModificationId,
    createdByMemberId,
    repairExistingLink,
    syncOperationId,
  } = params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking?.payment?.xeroInvoiceId) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "No original Xero invoice exists for this booking.",
        },
      });
    }
    return null;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(booking.memberId, {
    createdByMemberId,
    repairExistingLink,
  });
  const incomeMapping = await getResolvedAccountMapping("hutFeesIncome");
  const incomeCode = incomeMapping.code ?? "200";

  const lineItems: LineItem[] = [];

  if (priceDiffCents > 0) {
    const li: LineItem = {
      description: `Booking modification - price adjustment (Booking ${bookingId.slice(0, 8)})`,
      quantity: 1,
      unitAmount: priceDiffCents / 100,
      taxType: "OUTPUT2",
    };
    if (incomeMapping.itemCode) li.itemCode = incomeMapping.itemCode;
    if (!incomeMapping.itemCode || incomeCode !== "200" || incomeMapping.codeExplicitlyConfigured) {
      li.accountCode = incomeCode;
    }
    lineItems.push(li);
  }

  if (changeFeeCents > 0) {
    const li: LineItem = {
      description: "Late notice booking change fee",
      quantity: 1,
      unitAmount: changeFeeCents / 100,
      taxType: "OUTPUT2",
    };
    if (incomeMapping.itemCode) li.itemCode = incomeMapping.itemCode;
    if (!incomeMapping.itemCode || incomeCode !== "200" || incomeMapping.codeExplicitlyConfigured) {
      li.accountCode = incomeCode;
    }
    lineItems.push(li);
  }

  if (lineItems.length === 0) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "Supplementary invoice has no billable line items.",
        },
      });
    }
    return null;
  }

  const buildInvoice = (resolvedContactId: string): Invoice => ({
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: resolvedContactId },
    lineItems,
    date: formatDate(new Date()),
    dueDate: formatDate(new Date()),
    reference: `Supplementary for booking ${bookingId.slice(0, 8)}${booking.payment?.xeroInvoiceId ? ` (original: ${booking.payment.xeroInvoiceId})` : ""}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  });

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;
  const invoiceIdempotencyKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "supplementary-invoice",
    priceDiffCents,
    changeFeeCents,
    "v1"
  );
  let operationId = syncOperationId ?? null;
  const requestPayload = { invoices: [buildInvoice(contactId)] };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel,
      localId,
      idempotencyKey: invoiceIdempotencyKey,
      correlationKey: invoiceIdempotencyKey,
      requestPayload,
      createdByMemberId: createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroSupplementaryInvoice",
      operationId: operationId!,
      repairExistingLink,
      createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        invoices: [buildInvoice(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createInvoices(
              tenantId,
              { invoices: [buildInvoice(resolvedContactId)] },
              undefined,
              undefined,
              invoiceIdempotencyKey
            ),
          {
            operation: "createInvoices",
            resourceType: "INVOICE",
            workflow: "createXeroSupplementaryInvoice",
            context: `createInvoices(supplementary ${localId})`,
          }
        ),
    });

    const created = response.body.invoices?.[0];
    if (!created?.invoiceID) {
      throw new Error("Failed to create supplementary Xero invoice");
    }

    // Record Stripe payment against the supplementary invoice so it doesn't show as unpaid in Xero
    let paymentResponseBody: XeroPayment | null = null;
    let paymentError: unknown = null;

    try {
      const stripeBankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
      const totalCents = priceDiffCents + changeFeeCents;
      const paymentIdempotencyKey = buildXeroIdempotencyKey(
        bookingModificationId ? "booking-mod" : "booking",
        localId,
        "supplementary-payment",
        totalCents,
        "v1"
      );
      const paymentResponse = await callXeroApi(
        () =>
          xero.accountingApi.createPayments(
            tenantId,
            {
              payments: [{
                invoice: { invoiceID: created.invoiceID },
                account: { code: stripeBankCode },
                amount: totalCents / 100,
                date: formatDate(new Date()),
                reference: `Stripe payment for booking modification ${bookingId.slice(0, 8)}`,
              }],
            },
            undefined,
            paymentIdempotencyKey
          ),
        {
          operation: "createPayments",
          resourceType: "PAYMENT",
          workflow: "createXeroSupplementaryInvoice",
          context: `createPayments(supplementary ${localId})`,
        }
      );
      paymentResponseBody = paymentResponse.body.payments?.[0] ?? null;
    } catch (error) {
      paymentError = error;
      // Non-fatal: invoice exists, payment recording is for reconciliation convenience
      logger.warn({ err: error, invoiceId: created.invoiceID }, "Failed to record Xero payment for supplementary invoice");
    }

    await completeXeroSyncOperation(operationId!, {
      status: paymentError ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        invoice: response.body,
        payment: paymentResponseBody,
        paymentError,
      },
      xeroObjectType: "INVOICE",
      xeroObjectId: created.invoiceID,
      xeroObjectNumber: created.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
      extraLinks: [
        {
          localModel,
          localId,
          xeroObjectType: "INVOICE",
          xeroObjectId: created.invoiceID,
          xeroObjectNumber: created.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
          role: "SUPPLEMENTARY_INVOICE",
        },
        ...(paymentResponseBody?.paymentID
          ? [
              {
                localModel,
                localId,
                xeroObjectType: "PAYMENT",
                xeroObjectId: paymentResponseBody.paymentID,
                xeroObjectNumber: paymentResponseBody.invoiceNumber ?? null,
                role: "SUPPLEMENTARY_INVOICE_PAYMENT",
                metadata: {
                  invoiceId: created.invoiceID,
                  amountCents: priceDiffCents + changeFeeCents,
                },
              },
            ]
          : []),
      ],
    });

    return created.invoiceID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

/**
 * Create a Xero credit note when a booking modification decreases the price.
 *
 * Fire-and-forget: caller should catch errors and log them.
 */
export async function createXeroCreditNoteForModification(params: {
  bookingId: string;
  refundAmountCents: number;
  bookingModificationId?: string;
  createdByMemberId?: string;
  repairExistingLink?: boolean;
  syncOperationId?: string;
}): Promise<string | null> {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
    createdByMemberId,
    repairExistingLink,
    syncOperationId,
  } = params;

  if (refundAmountCents <= 0) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "Refund amount is zero or negative.",
        },
      });
    }
    return null;
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking?.payment?.xeroInvoiceId) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "No original Xero invoice exists for this booking.",
        },
      });
    }
    return null;
  }
  const originalInvoiceId = booking.payment.xeroInvoiceId;

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(booking.memberId, {
    createdByMemberId,
    repairExistingLink,
  });
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const modRefundLineItem: LineItem = {
    description: `Booking modification refund (Booking ${bookingId.slice(0, 8)})`,
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    modRefundLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    modRefundLineItem.accountCode = accountCode;
  }

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [modRefundLineItem],
    reference: `Modification refund - Booking ${bookingId.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;
  const creditNoteIdempotencyKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "mod-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = syncOperationId ?? null;
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    invoiceId: originalInvoiceId,
    refundAmountCents,
  };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel,
      localId,
      idempotencyKey: creditNoteIdempotencyKey,
      correlationKey: creditNoteIdempotencyKey,
      requestPayload,
      createdByMemberId: createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroCreditNoteForModification",
      operationId: operationId!,
      repairExistingLink,
      createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
        invoiceId: originalInvoiceId,
        refundAmountCents,
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              creditNoteIdempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createXeroCreditNoteForModification",
            context: `createCreditNotes(modification ${localId})`,
          }
        ),
    });

    const created = response.body.creditNotes?.[0];
    if (!created?.creditNoteID) {
      throw new Error("Failed to create modification credit note");
    }
    const createdCreditNoteId = created.creditNoteID;

    const allocationIdempotencyKey = buildXeroIdempotencyKey(
      bookingModificationId ? "booking-mod" : "booking",
      localId,
      "mod-credit-note-allocation",
      refundAmountCents,
      "v1"
    );

    try {
      const allocationResponse = await callXeroApi(
        () =>
          xero.accountingApi.createCreditNoteAllocation(
            tenantId,
            createdCreditNoteId,
            {
              allocations: [
                {
                  invoice: { invoiceID: originalInvoiceId },
                  amount: refundAmountCents / 100,
                  date: formatDate(new Date()),
                },
              ],
            },
            undefined,
            allocationIdempotencyKey
          ),
        {
          operation: "createCreditNoteAllocation",
          resourceType: "ALLOCATION",
          workflow: "createXeroCreditNoteForModification",
          context: `createCreditNoteAllocation(modification ${localId})`,
        }
      );

      await completeXeroSyncOperation(operationId!, {
        responsePayload: {
          creditNote: response.body,
          allocation: allocationResponse.body,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: createdCreditNoteId,
        xeroObjectNumber: created.creditNoteNumber ?? null,
        extraLinks: [
          {
            localModel,
            localId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: createdCreditNoteId,
            xeroObjectNumber: created.creditNoteNumber ?? null,
            role: "MODIFICATION_CREDIT_NOTE",
          },
          {
            localModel,
            localId,
            xeroObjectType: "ALLOCATION",
            xeroObjectId: buildSyntheticAllocationId(
              createdCreditNoteId,
              originalInvoiceId,
              refundAmountCents
            ),
            xeroObjectUrl: buildXeroInvoiceUrl(originalInvoiceId),
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
            metadata: {
              creditNoteId: createdCreditNoteId,
              invoiceId: originalInvoiceId,
              amountCents: refundAmountCents,
            },
          },
        ],
      });

      return createdCreditNoteId;
    } catch (allocationError) {
      await completeXeroSyncOperation(operationId!, {
        status: "PARTIAL",
        responsePayload: {
          creditNote: response.body,
          allocationError,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: createdCreditNoteId,
        xeroObjectNumber: created.creditNoteNumber ?? null,
        extraLinks: [
          {
            localModel,
            localId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: createdCreditNoteId,
            xeroObjectNumber: created.creditNoteNumber ?? null,
            role: "MODIFICATION_CREDIT_NOTE",
          },
        ],
      });
      throw allocationError;
    }
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Entrance Fee Invoice
// ---------------------------------------------------------------------------

/**
 * Create a Xero invoice for a membership entrance fee.
 * Called when an admin creates a new member (if Xero is connected and entrance fee is configured).
 *
 * Uses the granular per-category entrance fee mappings (XeroItemCodeMapping) when available,
 * falling back to the legacy flat entranceFeeAmountCents/entranceFeeItem from XeroAccountMapping.
 *
 * @param memberId - The member to invoice
 * @returns The Xero invoice ID, or null if entrance fee is not configured or Xero is not connected
 */
export async function createXeroEntranceFeeInvoice(
  memberId: string,
  options?: CreateXeroEntranceFeeInvoiceOptions
): Promise<string | null> {
  const entranceFee = options?.precomputedEntranceFee ?? (await getEntranceFeeContext(memberId));
  const { category, feeMapping } = entranceFee;
  const queuedOperationId = options?.syncOperationId ?? null;

  if (!feeMapping.amountCents || feeMapping.amountCents <= 0) {
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        status: "SUCCEEDED",
        responsePayload: {
          skipped: true,
          reason: "No entrance fee is configured for this member category.",
          category,
        },
      });
    }

    return null;
  }

  // Check Xero connectivity
  let xero: XeroClient | null = null;
  let tenantId: string | null = null;
  if (!queuedOperationId) {
    try {
      ({ xero, tenantId } = await getAuthenticatedXeroClient());
    } catch {
      // Xero not connected — skip silently on direct write paths.
      return null;
    }
  }

  const categoryLabel = category === "FAMILY" ? "Family" : category === "YOUTH" ? "Youth" : category === "CHILD" ? "Child" : "Adult";
  const idempotencyKey = buildEntranceFeeInvoiceIdempotencyKey(
    memberId,
    category,
    feeMapping.amountCents
  );
  let operationId = queuedOperationId;

  try {
    if (!xero || !tenantId) {
      ({ xero, tenantId } = await getAuthenticatedXeroClient());
    }
    const authenticatedXero = xero;
    const authenticatedTenantId = tenantId;

    const contactId = await findOrCreateXeroContact(memberId, options);
    const incomeMapping = await getResolvedAccountMapping("hutFeesIncome");
    const incomeCode = incomeMapping.code ?? "200";

    const lineItem = buildEntranceFeeLineItem(
      categoryLabel,
      feeMapping.amountCents,
      incomeCode,
      feeMapping.itemCode,
      incomeMapping.codeExplicitlyConfigured,
    );

    const buildInvoice = (resolvedContactId: string): Invoice => ({
      type: Invoice.TypeEnum.ACCREC,
      contact: { contactID: resolvedContactId },
      lineItems: [lineItem],
      date: formatDate(new Date()),
      dueDate: formatDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)), // Due in 30 days
      reference: `Entrance fee (${categoryLabel}) - ${memberId.slice(0, 8)}`,
      status: Invoice.StatusEnum.AUTHORISED,
      lineAmountTypes: LineAmountTypes.Inclusive,
    });

    const requestPayload = { invoices: [buildInvoice(contactId)] };

    if (operationId) {
      await prisma.xeroSyncOperation.update({
        where: { id: operationId },
        data: {
          requestPayload: sanitizeForJson(requestPayload),
        },
      });
    } else {
      const operation = await startXeroSyncOperation({
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Member",
        localId: memberId,
        idempotencyKey,
        correlationKey: idempotencyKey,
        requestPayload,
        createdByMemberId: options?.createdByMemberId ?? null,
      });
      operationId = operation.id;
    }

    const response = await retryXeroWriteWithContactRepair({
      memberId,
      currentContactId: contactId,
      workflow: "createXeroEntranceFeeInvoice",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        invoices: [buildInvoice(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            authenticatedXero.accountingApi.createInvoices(
              authenticatedTenantId,
              { invoices: [buildInvoice(resolvedContactId)] },
              undefined,
              undefined,
              idempotencyKey
            ),
          {
            operation: "createInvoices",
            resourceType: "INVOICE",
            workflow: "createXeroEntranceFeeInvoice",
            context: `createInvoices(entranceFee ${memberId})`,
          }
        ),
    });

    const created = response.body.invoices?.[0];
    if (!created?.invoiceID) {
      throw new Error("Failed to create Xero entrance fee invoice");
    }

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "INVOICE",
      xeroObjectId: created.invoiceID,
      xeroObjectNumber: created.invoiceNumber ?? null,
      xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
      extraLinks: [
        {
          localModel: "Member",
          localId: memberId,
          xeroObjectType: "INVOICE",
          xeroObjectId: created.invoiceID,
          xeroObjectNumber: created.invoiceNumber ?? null,
          xeroObjectUrl: buildXeroInvoiceUrl(created.invoiceID),
          role: "ENTRANCE_FEE_INVOICE",
          metadata: {
            category,
            feeAmountCents: feeMapping.amountCents,
          },
        },
      ],
    });

    logger.info(
      { memberId, category, invoiceId: created.invoiceID, feeAmountCents: feeMapping.amountCents },
      "Created Xero entrance fee invoice"
    );

    return created.invoiceID;
  } catch (error) {
    if (operationId) {
      await failXeroSyncOperation(operationId, error);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Duplicate Contact Detection
// ---------------------------------------------------------------------------

export interface DuplicateContact {
  contactID: string;
  name: string;
  firstName?: string;
  lastName?: string;
  emailAddress: string;
  hasInvoices: boolean;
  invoiceCount: number;
  contactStatus: string;
  updatedDateUTC?: string;
  xeroLink: string;
  memberId?: string;
  memberActive?: boolean;
}

export interface DuplicateGroup {
  email: string;
  contacts: DuplicateContact[];
  canCreateFamilyGroup: boolean;
  eligibleMemberIds: string[];
  suggestedGroupName?: string;
}

/**
 * Scan all Xero contacts, find duplicate emails, and return grouped results
 * with invoice counts and deep links so the admin can merge in Xero UI.
 */
export async function findDuplicateContacts(): Promise<{
  duplicateGroups: DuplicateGroup[];
  totalContacts: number;
  totalDuplicateEmails: number;
  filteredByFamilyGroup: number;
}> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Get org shortCode for deep links
  let shortCode = "";
  try {
    const orgResponse = await callXeroApi(
      () => xero.accountingApi.getOrganisations(tenantId),
      {
        operation: "getOrganisations",
        resourceType: "ORGANISATION",
        workflow: "findDuplicateContacts",
        context: "findDuplicateContacts getOrganisations",
      }
    );
    shortCode = orgResponse.body.organisations?.[0]?.shortCode || "";
  } catch {
    // If we can't get shortCode, links will fall back to generic URL
  }

  function xeroContactLink(contactID: string): string {
    return buildXeroContactUrl(contactID, { shortCode });
  }

  // Fetch all contacts, paginated
  const allContacts: Contact[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await callXeroApi(
      () => xero.accountingApi.getContacts(
        tenantId,
        undefined, // ifModifiedSince
        undefined, // where
        undefined, // order
        undefined, // iDs
        page,
        false      // includeArchived
      ),
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "findDuplicateContacts",
        context: `findDuplicateContacts getContacts(page ${page})`,
      }
    );

    const contacts = response.body.contacts ?? [];
    if (contacts.length === 0) {
      hasMore = false;
      break;
    }

    allContacts.push(...contacts);
    page++;
    if (contacts.length < 100) {
      hasMore = false;
    }
  }

  // Group by lowercase email
  const emailMap = new Map<string, Contact[]>();
  for (const contact of allContacts) {
    if (!contact.emailAddress) continue;
    const email = contact.emailAddress.toLowerCase().trim();
    const existing = emailMap.get(email) || [];
    existing.push(contact);
    emailMap.set(email, existing);
  }

  // Filter to only duplicates (2+ contacts per email)
  const duplicateEmails = Array.from(emailMap.entries()).filter(
    ([, contacts]) => contacts.length > 1
  );

  // For each duplicate group, get invoice counts
  const duplicateGroups: DuplicateGroup[] = [];

  for (const [email, contacts] of duplicateEmails) {
    const groupContacts: DuplicateContact[] = [];

    for (const contact of contacts) {
      let invoiceCount = 0;
      try {
        const invoiceResponse = await callXeroApi(
          () => xero.accountingApi.getInvoices(
            tenantId,
            undefined, // ifModifiedSince
            undefined, // where
            undefined, // order
            undefined, // iDs
            undefined, // invoiceNumbers
            [contact.contactID!], // contactIDs
            undefined, // statuses
            1,         // page
            false,     // includeArchived
            undefined, // createdByMyApp
            undefined, // unitdp
            true,      // summaryOnly
            1          // pageSize — we just need the count
          ),
          {
            operation: "getInvoices",
            resourceType: "INVOICE",
            workflow: "findDuplicateContacts",
            context: `findDuplicateContacts getInvoices(summary ${contact.contactID})`,
          }
        );
        invoiceCount = invoiceResponse.body.invoices?.length ?? 0;
        // If we got 1 result with pageSize 1, there may be more — fetch count properly
        if (invoiceCount > 0) {
          const fullResponse = await callXeroApi(
            () => xero.accountingApi.getInvoices(
              tenantId,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              [contact.contactID!],
              undefined,
              undefined,
              false,
              undefined,
              undefined,
              true
            ),
            {
              operation: "getInvoices",
              resourceType: "INVOICE",
              workflow: "findDuplicateContacts",
              context: `findDuplicateContacts getInvoices(full ${contact.contactID})`,
            }
          );
          invoiceCount = fullResponse.body.invoices?.length ?? 0;
        }
      } catch (err) {
        if (err instanceof XeroDailyLimitError) {
          throw err;
        }
        // If invoice fetch fails, just show 0
      }

      groupContacts.push({
        contactID: contact.contactID!,
        name: contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
        firstName: contact.firstName || undefined,
        lastName: contact.lastName || undefined,
        emailAddress: email,
        hasInvoices: invoiceCount > 0,
        invoiceCount,
        contactStatus: contact.contactStatus?.toString() || "ACTIVE",
        updatedDateUTC: contact.updatedDateUTC?.toString(),
        xeroLink: xeroContactLink(contact.contactID!),
      });
    }

    // Sort: contacts with invoices first, then by invoice count desc
    groupContacts.sort((a, b) => {
      if (a.hasInvoices !== b.hasInvoices) return a.hasInvoices ? -1 : 1;
      return b.invoiceCount - a.invoiceCount;
    });

    duplicateGroups.push({
      email,
      contacts: groupContacts,
      canCreateFamilyGroup: false,
      eligibleMemberIds: [],
    });
  }

  // Look up members for all contacts — used for both family group filtering (#17)
  // and enrichment (#18)
  const allContactIds = duplicateGroups.flatMap((g) =>
    g.contacts.map((c) => c.contactID)
  );

  let filteredByFamilyGroup = 0;

  if (allContactIds.length > 0) {
    const membersWithGroups = await prisma.member.findMany({
      where: { xeroContactId: { in: allContactIds } },
      select: {
        id: true,
        xeroContactId: true,
        firstName: true,
        lastName: true,
        active: true,
        canLogin: true,
        familyGroupMemberships: { select: { familyGroupId: true } },
      },
    });

    const contactToGroupIds = new Map<string, Set<string>>();
    const contactToMember = new Map<string, {
      id: string; firstName: string; lastName: string;
      active: boolean; canLogin: boolean;
    }>();
    for (const m of membersWithGroups) {
      if (m.xeroContactId) {
        contactToGroupIds.set(
          m.xeroContactId,
          new Set(m.familyGroupMemberships.map((fg) => fg.familyGroupId))
        );
        contactToMember.set(m.xeroContactId, {
          id: m.id,
          firstName: m.firstName,
          lastName: m.lastName,
          active: m.active,
          canLogin: m.canLogin,
        });
      }
    }

    // Filter out groups where all contacts share a common family group (#17)
    const beforeCount = duplicateGroups.length;
    const filtered = duplicateGroups.filter((group) => {
      const groupSets = group.contacts.map((c) =>
        contactToGroupIds.get(c.contactID)
      );
      if (groupSets.some((s) => !s || s.size === 0)) return true;
      const intersection = groupSets.reduce((acc, curr) => {
        const result = new Set<string>();
        for (const id of acc!) {
          if (curr!.has(id)) result.add(id);
        }
        return result;
      })!;
      if (intersection.size > 0) return false;
      return true;
    });
    filteredByFamilyGroup = beforeCount - filtered.length;
    duplicateGroups.length = 0;
    duplicateGroups.push(...filtered);

    // Enrich remaining groups with member info (#18)
    for (const group of duplicateGroups) {
      for (const contact of group.contacts) {
        const member = contactToMember.get(contact.contactID);
        if (member) {
          contact.memberId = member.id;
          contact.memberActive = member.active;
        }
      }

      const eligibleMembers = group.contacts
        .map((c) => contactToMember.get(c.contactID))
        .filter((m): m is NonNullable<typeof m> => !!m && m.canLogin);

      group.eligibleMemberIds = eligibleMembers.map((m) => m.id);
      group.canCreateFamilyGroup = eligibleMembers.length >= 2;

      if (group.canCreateFamilyGroup) {
        const lastNames = [...new Set(eligibleMembers.map((m) => m.lastName))];
        if (lastNames.length === 1) {
          group.suggestedGroupName = `${lastNames[0]} Family`;
        }
      }
    }
  }

  // Sort groups by email
  duplicateGroups.sort((a, b) => a.email.localeCompare(b.email));

  return {
    duplicateGroups,
    totalContacts: allContacts.length,
    totalDuplicateEmails: duplicateEmails.length,
    filteredByFamilyGroup,
  };
}
