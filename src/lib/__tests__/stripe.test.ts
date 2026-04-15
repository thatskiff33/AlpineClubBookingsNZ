import { describe, it, expect, vi, beforeEach } from "vitest";

// Set env BEFORE any imports
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");

// Mock Stripe before importing the module
const mockPaymentIntentsCreate = vi.fn();
const mockSetupIntentsCreate = vi.fn();
const mockRefundsCreate = vi.fn();
const mockPaymentIntentsRetrieve = vi.fn();
const mockSetupIntentsRetrieve = vi.fn();
const mockCustomersCreate = vi.fn();
const mockCustomersList = vi.fn();
const mockWebhooksConstructEvent = vi.fn();

vi.mock("stripe", () => {
  const MockStripe = function () {
    return {
      paymentIntents: {
        create: mockPaymentIntentsCreate,
        retrieve: mockPaymentIntentsRetrieve,
      },
      setupIntents: {
        create: mockSetupIntentsCreate,
        retrieve: mockSetupIntentsRetrieve,
      },
      refunds: {
        create: mockRefundsCreate,
      },
      customers: {
        create: mockCustomersCreate,
        list: mockCustomersList,
      },
      webhooks: {
        constructEvent: mockWebhooksConstructEvent,
      },
    };
  };
  return { default: MockStripe };
});

const {
  createPaymentIntent,
  createSetupIntent,
  chargePaymentMethod,
  findOrCreateCustomer,
  processRefund,
  getPaymentIntent,
  getSetupIntent,
  constructWebhookEvent,
} = await import("../stripe");

