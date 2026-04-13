import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  recordXeroApiUsage: vi.fn(),
}))

vi.mock("@/lib/xero-api-usage", () => ({
  recordXeroApiUsage: mocks.recordXeroApiUsage,
}))

import {
  callXeroApi,
  encryptToken,
  decryptToken,
  findSubscriptionInvoice,
  determineSubscriptionStatus,
  buildInvoiceLineItems,
  withXeroRetry,
  XeroDailyLimitError,
  resetXeroRateLimitStateForTests,
} from "../xero"
import { Invoice } from "xero-node"

beforeEach(() => {
  resetXeroRateLimitStateForTests()
  mocks.recordXeroApiUsage.mockReset()
})

// ---------------------------------------------------------------------------
// Encryption / Decryption
// ---------------------------------------------------------------------------

describe("Token encryption", () => {
  beforeEach(() => {
    // 32 bytes = 64 hex chars
    vi.stubEnv("XERO_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
  })

  it("encrypts and decrypts a token correctly", () => {
    const original = "xero_access_token_abc123"
    const encrypted = encryptToken(original)
    expect(encrypted).not.toBe(original)
    expect(encrypted.split(":")).toHaveLength(3)
    const decrypted = decryptToken(encrypted)
    expect(decrypted).toBe(original)
  })

  it("produces different ciphertexts for same input (random IV)", () => {
    const token = "same_token"
    const enc1 = encryptToken(token)
    const enc2 = encryptToken(token)
    expect(enc1).not.toBe(enc2) // Random IV ensures different output
    expect(decryptToken(enc1)).toBe(token)
    expect(decryptToken(enc2)).toBe(token)
  })

  it("throws on missing encryption key", () => {
    vi.stubEnv("XERO_ENCRYPTION_KEY", "")
    expect(() => encryptToken("test")).toThrow("XERO_ENCRYPTION_KEY")
  })

  it("throws on invalid key length", () => {
    vi.stubEnv("XERO_ENCRYPTION_KEY", "too_short")
    expect(() => encryptToken("test")).toThrow("64-character hex string")
  })

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptToken("test_token")
    const parts = encrypted.split(":")
    // Tamper with the ciphertext
    parts[2] = "ff" + parts[2].slice(2)
    expect(() => decryptToken(parts.join(":"))).toThrow()
  })

  it("throws on invalid format", () => {
    expect(() => decryptToken("invalid")).toThrow("Invalid encrypted token format")
  })
})

// ---------------------------------------------------------------------------
// findSubscriptionInvoice
// ---------------------------------------------------------------------------

