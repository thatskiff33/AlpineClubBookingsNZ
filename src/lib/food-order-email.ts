import { getAppBaseUrl } from "@/lib/app-url";
import { formatStayDate } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { sendFoodOrderPlacedEmail } from "@/lib/email";
import { loadFoodOrderSettings } from "@/lib/food-order-settings";
import { memberDisplayName } from "@/lib/member-serialization";
import { storedQuantity } from "@/lib/food-orders";
import { prisma } from "@/lib/prisma";

/**
 * Email the food officer about an order that is ALREADY STORED (fork #121).
 *
 * The order is re-read rather than passed in, so the email shows exactly what
 * the history will show — every item line as saved, in order — and not what the
 * request claimed (the same reasoning as `maintenance-report-alert.ts`).
 *
 * The caller runs this after the create transaction has committed and never
 * awaits it into the response: a slow mail server must not hold a transaction
 * open or fail an order that is already saved. With no officer email set the
 * create route refuses before anything is stored, so the early return here only
 * covers the setting being cleared in between; the order stays in the history.
 */
export async function notifyFoodOfficerOfOrder(
  orderId: string,
  request?: { nextUrl: { origin: string } },
): Promise<void> {
  const [settings, order, club] = await Promise.all([
    loadFoodOrderSettings(),
    prisma.foodOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        lodgeId: true,
        neededBy: true,
        notes: true,
        lodge: { select: { name: true } },
        member: { select: { firstName: true, lastName: true, email: true } },
        items: {
          orderBy: { sortOrder: "asc" },
          select: { description: true, quantity: true, unit: true },
        },
      },
    }),
    clubTime(),
  ]);
  if (!settings.officerEmail || !order) return;

  const orderedBy = order.member
    ? memberDisplayName(order.member)
    : "A former member";
  const baseUrl = getAppBaseUrl(request?.nextUrl.origin);

  await sendFoodOrderPlacedEmail({
    to: settings.officerEmail,
    orderId: order.id,
    lodgeId: order.lodgeId,
    officerLabel: settings.officerLabel,
    lodgeName: order.lodge.name,
    neededBy: formatStayDate(order.neededBy, club.format),
    orderedBy,
    items: order.items.map((item) => ({
      description: item.description,
      quantity: storedQuantity(item.quantity),
      unit: item.unit,
    })),
    notes: order.notes,
    // Built from our own origin and the order id only (`sameOrigin` in the
    // template): a member cannot put a link of their choosing in the email.
    foodOrderUrl: `${baseUrl}/food-orders?order=${encodeURIComponent(order.id)}`,
  });
}
