/**
 * Xero Integration Library
 *
 * Handles OAuth2 flow, token management, invoice creation, credit notes,
 * contact sync, and membership subscription verification.
 */

import { XeroClient, Contact, ContactGroup, Invoice, LineItem, LineAmountTypes, CreditNote, Payment as XeroPayment, Phone } from "xero-node";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { prisma } from "./prisma";
import { sendPasswordResetEmail } from "./email";
import { AgeTier } from "@prisma/client";
import { getSeasonYear, getStayNights } from "./pricing";
import logger from "@/lib/logger";

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments",
  "accounting.settings.read",
  "offline_access",
];

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Xero tokens expire after 30 minutes; refresh 5 minutes early
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Encryption helpers (for token storage at rest)
// ---------------------------------------------------------------------------

function getEncryptionKey(): Buffer {
  const key = process.env.XERO_ENCRYPTION_KEY;
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

function getXeroConfig() {
  return {
    clientId: process.env.XERO_CLIENT_ID || "",
    clientSecret: process.env.XERO_CLIENT_SECRET || "",
    redirectUris: [process.env.XERO_REDIRECT_URI || "http://localhost:3000/api/admin/xero/callback"],
    scopes: XERO_SCOPES,
  };
}

export function createXeroClient(): XeroClient {
  return new XeroClient(getXeroConfig());
}

/**
 * Build the Xero OAuth2 consent URL for admin to connect.
 */
export async function getXeroConsentUrl(): Promise<string> {
  const xero = createXeroClient();
  await xero.initialize();
  return xero.buildConsentUrl();
}

/**
 * Handle the OAuth2 callback from Xero.
 * Exchanges the authorization code for tokens and stores them encrypted.
 */
export async function handleXeroCallback(url: string): Promise<void> {
  const xero = createXeroClient();
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

  // Upsert: we only keep a single row in XeroToken
  const existing = await prisma.xeroToken.findFirst();
  if (existing) {
    await prisma.xeroToken.update({
      where: { id: existing.id },
      data: {
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        expiresAt: tokens.expiresAt,
        tenantId: tokens.tenantId ?? existing.tenantId,
      },
    });
  } else {
    await prisma.xeroToken.create({
      data: {
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        expiresAt: tokens.expiresAt,
        tenantId: tokens.tenantId ?? null,
      },
    });
  }
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

/**
 * Read a Xero account code from the DB, falling back to the hard-coded default.
 * Returns null for unconfigured optional mappings (e.g. stripeFees).
 */
export async function getAccountMapping(key: string): Promise<string | null> {
  try {
    const mapping = await prisma.xeroAccountMapping.findUnique({
      where: { key },
      select: { code: true },
    });
    if (mapping?.code) {
      return mapping.code;
    }
  } catch {
    // DB not available — fall through to default
  }
  return ACCOUNT_MAPPING_DEFAULTS[key] ?? null;
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

/**
 * Get an authenticated XeroClient with valid tokens.
 * Automatically refreshes if token is about to expire.
 */
export async function getAuthenticatedXeroClient(): Promise<{
  xero: XeroClient;
  tenantId: string;
}> {
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
    // Token expired or about to expire - refresh it
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

      return { xero, tenantId: tokens.tenantId };
    } catch (err) {
      logger.error({ err }, "Xero token refresh failed");
      // N-05: Fire-and-forget Xero error alert
      import("./xero-error-alert").then(({ notifyXeroSyncError }) =>
        notifyXeroSyncError({
          errorType: "Token Refresh Failure",
          operation: "getAuthenticatedXeroClient",
          errorMessage: err instanceof Error ? err.message : String(err),
        })
      ).catch(() => {});
      throw new Error("Xero token refresh failed. Please reconnect Xero via the admin panel.");
    }
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
export async function findOrCreateXeroContact(memberId: string): Promise<string> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
  });
  if (!member) throw new Error(`Member not found: ${memberId}`);

  // If member already has a Xero contact linked, verify it exists
  if (member.xeroContactId) {
    try {
      const { xero, tenantId } = await getAuthenticatedXeroClient();
      await xero.accountingApi.getContact(tenantId, member.xeroContactId);
      return member.xeroContactId;
    } catch {
      // Contact not found in Xero, will create a new one
    }
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Search by email first
  try {
    const contactsResponse = await xero.accountingApi.getContacts(
      tenantId,
      undefined, // ifModifiedSince
      `EmailAddress="${member.email}"` // where
    );
    const contacts = contactsResponse.body.contacts;
    if (contacts && contacts.length > 0) {
      const contactId = contacts[0].contactID!;
      await prisma.member.update({
        where: { id: memberId },
        data: { xeroContactId: contactId },
      });
      return contactId;
    }
  } catch {
    // Search failed, will create new contact
  }

  // Create new contact
  const contact: Contact = {
    name: `${member.firstName} ${member.lastName}`,
    firstName: member.firstName,
    lastName: member.lastName,
    emailAddress: member.email,
    phones: member.phone
      ? [{ phoneType: Phone.PhoneTypeEnum.MOBILE, phoneNumber: member.phone }]
      : [],
  };

  const response = await xero.accountingApi.createContacts(tenantId, { contacts: [contact] });
  const createdContact = response.body.contacts?.[0];
  if (!createdContact?.contactID) {
    throw new Error("Failed to create Xero contact");
  }

  await prisma.member.update({
    where: { id: memberId },
    data: { xeroContactId: createdContact.contactID },
  });

  return createdContact.contactID;
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
    const response = await withXeroRetry(
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
      { context: `getContactFirstInvoiceDate(${contactID})` }
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

/**
 * Retry wrapper for Xero API calls with 429 rate-limit handling.
 * - On daily limit: throws XeroDailyLimitError immediately (no point waiting hours).
 * - On minute/app limit: waits Retry-After seconds (capped at maxWaitSec) and retries.
 * - Non-429 errors pass through unchanged.
 */
export async function withXeroRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; maxWaitSec?: number; context?: string }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const maxWaitSec = options?.maxWaitSec ?? 120;
  const context = options?.context ?? "Xero API call";

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const statusCode = (err as { response?: { statusCode?: number } })?.response?.statusCode;
      if (statusCode !== 429) throw err;

      const headers = (err as { response?: { headers?: Record<string, string> } })?.response?.headers;
      const retryAfter = headers?.["retry-after"];
      const rateLimitProblem = headers?.["x-rate-limit-problem"];

      // Daily limit — abort immediately, no point retrying for hours
      if (rateLimitProblem === "day") {
        const retryAfterSec = parseInt(retryAfter || "86400", 10);
        throw new XeroDailyLimitError(retryAfterSec);
      }

      // Minute/app limit — retry if we have attempts left
      if (attempt < maxRetries) {
        const waitSec = Math.min(parseInt(retryAfter || "30", 10), maxWaitSec);
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
export async function syncContactsFromXero(): Promise<{
  total: number;
  matched: number;
  updated: number;
}> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  let page = 1;
  let total = 0;
  let matched = 0;
  let updated = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await withXeroRetry(
      () => xero.accountingApi.getContacts(
        tenantId,
        undefined, // ifModifiedSince
        undefined, // where
        undefined, // order
        undefined, // iDs
        page,
        false // includeArchived
      ),
      { context: `syncContacts getContacts(page ${page})` }
    );

    const contacts = response.body.contacts ?? [];
    if (contacts.length === 0) {
      hasMore = false;
      break;
    }

    total += contacts.length;

    for (const contact of contacts) {
      if (!contact.contactID) continue;

      // First check if already linked by xeroContactId
      const alreadyLinked = await prisma.member.findFirst({
        where: { xeroContactId: contact.contactID },
      });
      if (alreadyLinked) {
        matched++;
        // Backfill joinedDate if missing
        if (!alreadyLinked.joinedDate) {
          const invoiceDate = await getContactFirstInvoiceDate(xero, tenantId, contact.contactID);
          if (invoiceDate) {
            await prisma.member.update({
              where: { id: alreadyLinked.id },
              data: { joinedDate: invoiceDate },
            });
          }
          await throttle(1500);
        }
        continue;
      }

      // Fall back to email matching (primary members only)
      if (!contact.emailAddress) continue;
      const member = await prisma.member.findFirst({
        where: { email: contact.emailAddress.toLowerCase(), parentMemberId: null },
      });

      if (member) {
        matched++;
        const updateData: Record<string, unknown> = {};
        if (member.xeroContactId !== contact.contactID) {
          updateData.xeroContactId = contact.contactID;
        }
        // Populate joinedDate from first invoice
        if (!member.joinedDate) {
          const invoiceDate = await getContactFirstInvoiceDate(xero, tenantId, contact.contactID);
          if (invoiceDate) {
            updateData.joinedDate = invoiceDate;
          }
          await throttle(1500);
        }
        if (Object.keys(updateData).length > 0) {
          await prisma.member.update({
            where: { id: member.id },
            data: updateData,
          });
          updated++;
        }
      }
    }

    page++;
    // Xero returns up to 100 per page
    if (contacts.length < 100) {
      hasMore = false;
    }
  }

  return { total, matched, updated };
}

// ---------------------------------------------------------------------------
// Contact group import (Xero -> TAC)
// ---------------------------------------------------------------------------

/**
 * Fetch all contact groups from Xero for the admin UI to display.
 */
export async function getXeroContactGroups(): Promise<
  Array<{ id: string; name: string; contactCount: number }>
> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await withXeroRetry(
    () => xero.accountingApi.getContactGroups(tenantId),
    { context: "getXeroContactGroups" }
  );
  const groups = (response.body.contactGroups ?? []).filter(
    (g) => g.contactGroupID && g.name && g.status === ContactGroup.StatusEnum.ACTIVE
  );

  // The list endpoint doesn't populate contacts, so fetch each group
  // individually to get the real contact count.
  const results: Array<{ id: string; name: string; contactCount: number }> = [];
  for (const g of groups) {
    try {
      const detail = await withXeroRetry(
        () => xero.accountingApi.getContactGroup(tenantId, g.contactGroupID!),
        { context: `getContactGroup(${g.name})` }
      );
      const contacts = detail.body.contactGroups?.[0]?.contacts ?? [];
      results.push({
        id: g.contactGroupID!,
        name: g.name!,
        contactCount: contacts.length,
      });
    } catch (err) {
      // Let daily limit errors propagate
      if (err instanceof XeroDailyLimitError) throw err;
      // If fetching detail fails, still include the group with 0
      results.push({
        id: g.contactGroupID!,
        name: g.name!,
        contactCount: 0,
      });
    }
  }

  return results;
}

