/**
 * Xero Integration Library
 *
 * Handles OAuth2 flow, token management, invoice creation, credit notes,
 * contact sync, and membership subscription verification.
 */

import { XeroClient, Contact, Invoice, LineItem, LineAmountTypes, CreditNote, Payment as XeroPayment, Phone } from "xero-node";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { prisma } from "./prisma";
import { getSeasonYear, getStayNights } from "./pricing";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.transactions",
  "accounting.contacts",
  "accounting.settings",
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
      console.error("[Xero] Token refresh failed:", err);
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
    const response = await xero.accountingApi.getContacts(
      tenantId,
      undefined, // ifModifiedSince
      undefined, // where
      undefined, // order
      undefined, // iDs
      page,
      false // includeArchived
    );

    const contacts = response.body.contacts ?? [];
    if (contacts.length === 0) {
      hasMore = false;
      break;
    }

    total += contacts.length;

    for (const contact of contacts) {
      if (!contact.emailAddress || !contact.contactID) continue;

      const member = await prisma.member.findUnique({
        where: { email: contact.emailAddress.toLowerCase() },
      });

      if (member) {
        matched++;
        if (member.xeroContactId !== contact.contactID) {
          await prisma.member.update({
            where: { id: member.id },
            data: { xeroContactId: contact.contactID },
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
  status: "PAID" | "UNPAID" | "OVERDUE";
  xeroInvoiceId?: string;
  paidAt?: Date;
}> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
  });
  if (!member) throw new Error(`Member not found: ${memberId}`);
  if (!member.xeroContactId) {
    return { status: "UNPAID" };
  }

  const year = seasonYear ?? getSeasonYear(new Date());
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Fetch invoices for this contact
  const response = await xero.accountingApi.getInvoices(
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
  );

  const invoices = response.body.invoices ?? [];

  // Look for subscription invoices matching the season year
  const subscriptionInvoice = findSubscriptionInvoice(invoices, year);

  if (!subscriptionInvoice) {
    return { status: "UNPAID" };
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
  seasonYear: number
): Invoice | null {
  const keywords = ["subscription", "membership", "annual sub", "club sub"];
  const seasonStart = new Date(seasonYear, 3, 1); // April 1
  const seasonEndExclusive = new Date(seasonYear + 1, 3, 1); // April 1 next year (exclusive)

  for (const invoice of invoices) {
    // Check if invoice date falls within the season year [seasonStart, seasonEndExclusive)
    const invoiceDate = invoice.date ? new Date(invoice.date) : null;
    if (!invoiceDate) continue;

    if (invoiceDate < seasonStart || invoiceDate >= seasonEndExclusive) continue;

    // Check if any line item references a subscription
    const hasSubscriptionRef = invoice.lineItems?.some((li) => {
      const desc = (li.description ?? "").toLowerCase();
      return keywords.some((kw) => desc.includes(kw));
    });

    // Also check invoice reference field
    const ref = (invoice.reference ?? "").toLowerCase();
    const hasRefMatch = keywords.some((kw) => ref.includes(kw));

    if (hasSubscriptionRef || hasRefMatch) {
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
}> {
  const members = await prisma.member.findMany({
    where: { active: true, xeroContactId: { not: null } },
    select: { id: true },
  });

  let checked = 0;
  let updated = 0;
  let errors = 0;

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
    } catch {
      errors++;
    }
  }

  return { checked, updated, errors };
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
  nights: number
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
      accountCode: "200", // Default sales account code
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
    nights
  );

  // Add discount line if applicable
  if (booking.discountCents > 0) {
    lineItems.push({
      description: "Discount",
      quantity: 1,
      unitAmount: -(booking.discountCents / 100),
      accountCode: "200",
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
      account: { code: "090" }, // Default bank account code
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
        accountCode: "200",
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