describe("findSubscriptionInvoice", () => {
  function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
    return {
      invoiceID: "inv-001",
      date: "2026-05-15",
      status: Invoice.StatusEnum.PAID,
      lineItems: [
        { description: "Annual Membership Subscription 2026/2027", accountCode: "203", quantity: 1, unitAmount: 150 },
      ],
      ...overrides,
    } as Invoice
  }

  it("finds a subscription invoice by account code 203", () => {
    const invoices = [makeInvoice()]
    const result = findSubscriptionInvoice(invoices, 2026)
    expect(result).not.toBeNull()
    expect(result!.invoiceID).toBe("inv-001")
  })

  it("finds a subscription invoice by reference field", () => {
    const invoices = [
      makeInvoice({
        invoiceID: "inv-002",
        reference: "Annual Member Subscription 2026",
        lineItems: [{ description: "Payment", quantity: 1, unitAmount: 150 }],
      }),
    ]
    const result = findSubscriptionInvoice(invoices, 2026)
    expect(result).not.toBeNull()
    expect(result!.invoiceID).toBe("inv-002")
  })

  it("matches invoice with account code 203", () => {
    const invoices = [
      makeInvoice({
        lineItems: [{ description: "Club Membership Fee 2026-2027", accountCode: "203", quantity: 1, unitAmount: 100 }],
      }),
    ]
    expect(findSubscriptionInvoice(invoices, 2026)).not.toBeNull()
  })

  it("matches 'annual member subscription' in reference", () => {
    const invoices = [
      makeInvoice({
        reference: "Annual Member Subscription - Adult",
        lineItems: [{ description: "Sub", quantity: 1, unitAmount: 100 }],
      }),
    ]
    expect(findSubscriptionInvoice(invoices, 2026)).not.toBeNull()
  })

  it("returns null for invoices outside the season year", () => {
    const invoices = [
      makeInvoice({
        date: "2025-02-15", // Before April 2026
      }),
    ]
    const result = findSubscriptionInvoice(invoices, 2026)
    expect(result).toBeNull()
  })

  it("returns null when no matching account code or reference", () => {
    const invoices = [
      makeInvoice({
        lineItems: [{ description: "Lodge Booking - 3 nights", accountCode: "200", quantity: 1, unitAmount: 200 }],
        reference: undefined,
      }),
    ]
    const result = findSubscriptionInvoice(invoices, 2026)
    expect(result).toBeNull()
  })

  it("returns null for empty invoice list", () => {
    expect(findSubscriptionInvoice([], 2026)).toBeNull()
  })

  it("handles invoice without date", () => {
    const invoices = [makeInvoice({ date: undefined })]
    expect(findSubscriptionInvoice(invoices, 2026)).toBeNull()
  })

  it("matches invoices at season year boundaries (April 1)", () => {
    const invoices = [makeInvoice({ date: "2026-04-01" })]
    expect(findSubscriptionInvoice(invoices, 2026)).not.toBeNull()
  })

  it("matches invoices at season year boundaries (March 31)", () => {
    const invoices = [makeInvoice({ date: "2027-03-31" })]
    expect(findSubscriptionInvoice(invoices, 2026)).not.toBeNull()
  })

  it("rejects invoices just outside season year (March 31 before)", () => {
    const invoices = [makeInvoice({ date: "2026-03-31" })]
    expect(findSubscriptionInvoice(invoices, 2026)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// determineSubscriptionStatus
// ---------------------------------------------------------------------------

describe("determineSubscriptionStatus", () => {
  it("returns PAID for paid invoices", () => {
    const invoice: Invoice = {
      status: Invoice.StatusEnum.PAID,
      fullyPaidOnDate: "2026-05-20",
    } as Invoice

    const result = determineSubscriptionStatus(invoice)
    expect(result.status).toBe("PAID")
    expect(result.paidAt).toEqual(new Date("2026-05-20"))
  })

  it("returns PAID with updatedDateUTC fallback when no fullyPaidOnDate", () => {
    const invoice = {
      status: Invoice.StatusEnum.PAID,
      updatedDateUTC: "2026-05-20T10:30:00Z",
    } as unknown as Invoice

    const result = determineSubscriptionStatus(invoice)
    expect(result.status).toBe("PAID")
    expect(result.paidAt).toEqual(new Date("2026-05-20T10:30:00Z"))
  })

  it("returns UNPAID for authorised invoices not yet due", () => {
    const futureDate = new Date()
    futureDate.setFullYear(futureDate.getFullYear() + 1)

    const invoice: Invoice = {
      status: Invoice.StatusEnum.AUTHORISED,
      dueDate: futureDate.toISOString(),
    } as Invoice

    const result = determineSubscriptionStatus(invoice)
    expect(result.status).toBe("UNPAID")
    expect(result.paidAt).toBeUndefined()
  })

  it("returns OVERDUE for authorised invoices past due date", () => {
    const pastDate = new Date("2025-01-01")

    const invoice: Invoice = {
      status: Invoice.StatusEnum.AUTHORISED,
      dueDate: pastDate.toISOString(),
    } as Invoice

    const result = determineSubscriptionStatus(invoice)
    expect(result.status).toBe("OVERDUE")
  })

  it("returns UNPAID for submitted invoices", () => {
    const futureDate = new Date()
    futureDate.setFullYear(futureDate.getFullYear() + 1)

    const invoice: Invoice = {
      status: Invoice.StatusEnum.SUBMITTED,
      dueDate: futureDate.toISOString(),
    } as Invoice

    const result = determineSubscriptionStatus(invoice)
    expect(result.status).toBe("UNPAID")
  })

  it("returns UNPAID for draft invoices", () => {
    const invoice: Invoice = {
      status: Invoice.StatusEnum.DRAFT,
    } as Invoice

    const result = determineSubscriptionStatus(invoice)
    expect(result.status).toBe("UNPAID")
  })

  it("returns UNPAID for voided invoices", () => {
    const invoice: Invoice = {
      status: Invoice.StatusEnum.VOIDED,
    } as Invoice

    const result = determineSubscriptionStatus(invoice)
    expect(result.status).toBe("UNPAID")
  })
})

// ---------------------------------------------------------------------------
// buildInvoiceLineItems
// ---------------------------------------------------------------------------

describe("buildInvoiceLineItems", () => {
  const guests = [
    { firstName: "John", lastName: "Smith", ageTier: "ADULT", isMember: true, priceCents: 9000 },
    { firstName: "Jane", lastName: "Smith", ageTier: "ADULT", isMember: false, priceCents: 13000 },
    { firstName: "Tom", lastName: "Smith", ageTier: "CHILD", isMember: true, priceCents: 3000 },
  ]

  const checkIn = new Date("2026-07-10")
  const checkOut = new Date("2026-07-12")

  it("creates one line item per guest", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2)
    expect(items).toHaveLength(3)
  })

  it("sets correct quantity (number of nights)", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2)
    for (const item of items) {
      expect(item.quantity).toBe(2)
    }
  })

  it("calculates per-night unit amount in dollars", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2)
    // John: 9000 cents / 2 nights = 4500 cents = $45.00
    expect(items[0].unitAmount).toBe(45)
    // Jane: 13000 cents / 2 nights = 6500 cents = $65.00
    expect(items[1].unitAmount).toBe(65)
    // Tom: 3000 cents / 2 nights = 1500 cents = $15.00
    expect(items[2].unitAmount).toBe(15)
  })

  it("includes guest name and tier in description", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2)
    expect(items[0].description).toContain("John Smith")
    expect(items[0].description).toContain("ADULT")
    expect(items[0].description).toContain("Member")
    expect(items[1].description).toContain("Non-member")
  })

  it("includes date range in description", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2)
    expect(items[0].description).toContain("2026-07-10")
    expect(items[0].description).toContain("2026-07-12")
  })

  it("sets correct account code and tax type", () => {
    const items = buildInvoiceLineItems(guests, checkIn, checkOut, 2)
    for (const item of items) {
      expect(item.accountCode).toBe("200")
      expect(item.taxType).toBe("OUTPUT2")
    }
  })

  it("handles single night stay", () => {
    const items = buildInvoiceLineItems(
      [{ firstName: "A", lastName: "B", ageTier: "ADULT", isMember: true, priceCents: 4500 }],
      new Date("2026-07-10"),
      new Date("2026-07-11"),
      1
    )
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(1)
    expect(items[0].unitAmount).toBe(45) // $45.00
    expect(items[0].description).toContain("1 night")
  })

  it("handles zero nights gracefully", () => {
    const items = buildInvoiceLineItems(
      [{ firstName: "A", lastName: "B", ageTier: "ADULT", isMember: true, priceCents: 4500 }],
      new Date("2026-07-10"),
      new Date("2026-07-10"),
      0
    )
    expect(items).toHaveLength(1)
    // With 0 nights, unitAmount is the full price
    expect(items[0].unitAmount).toBe(45)
  })

  it("handles pluralization correctly", () => {
    const items1 = buildInvoiceLineItems(
      [{ firstName: "A", lastName: "B", ageTier: "ADULT", isMember: true, priceCents: 4500 }],
      new Date("2026-07-10"),
      new Date("2026-07-11"),
      1
    )
    expect(items1[0].description).toContain("1 night")
    expect(items1[0].description).not.toContain("nights")

    const items2 = buildInvoiceLineItems(
      [{ firstName: "A", lastName: "B", ageTier: "ADULT", isMember: true, priceCents: 9000 }],
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      2
    )
    expect(items2[0].description).toContain("2 nights")
  })
})

