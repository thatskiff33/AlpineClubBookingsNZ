import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork #121: the food-order email to the food officer.
 *
 * It goes to the ONE configured address, lists every item with its quantity
 * (in the HTML and in the `itemsText` an override renders from), escapes what
 * the member typed, carries no booking, and is withheld when the club-wide
 * Delivery Rules mute it.
 */

const h = vi.hoisted(() => ({
  shouldSend: vi.fn().mockResolvedValue(true),
  sendEmail: vi.fn().mockResolvedValue({ status: "sent" }),
}));

vi.mock("../admin-alerts-shared", () => ({
  getAdminAlertEmails: vi.fn(),
  sendAdminAlertTo: vi.fn(),
  sendToAdmins: vi.fn(),
  shouldSendDirectAdminSystemEmail: h.shouldSend,
}));
vi.mock("../core", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { sendFoodOrderPlacedEmail } from "@/lib/email/admin-alerts-ops";
import { foodOrderPlacedTemplate } from "@/lib/email-templates/admin-ops";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";

const ORDER = {
  to: "food@club.test",
  orderId: "order-1",
  lodgeId: "lodge-a",
  officerLabel: "Food officer",
  lodgeName: "Lodge A",
  neededBy: "3 July 2026",
  orderedBy: "Mere Member",
  items: [
    { description: "Flour", quantity: "1.5", unit: "KILOGRAMS" as const },
    { description: "<b>Eggs</b>", quantity: "12", unit: "ITEMS" as const },
    { description: "Wholemeal", quantity: "1", unit: "LOAVES" as const },
  ],
  notes: "Leave at the back door",
  foodOrderUrl: "https://club.example.test/food-orders?order=order-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.shouldSend.mockResolvedValue(true);
});

describe("sendFoodOrderPlacedEmail", () => {
  it("sends to the configured address with every item, outside any booking", async () => {
    await sendFoodOrderPlacedEmail(ORDER);
    expect(h.sendEmail).toHaveBeenCalledOnce();
    const args = h.sendEmail.mock.calls[0]![0] as Record<string, unknown> & {
      templateData: Record<string, string>;
      html: string;
    };
    expect(args.to).toBe("food@club.test");
    expect(args.templateName).toBe("food-order-placed");
    expect(args.bookingContext).toBe("none");
    expect(args.idempotencyKey).toBe("food-order-placed:order-1");
    // The one shared line format, singular only for exactly 1.
    expect(args.templateData.itemsText).toBe(
      "1.5 Kilograms — Flour\n12 Items — <b>Eggs</b>\n1 Loaf — Wholemeal",
    );
    expect(args.html).toContain("1.5 Kilograms — Flour");
    expect(args.html).toContain("&lt;b&gt;Eggs&lt;/b&gt;");
    expect(args.html).not.toContain("<b>Eggs</b>");
    expect(args.html).toContain("Leave at the back door");
  });

  it("is withheld when the delivery rules mute it", async () => {
    h.shouldSend.mockResolvedValue(false);
    await sendFoodOrderPlacedEmail(ORDER);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

describe("food-order-placed template", () => {
  it("renders each item as quantity and description", () => {
    const html = foodOrderPlacedTemplate(ORDER);
    expect(html).toContain("Item 1");
    expect(html).toContain("1.5 Kilograms — Flour");
    expect(html).toContain("1 Loaf — Wholemeal");
    expect(html).toContain("Item 2");
  });

  it("is registered, editable on Delivery Rules, and requires the item list", () => {
    const definition = getEmailTemplateDefinition("food-order-placed");
    expect(definition).toBeDefined();
    expect(definition!.audience).toBe("admin");
    expect(definition!.deliveryEditable).toBe(true);
    expect(definition!.requiredTokens).toContain("itemsText");
    expect(definition!.defaultBody).toContain("{{itemsText}}");
  });
});