describe("Stripe library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createPaymentIntent", () => {
    it("creates a PaymentIntent with correct params", async () => {
      const mockPI = {
        id: "pi_test_123",
        client_secret: "pi_test_123_secret",
        amount: 5000,
        currency: "nzd",
      };
      mockPaymentIntentsCreate.mockResolvedValue(mockPI);

      const result = await createPaymentIntent({
        amountCents: 5000,
        customerId: "cus_test",
        metadata: { bookingId: "booking_1" },
      });

      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
        {
          amount: 5000,
          currency: "nzd",
          customer: "cus_test",
          metadata: { bookingId: "booking_1" },
          automatic_payment_methods: { enabled: true },
        },
        undefined,
      );
      expect(result.id).toBe("pi_test_123");
    });

    it("defaults to NZD currency", async () => {
      mockPaymentIntentsCreate.mockResolvedValue({ id: "pi_test" });

      await createPaymentIntent({ amountCents: 1000 });

      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "nzd" }),
        undefined,
      );
    });

    it("allows custom currency", async () => {
      mockPaymentIntentsCreate.mockResolvedValue({ id: "pi_test" });

      await createPaymentIntent({ amountCents: 1000, currency: "aud" });

      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "aud" }),
        undefined,
      );
    });
  });

  describe("createSetupIntent", () => {
    it("creates a SetupIntent with correct params", async () => {
      const mockSI = {
        id: "seti_test_123",
        client_secret: "seti_test_123_secret",
      };
      mockSetupIntentsCreate.mockResolvedValue(mockSI);

      const result = await createSetupIntent({
        customerId: "cus_test",
        metadata: { bookingId: "booking_1" },
      });

      expect(mockSetupIntentsCreate).toHaveBeenCalledWith(
        {
          customer: "cus_test",
          metadata: { bookingId: "booking_1" },
          automatic_payment_methods: { enabled: true },
        },
        undefined,
      );
      expect(result.id).toBe("seti_test_123");
    });
  });

  describe("chargePaymentMethod", () => {
    it("creates an off-session PaymentIntent with confirm=true", async () => {
      const mockPI = { id: "pi_charge_123", status: "succeeded" };
      mockPaymentIntentsCreate.mockResolvedValue(mockPI);

      const result = await chargePaymentMethod({
        amountCents: 8000,
        customerId: "cus_test",
        paymentMethodId: "pm_test",
        metadata: { bookingId: "booking_2" },
      });

      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
        {
          amount: 8000,
          currency: "nzd",
          customer: "cus_test",
          payment_method: "pm_test",
          off_session: true,
          confirm: true,
          metadata: { bookingId: "booking_2" },
        },
        undefined,
      );
      expect(result.id).toBe("pi_charge_123");
    });
  });

  describe("findOrCreateCustomer", () => {
    it("returns the existing customer for the same member", async () => {
      const existingCustomer = {
        id: "cus_existing",
        email: "test@example.com",
        metadata: { memberId: "member_1" },
      };
      const otherCustomer = {
        id: "cus_other",
        email: "test@example.com",
        metadata: { memberId: "member_other" },
      };
      mockCustomersList.mockResolvedValue({ data: [otherCustomer, existingCustomer] });

      const result = await findOrCreateCustomer({
        email: "test@example.com",
        name: "Test User",
        memberId: "member_1",
      });

      expect(mockCustomersList).toHaveBeenCalledWith({
        email: "test@example.com",
        limit: 100,
      });
      expect(result.id).toBe("cus_existing");
      expect(mockCustomersCreate).not.toHaveBeenCalled();
    });

    it("creates a new customer when the email belongs to a different member", async () => {
      mockCustomersList.mockResolvedValue({
        data: [
          {
            id: "cus_other",
            email: "shared@example.com",
            metadata: { memberId: "member_1" },
          },
        ],
      });
      const newCustomer = { id: "cus_new", email: "shared@example.com" };
      mockCustomersCreate.mockResolvedValue(newCustomer);

      const result = await findOrCreateCustomer({
        email: "shared@example.com",
        name: "Second User",
        memberId: "member_2",
      });

      expect(mockCustomersCreate).toHaveBeenCalledWith({
        email: "shared@example.com",
        name: "Second User",
        metadata: { memberId: "member_2" },
      });
      expect(result.id).toBe("cus_new");
    });
  });

  describe("processRefund", () => {
    it("creates a refund with correct params", async () => {
      const mockRefund = { id: "re_test_123", amount: 5000 };
      mockRefundsCreate.mockResolvedValue(mockRefund);

      const result = await processRefund({
        paymentIntentId: "pi_test_123",
        amountCents: 5000,
        metadata: { bookingId: "booking_1", reason: "cancellation" },
      });

      expect(mockRefundsCreate).toHaveBeenCalledWith({
        payment_intent: "pi_test_123",
        amount: 5000,
        reason: "requested_by_customer",
        metadata: { bookingId: "booking_1", reason: "cancellation" },
      });
      expect(result.id).toBe("re_test_123");
    });
  });

  describe("getPaymentIntent", () => {
    it("retrieves a PaymentIntent by ID", async () => {
      mockPaymentIntentsRetrieve.mockResolvedValue({
        id: "pi_test_123",
        status: "succeeded",
      });

      const result = await getPaymentIntent("pi_test_123");
      expect(mockPaymentIntentsRetrieve).toHaveBeenCalledWith("pi_test_123");
      expect(result.id).toBe("pi_test_123");
    });
  });

  describe("getSetupIntent", () => {
    it("retrieves a SetupIntent by ID", async () => {
      mockSetupIntentsRetrieve.mockResolvedValue({
        id: "seti_test_123",
        status: "succeeded",
      });

      const result = await getSetupIntent("seti_test_123");
      expect(mockSetupIntentsRetrieve).toHaveBeenCalledWith("seti_test_123");
      expect(result.id).toBe("seti_test_123");
    });
  });

  describe("constructWebhookEvent", () => {
    it("calls Stripe webhooks.constructEvent with correct params", () => {
      const mockEvent = { id: "evt_test", type: "payment_intent.succeeded" };
      mockWebhooksConstructEvent.mockReturnValue(mockEvent);

      const result = constructWebhookEvent(
        "payload_body",
        "sig_header",
        "whsec_test"
      );

      expect(mockWebhooksConstructEvent).toHaveBeenCalledWith(
        "payload_body",
        "sig_header",
        "whsec_test"
      );
      expect(result.type).toBe("payment_intent.succeeded");
    });
  });
});