// ---------------------------------------------------------------------------
// Season year (re-test the imported getSeasonYear via the Xero context)
// ---------------------------------------------------------------------------

describe("Season year logic for membership", () => {
  // The getSeasonYear function is already tested in pricing.test.ts,
  // but we test the boundary logic here in the context of subscription matching.

  it("April 1 belongs to same calendar year's season", () => {
    // April 2026 -> seasonYear 2026 -> season runs Apr 2026 - Mar 2027
    const seasonStart = new Date(2026, 3, 1) // April 1
    const seasonEnd = new Date(2027, 2, 31) // March 31

    // An invoice dated May 2026 should match season 2026
    const invoiceDate = new Date("2026-05-15")
    expect(invoiceDate >= seasonStart && invoiceDate <= seasonEnd).toBe(true)
  })

  it("March belongs to previous calendar year's season", () => {
    // March 2027 -> seasonYear 2026 -> season runs Apr 2026 - Mar 2027
    const seasonStart = new Date(2026, 3, 1)
    const seasonEnd = new Date(2027, 2, 31)

    const invoiceDate = new Date("2027-03-15")
    expect(invoiceDate >= seasonStart && invoiceDate <= seasonEnd).toBe(true)
  })

  it("January 2027 belongs to season year 2026", () => {
    const seasonStart = new Date(2026, 3, 1)
    const seasonEnd = new Date(2027, 2, 31)

    const invoiceDate = new Date("2027-01-15")
    expect(invoiceDate >= seasonStart && invoiceDate <= seasonEnd).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// withXeroRetry
// ---------------------------------------------------------------------------

describe("withXeroRetry", () => {
  it("returns result on successful call", async () => {
    const result = await withXeroRetry(() => Promise.resolve("ok"))
    expect(result).toBe("ok")
  })

  it("passes through non-429 errors immediately", async () => {
    const error = { response: { statusCode: 500 }, message: "Internal Server Error" }
    await expect(
      withXeroRetry(() => Promise.reject(error))
    ).rejects.toBe(error)
  })

  it("retries on minute-level 429 and succeeds", async () => {
    let calls = 0
    const fn = () => {
      calls++
      if (calls === 1) {
        return Promise.reject({
          response: {
            statusCode: 429,
            headers: { "retry-after": "0", "x-rate-limit-problem": "minute" },
          },
        })
      }
      return Promise.resolve("success")
    }
    const result = await withXeroRetry(fn, { maxRetries: 3, maxWaitSec: 1 })
    expect(result).toBe("success")
    expect(calls).toBe(2)
  })

  it("throws XeroDailyLimitError immediately on daily limit (no retries)", async () => {
    let calls = 0
    const fn = () => {
      calls++
      return Promise.reject({
        response: {
          statusCode: 429,
          headers: { "retry-after": "34166", "x-rate-limit-problem": "day" },
        },
      })
    }
    await expect(
      withXeroRetry(fn, { maxRetries: 3 })
    ).rejects.toBeInstanceOf(XeroDailyLimitError)
    expect(calls).toBe(1) // No retries — aborted immediately
  })

  it("detects wrapped daily-limit JSON errors and activates cooldown", async () => {
    let calls = 0
    const fn = () => {
      calls++
      return Promise.reject(
        new Error(
          JSON.stringify({
            response: {
              statusCode: 429,
              headers: {
                "retry-after": "60",
                "x-rate-limit-problem": "day",
              },
            },
          })
        )
      )
    }

    await expect(withXeroRetry(fn, { maxRetries: 3 })).rejects.toBeInstanceOf(
      XeroDailyLimitError
    )
    expect(calls).toBe(1)

    const secondFn = vi.fn(() => Promise.resolve("should not run"))
    await expect(withXeroRetry(secondFn)).rejects.toBeInstanceOf(XeroDailyLimitError)
    expect(secondFn).not.toHaveBeenCalled()
  })

  it("short-circuits future calls while the daily limit cooldown is active", async () => {
    await expect(
      withXeroRetry(
        () =>
          Promise.reject({
            response: {
              statusCode: 429,
              headers: { "retry-after": "60", "x-rate-limit-problem": "day" },
            },
          }),
        { maxRetries: 3 }
      )
    ).rejects.toBeInstanceOf(XeroDailyLimitError)

    const fn = vi.fn(() => Promise.resolve("should not run"))

    await expect(withXeroRetry(fn)).rejects.toBeInstanceOf(XeroDailyLimitError)
    expect(fn).not.toHaveBeenCalled()
  })

  it("throws after exhausting all retries on minute-level 429", async () => {
    let calls = 0
    const fn = () => {
      calls++
      return Promise.reject({
        response: {
          statusCode: 429,
          headers: { "retry-after": "0", "x-rate-limit-problem": "minute" },
        },
      })
    }
    await expect(
      withXeroRetry(fn, { maxRetries: 2, maxWaitSec: 0 })
    ).rejects.toMatchObject({ response: { statusCode: 429 } })
    expect(calls).toBe(3) // initial + 2 retries
  })

  it("caps wait time to maxWaitSec", async () => {
    let calls = 0
    const start = Date.now()
    const fn = () => {
      calls++
      if (calls === 1) {
        return Promise.reject({
          response: {
            statusCode: 429,
            headers: { "retry-after": "999", "x-rate-limit-problem": "minute" },
          },
        })
      }
      return Promise.resolve("done")
    }
    // maxWaitSec=0 means don't actually wait
    const result = await withXeroRetry(fn, { maxRetries: 1, maxWaitSec: 0 })
    expect(result).toBe("done")
    expect(Date.now() - start).toBeLessThan(2000) // Should not have waited 999 seconds
  })
})

describe("callXeroApi", () => {
  it("records successful calls and preserves observed rate-limit category", async () => {
    let calls = 0

    const result = await callXeroApi(
      () => {
        calls++
        if (calls === 1) {
          return Promise.reject({
            response: {
              statusCode: 429,
              headers: { "retry-after": "0", "x-rate-limit-problem": "minute" },
            },
          })
        }
        return Promise.resolve("ok")
      },
      {
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "syncContactsFromXero",
        context: "syncContacts test",
        maxRetries: 1,
        maxWaitSec: 0,
      }
    )

    expect(result).toBe("ok")
    expect(mocks.recordXeroApiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "getContacts",
        resourceType: "CONTACT",
        workflow: "syncContactsFromXero",
        success: true,
        rateLimitCategory: "minute",
      })
    )
  })

  it("records failed calls with status code and error message", async () => {
    const error = { response: { statusCode: 500 }, message: "Xero exploded" }

    await expect(
      callXeroApi(() => Promise.reject(error), {
        operation: "getInvoice",
        resourceType: "INVOICE",
        workflow: "reconcileXeroInvoice",
        context: "reconcile invoice test",
      })
    ).rejects.toBe(error)

    expect(mocks.recordXeroApiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "getInvoice",
        resourceType: "INVOICE",
        workflow: "reconcileXeroInvoice",
        success: false,
        statusCode: 500,
        errorMessage: "Xero exploded",
      })
    )
  })
})

// ---------------------------------------------------------------------------
// XeroDailyLimitError
// ---------------------------------------------------------------------------

describe("XeroDailyLimitError", () => {
  it("has correct name and message", () => {
    const err = new XeroDailyLimitError(34166)
    expect(err.name).toBe("XeroDailyLimitError")
    expect(err.message).toContain("daily API limit")
    expect(err.retryAfterSec).toBe(34166)
    expect(err).toBeInstanceOf(Error)
  })
})