/**
 * Assemble a full phone number from Xero's split fields (countryCode, areaCode, number).
 * e.g. countryCode="64", areaCode="27", number="4224115" → "+64 27 4224115"
 */
function formatXeroPhone(phone: { phoneCountryCode?: string; phoneAreaCode?: string; phoneNumber?: string }): string | null {
  if (!phone.phoneNumber) return null;
  const parts: string[] = [];
  if (phone.phoneCountryCode) parts.push(`+${phone.phoneCountryCode.replace(/^\+/, '')}`);
  if (phone.phoneAreaCode) parts.push(phone.phoneAreaCode);
  parts.push(phone.phoneNumber);
  return parts.join(' ');
}

/**
 * Find the best phone number from a Xero contact's phones array.
 * Prefers MOBILE, falls back to any phone with a number.
 */
function getXeroContactPhone(phones?: Array<{ phoneType?: Phone.PhoneTypeEnum; phoneCountryCode?: string; phoneAreaCode?: string; phoneNumber?: string }>): string | null {
  if (!phones) return null;
  const mobile = phones.find((p) => p.phoneNumber && p.phoneType === Phone.PhoneTypeEnum.MOBILE);
  if (mobile) return formatXeroPhone(mobile);
  const any = phones.find((p) => p.phoneNumber);
  if (any) return formatXeroPhone(any);
  return null;
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
  sendInvites: boolean
): Promise<{
  created: number;
  createdAsDependent: number;
  skippedExisting: number;
  linkedExisting: number;
  skippedNoEmail: number;
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
  groupsProcessed: string[];
}> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  let created = 0;
  let createdAsDependent = 0;
  let skippedExisting = 0;
  let linkedExisting = 0;
  let skippedNoEmail = 0;
  let errors = 0;
  const errorDetails: Array<{ member: string; error: string }> = [];
  const groupsProcessed: string[] = [];

  // Hash a random UUID — unguessable placeholder password
  const placeholderHash = await hash(randomBytes(32).toString("hex"), 13);

  for (const mapping of groupMappings) {
    try {
      // Get contact IDs from the group
      const response = await withXeroRetry(
        () => xero.accountingApi.getContactGroup(tenantId, mapping.groupId),
        { context: `getContactGroup(${mapping.groupName})` }
      );
      const groupContacts = response.body.contactGroups?.[0]?.contacts ?? [];
      groupsProcessed.push(mapping.groupName);

      // The group endpoint only returns summary data (IDs/names, no emails).
      // Fetch full contact details in batches using the IDs filter.
      const contactIds = groupContacts
        .map((c) => c.contactID)
        .filter(Boolean) as string[];

      const contacts: Contact[] = [];
      // Xero supports filtering by up to ~50 IDs at a time via the IDs param
      const batchSize = 50;
      for (let i = 0; i < contactIds.length; i += batchSize) {
        const batch = contactIds.slice(i, i + batchSize);
        const fullResponse = await withXeroRetry(
          () => xero.accountingApi.getContacts(
            tenantId,
            undefined, // ifModifiedSince
            undefined, // where
            undefined, // order
            batch       // iDs
          ),
          { context: `getContacts(batch ${Math.floor(i / batchSize) + 1})` }
        );
        contacts.push(...(fullResponse.body.contacts ?? []));
      }

      logger.info({ groupName: mapping.groupName, groupContactCount: groupContacts.length, fetchedCount: contacts.length }, "Fetched group contacts for import");

      for (const contact of contacts) {
        try {
          if (!contact.emailAddress) {
            skippedNoEmail++;
            continue;
          }

          const email = contact.emailAddress.toLowerCase().trim();

          // Check if this Xero contact is already linked to any member
          if (contact.contactID) {
            const alreadyLinked = await prisma.member.findFirst({
              where: { xeroContactId: contact.contactID },
            });
            if (alreadyLinked) {
              skippedExisting++;
              continue;
            }
          }

          // Find the primary account holder with this email
          const existingPrimary = await prisma.member.findFirst({
            where: { email, parentMemberId: null },
          });

          if (existingPrimary) {
            // Check if this is the same person (name match) or a family dependent
            const contactFirstName = (contact.firstName || "").toLowerCase().trim();
            const contactLastName = (contact.lastName || "").toLowerCase().trim();
            const primaryFirstName = existingPrimary.firstName.toLowerCase().trim();
            const primaryLastName = existingPrimary.lastName.toLowerCase().trim();

            const isSamePerson =
              (contactFirstName === primaryFirstName && contactLastName === primaryLastName) ||
              (!contactFirstName && !contactLastName); // No name data — assume same person

            if (isSamePerson) {
              skippedExisting++;
              // Link xeroContactId and backfill DOB/phone/joinedDate if missing
              const updates: Record<string, unknown> = {};
              if (!existingPrimary.xeroContactId && contact.contactID) {
                updates.xeroContactId = contact.contactID;
              }
              if (!existingPrimary.dateOfBirth && contact.companyNumber) {
                const dobMatch = contact.companyNumber.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
                if (dobMatch) {
                  const parsed = new Date(`${dobMatch[3]}-${dobMatch[2]}-${dobMatch[1]}T00:00:00`);
                  if (!isNaN(parsed.getTime())) {
                    updates.dateOfBirth = parsed;
                  }
                }
              }
              if (!existingPrimary.phone) {
                const phone = getXeroContactPhone(contact.phones);
                if (phone) updates.phone = phone;
              }
              // Backfill joinedDate from first invoice
              if (!existingPrimary.joinedDate && contact.contactID) {
                const invoiceDate = await getContactFirstInvoiceDate(xero, tenantId, contact.contactID);
                if (invoiceDate) updates.joinedDate = invoiceDate;
                await throttle(1500);
              }
              if (Object.keys(updates).length > 0) {
                await prisma.member.update({
                  where: { id: existingPrimary.id },
                  data: updates,
                });
                if (updates.xeroContactId) linkedExisting++;
              }
              continue;
            }

            // Also check if this contact already exists as a dependent
            const existingDependent = await prisma.member.findFirst({
              where: {
                email,
                parentMemberId: existingPrimary.id,
                firstName: { equals: contact.firstName || "Unknown", mode: "insensitive" },
                lastName: { equals: contact.lastName || "Unknown", mode: "insensitive" },
              },
            });
            if (existingDependent) {
              skippedExisting++;
              // Link xeroContactId if missing
              if (!existingDependent.xeroContactId && contact.contactID) {
                await prisma.member.update({
                  where: { id: existingDependent.id },
                  data: { xeroContactId: contact.contactID },
                });
                linkedExisting++;
              }
              continue;
            }

            // Different name — create as dependent of the primary account
            let depFirstName = contact.firstName || "";
            let depLastName = contact.lastName || "";
            if (!depFirstName && !depLastName && contact.name) {
              const parts = contact.name.trim().split(/\s+/);
              depFirstName = parts[0] || "Unknown";
              depLastName = parts.slice(1).join(" ") || "Unknown";
            }
            if (!depFirstName) depFirstName = "Unknown";
            if (!depLastName) depLastName = "Unknown";

            let depDob: Date | null = null;
            if (contact.companyNumber) {
              const match = contact.companyNumber.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
              if (match) {
                const [, dd, mm, yyyy] = match;
                const parsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
                if (!isNaN(parsed.getTime())) {
                  depDob = parsed;
                }
              }
            }

            await prisma.member.create({
              data: {
                email,
                firstName: depFirstName,
                lastName: depLastName,
                passwordHash: placeholderHash,
                ageTier: mapping.ageTier,
                dateOfBirth: depDob,
                xeroContactId: contact.contactID || null,
                phone: getXeroContactPhone(contact.phones),
                active: true,
                emailVerified: true, // Dependents don't need email verification
                parentMemberId: existingPrimary.id,
              },
            });

            createdAsDependent++;
            continue;
          }

          // Parse name — Xero may have firstName/lastName or just name
          let firstName = contact.firstName || "";
          let lastName = contact.lastName || "";
          if (!firstName && !lastName && contact.name) {
            const parts = contact.name.trim().split(/\s+/);
            firstName = parts[0] || "Unknown";
            lastName = parts.slice(1).join(" ") || "Unknown";
          }
          if (!firstName) firstName = "Unknown";
          if (!lastName) lastName = "Unknown";

          // Parse DOB from Xero's companyNumber (NZBN) field — format dd/mm/yyyy
          let dateOfBirth: Date | null = null;
          if (contact.companyNumber) {
            const match = contact.companyNumber.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            if (match) {
              const [, dd, mm, yyyy] = match;
              const parsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
              if (!isNaN(parsed.getTime())) {
                dateOfBirth = parsed;
              }
            }
          }

          // Fetch joined date from first invoice before creating
          let memberJoinedDate: Date | null = null;
          if (contact.contactID) {
            memberJoinedDate = await getContactFirstInvoiceDate(xero, tenantId, contact.contactID);
            await throttle(1500);
          }

          // Create member
          const member = await prisma.member.create({
            data: {
              email,
              firstName,
              lastName,
              passwordHash: placeholderHash,
              ageTier: mapping.ageTier,
              dateOfBirth,
              xeroContactId: contact.contactID || null,
              phone: getXeroContactPhone(contact.phones),
              active: true,
              joinedDate: memberJoinedDate,
            },
          });

          created++;

          // Optionally send invite email
          if (sendInvites) {
            try {
              const token = randomBytes(32).toString("hex");
              const expiresAt = new Date(
                Date.now() + 7 * 24 * 60 * 60 * 1000
              ); // 7 days

              await prisma.passwordResetToken.create({
                data: {
                  token,
                  memberId: member.id,
                  expiresAt,
                },
              });

              // Fire-and-forget
              sendPasswordResetEmail(member.email, token).catch((err) => {
                logger.error({ err, email: member.email }, "Failed to send invite email during member import");
              });
            } catch (emailErr) {
              logger.error({ err: emailErr, email: member.email }, "Failed to create invite token during member import");
            }
          }
        } catch (contactErr) {
          // Abort entire import on daily limit — no point continuing
          if (contactErr instanceof XeroDailyLimitError) throw contactErr;
          logger.error({ err: contactErr, contactEmail: contact.emailAddress }, "Error processing contact during member import");
          errors++;
          const contactLabel = contact.name ||
            [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
            contact.emailAddress ||
            contact.contactID ||
            "Unknown contact";
          errorDetails.push({ member: contactLabel, error: parseXeroError(contactErr) });
        }
      }
    } catch (groupErr) {
      // Abort entire import on daily limit — no point continuing
      if (groupErr instanceof XeroDailyLimitError) throw groupErr;
      logger.error({ err: groupErr, groupName: mapping.groupName }, "Error fetching group during member import");
      errors++;
      errorDetails.push({ member: `Group: ${mapping.groupName}`, error: parseXeroError(groupErr) });
    }
  }

  return {
    created,
    createdAsDependent,
    skippedExisting,
    linkedExisting,
    skippedNoEmail,
    errors,
    errorDetails,
    groupsProcessed,
  };
}

// ---------------------------------------------------------------------------
// Contact update (TAC -> Xero)
// ---------------------------------------------------------------------------

/**
 * Update a Xero contact's details when a member is edited in TACBookings.
 */
export async function updateXeroContact(
  xeroContactId: string,
  data: { firstName: string; lastName: string; email: string; phone?: string | null }
): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  const contact: Contact = {
    contactID: xeroContactId,
    name: `${data.firstName} ${data.lastName}`,
    firstName: data.firstName,
    lastName: data.lastName,
    emailAddress: data.email,
    phones: data.phone
      ? [{ phoneType: Phone.PhoneTypeEnum.MOBILE, phoneNumber: data.phone }]
      : [],
  };

  await xero.accountingApi.updateContact(tenantId, xeroContactId, { contacts: [contact] });
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
export async function checkMembershipStatus(
  memberId: string,
  seasonYear?: number
): Promise<{
  status: "PAID" | "UNPAID" | "OVERDUE" | "NOT_INVOICED";
  xeroInvoiceId?: string;
  paidAt?: Date;
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

  // Fetch invoices for this contact (with retry on 429 rate limit)
  const response = await withXeroRetry(
    () => xero.accountingApi.getInvoices(
      tenantId,
      undefined, // ifModifiedSince
      `Contact.ContactID=guid("${member.xeroContactId}")`, // where
      undefined, // order
      undefined, // iDs
      undefined, // invoiceNumbers
      undefined, // contactIDs
      undefined, // statuses
      1, // page
      false // includeArchived
    ),
    { context: `checkMembershipStatus(${memberId})` }
  );

  const invoices = response.body.invoices ?? [];

  // Look for subscription invoices matching the season year
  const subscriptionAccountCode = await getAccountMapping("subscriptionIncome") ?? "203";
  const subscriptionInvoice = findSubscriptionInvoice(invoices, year, subscriptionAccountCode);

  if (!subscriptionInvoice) {
    return { status: "NOT_INVOICED" };
  }

  const status = determineSubscriptionStatus(subscriptionInvoice);

  // Update local MemberSubscription record
  await prisma.memberSubscription.upsert({
    where: {
      memberId_seasonYear: { memberId, seasonYear: year },
    },
    update: {
      status: status.status,
      xeroInvoiceId: subscriptionInvoice.invoiceID,
      paidAt: status.paidAt,
    },
    create: {
      memberId,
      seasonYear: year,
      status: status.status,
      xeroInvoiceId: subscriptionInvoice.invoiceID,
      paidAt: status.paidAt,
    },
  });

  return {
    status: status.status,
    xeroInvoiceId: subscriptionInvoice.invoiceID ?? undefined,
    paidAt: status.paidAt,
  };
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
export async function refreshAllMembershipStatuses(): Promise<{
  checked: number;
  updated: number;
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
}> {
  const members = await prisma.member.findMany({
    where: { active: true, xeroContactId: { not: null } },
    select: { id: true, email: true, firstName: true, lastName: true },
  });

  let checked = 0;
  let updated = 0;
  let errors = 0;
  const errorDetails: Array<{ member: string; error: string }> = [];

  // Throttle to ~50 requests/minute to stay under Xero's 60/min limit
  const THROTTLE_MS = 1200;

  for (const member of members) {
    try {
      const before = await prisma.memberSubscription.findFirst({
        where: { memberId: member.id, seasonYear: getSeasonYear(new Date()) },
      });
      const result = await checkMembershipStatus(member.id);
      checked++;
      if (!before || before.status !== result.status) {
        updated++;
      }
    } catch (err) {
      errors++;
      const memberLabel = `${member.firstName} ${member.lastName} (${member.email})`;
      errorDetails.push({ member: memberLabel, error: parseXeroError(err) });
    }
    // Throttle between requests to avoid Xero rate limits
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  return { checked, updated, errors, errorDetails };
}

// ---------------------------------------------------------------------------
// Invoice creation (TAC -> Xero)
// ---------------------------------------------------------------------------

/**
 * Build Xero invoice line items from a booking's guests and stay nights.
 * Exported for testing.
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
  accountCode: string = "200"
): LineItem[] {
  return guests.map((guest) => {
    const perNightCents = nights > 0 ? Math.round(guest.priceCents / nights) : guest.priceCents;
    const description = [
      `${guest.firstName} ${guest.lastName}`,
      `(${guest.ageTier}${guest.isMember ? ", Member" : ", Non-member"})`,
      `${nights} night${nights !== 1 ? "s" : ""}`,
      `${formatDate(checkIn)} - ${formatDate(checkOut)}`,
    ].join(" - ");

    return {
      description,
      quantity: nights,
      unitAmount: perNightCents / 100, // Xero uses dollars, not cents
      accountCode,
      taxType: "OUTPUT2", // GST on Income (NZ)
    };
  });
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Create a Xero invoice for a confirmed booking.
 * This is the main function that other phases should call after booking confirmation.
 *
 * @param bookingId - The booking to create an invoice for
 * @returns The Xero invoice ID
 */
export async function createXeroInvoiceForBooking(bookingId: string): Promise<string> {
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
    return booking.payment.xeroInvoiceId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  const contactId = await findOrCreateXeroContact(booking.memberId);

  // Resolve account codes from DB (with fallback to defaults)
  const [hutFeesIncomeCode, stripeBankCode] = await Promise.all([
    getAccountMapping("hutFeesIncome"),
    getAccountMapping("stripeBankAccount"),
  ]);
  const incomeCode = hutFeesIncomeCode ?? "200";
  const bankCode = stripeBankCode ?? "606";

  // Calculate nights using the same logic as the pricing engine
  const checkIn = new Date(booking.checkIn);
  const checkOut = new Date(booking.checkOut);
  const nights = getStayNights(checkIn, checkOut).length;

  // Build line items
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
    incomeCode
  );

  // Add discount line if applicable
  if (booking.discountCents > 0) {
    lineItems.push({
      description: "Discount",
      quantity: 1,
      unitAmount: -(booking.discountCents / 100),
      accountCode: incomeCode,
      taxType: "OUTPUT2",
    });
  }

  // Create the invoice
  const invoice: Invoice = {
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: contactId },
    lineItems,
    date: formatDate(new Date()),
    dueDate: formatDate(new Date()), // Already paid
    reference: `Booking ${bookingId.slice(0, 8)}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  };

  const response = await xero.accountingApi.createInvoices(tenantId, {
    invoices: [invoice],
  });

  const createdInvoice = response.body.invoices?.[0];
  if (!createdInvoice?.invoiceID) {
    throw new Error("Failed to create Xero invoice");
  }

  // Record payment against the invoice in Xero
  if (booking.payment.status === "SUCCEEDED" && booking.payment.amountCents > 0) {
    const payment: XeroPayment = {
      invoice: { invoiceID: createdInvoice.invoiceID },
      account: { code: bankCode },
      amount: booking.payment.amountCents / 100,
      date: formatDate(new Date()),
      reference: `Stripe ${booking.payment.stripePaymentIntentId ?? "payment"}`,
    };

    await xero.accountingApi.createPayment(tenantId, payment);
  }

  // Store the Xero invoice ID on the payment record
  await prisma.payment.update({
    where: { id: booking.payment.id },
    data: { xeroInvoiceId: createdInvoice.invoiceID },
  });

  return createdInvoice.invoiceID;
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
  refundAmountCents: number
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

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  const contactId = await findOrCreateXeroContact(payment.booking.memberId);
  const refundCode = (await getAccountMapping("hutFeeRefunds")) ?? "200";

  const creditNote: CreditNote = {
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: contactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [
      {
        description: `Refund for booking ${payment.booking.id.slice(0, 8)} (${formatDate(new Date(payment.booking.checkIn))} - ${formatDate(new Date(payment.booking.checkOut))})`,
        quantity: 1,
        unitAmount: refundAmountCents / 100,
        accountCode: refundCode,
        taxType: "OUTPUT2",
      },
    ],
    reference: `Refund - Booking ${payment.booking.id.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  };

  const response = await xero.accountingApi.createCreditNotes(tenantId, {
    creditNotes: [creditNote],
  });

  const createdNote = response.body.creditNotes?.[0];
  if (!createdNote?.creditNoteID) {
    throw new Error("Failed to create Xero credit note");
  }

  // Allocate credit note against the original invoice
  await xero.accountingApi.createCreditNoteAllocation(
    tenantId,
    createdNote.creditNoteID,
    {
      allocations: [
        {
          invoice: { invoiceID: payment.xeroInvoiceId },
          amount: refundAmountCents / 100,
          date: formatDate(new Date()),
        },
      ],
    }
  );

  return createdNote.creditNoteID;
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
}): Promise<string | null> {
  const { bookingId, priceDiffCents, changeFeeCents } = params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking?.payment?.xeroInvoiceId) {
    // No Xero invoice exists — nothing to adjust
    return null;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(booking.memberId);
  const incomeCode = (await getAccountMapping("hutFeesIncome")) ?? "200";

  const lineItems: LineItem[] = [];

  if (priceDiffCents > 0) {
    lineItems.push({
      description: `Booking modification - price adjustment (Booking ${bookingId.slice(0, 8)})`,
      quantity: 1,
      unitAmount: priceDiffCents / 100,
      accountCode: incomeCode,
      taxType: "OUTPUT2",
    });
  }

  if (changeFeeCents > 0) {
    lineItems.push({
      description: "Late notice booking change fee",
      quantity: 1,
      unitAmount: changeFeeCents / 100,
      accountCode: incomeCode,
      taxType: "OUTPUT2",
    });
  }

  if (lineItems.length === 0) return null;

  const invoice: Invoice = {
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: contactId },
    lineItems,
    date: formatDate(new Date()),
    dueDate: formatDate(new Date()),
    reference: `Modification - Booking ${bookingId.slice(0, 8)}`,
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Inclusive,
  };

  const response = await xero.accountingApi.createInvoices(tenantId, {
    invoices: [invoice],
  });

  const created = response.body.invoices?.[0];
  if (!created?.invoiceID) {
    throw new Error("Failed to create supplementary Xero invoice");
  }

  return created.invoiceID;
}

/**
 * Create a Xero credit note when a booking modification decreases the price.
 *
 * Fire-and-forget: caller should catch errors and log them.
 */
export async function createXeroCreditNoteForModification(params: {
  bookingId: string;
  refundAmountCents: number;
}): Promise<string | null> {
  const { bookingId, refundAmountCents } = params;

  if (refundAmountCents <= 0) return null;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking?.payment?.xeroInvoiceId) {
    return null;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(booking.memberId);
  const refundCode = (await getAccountMapping("hutFeeRefunds")) ?? "200";

  const creditNote: CreditNote = {
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: contactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [
      {
        description: `Booking modification refund (Booking ${bookingId.slice(0, 8)})`,
        quantity: 1,
        unitAmount: refundAmountCents / 100,
        accountCode: refundCode,
        taxType: "OUTPUT2",
      },
    ],
    reference: `Modification refund - Booking ${bookingId.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  };

  const response = await xero.accountingApi.createCreditNotes(tenantId, {
    creditNotes: [creditNote],
  });

  const created = response.body.creditNotes?.[0];
  if (!created?.creditNoteID) {
    throw new Error("Failed to create modification credit note");
  }

  // Allocate against original invoice
  await xero.accountingApi.createCreditNoteAllocation(
    tenantId,
    created.creditNoteID,
    {
      allocations: [
        {
          invoice: { invoiceID: booking.payment.xeroInvoiceId },
          amount: refundAmountCents / 100,
          date: formatDate(new Date()),
        },
      ],
    }
  );

  return created.creditNoteID;
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
}

export interface DuplicateGroup {
  email: string;
  contacts: DuplicateContact[];
}

/**
 * Scan all Xero contacts, find duplicate emails, and return grouped results
 * with invoice counts and deep links so the admin can merge in Xero UI.
 */
export async function findDuplicateContacts(): Promise<{
  duplicateGroups: DuplicateGroup[];
  totalContacts: number;
  totalDuplicateEmails: number;
}> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Get org shortCode for deep links
  let shortCode = "";
  try {
    const orgResponse = await xero.accountingApi.getOrganisations(tenantId);
    shortCode = orgResponse.body.organisations?.[0]?.shortCode || "";
  } catch {
    // If we can't get shortCode, links will fall back to generic URL
  }

  function xeroContactLink(contactID: string): string {
    if (shortCode) {
      return `https://go.xero.com/organisationlogin/default.aspx?shortcode=${shortCode}&redirecturl=/Contacts/View/${contactID}`;
    }
    return `https://go.xero.com/Contacts/View/${contactID}`;
  }

  // Fetch all contacts, paginated
  const allContacts: Contact[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await xero.accountingApi.getContacts(
      tenantId,
      undefined, // ifModifiedSince
      undefined, // where
      undefined, // order
      undefined, // iDs
      page,
      false      // includeArchived
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
        const invoiceResponse = await xero.accountingApi.getInvoices(
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
        );
        invoiceCount = invoiceResponse.body.invoices?.length ?? 0;
        // If we got 1 result with pageSize 1, there may be more — fetch count properly
        if (invoiceCount > 0) {
          const fullResponse = await xero.accountingApi.getInvoices(
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
          );
          invoiceCount = fullResponse.body.invoices?.length ?? 0;
        }
      } catch {
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

    duplicateGroups.push({ email, contacts: groupContacts });
  }

  // Sort groups by email
  duplicateGroups.sort((a, b) => a.email.localeCompare(b.email));

  return {
    duplicateGroups,
    totalContacts: allContacts.length,
    totalDuplicateEmails: duplicateEmails.length,
  };
}
