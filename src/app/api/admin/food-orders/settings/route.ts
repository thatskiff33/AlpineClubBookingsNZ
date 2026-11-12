import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createAuditLog } from "@/lib/audit";
import {
  FOOD_ORDER_NOT_FOUND,
  foodOrderAuditContext,
  foodOrderModuleOff,
} from "@/lib/food-order-route";
import {
  FOOD_ORDER_SETTINGS_ID,
  foodOfficerEmailSchema,
  foodOfficerLabelSchema,
  loadFoodOrderSettings,
  normaliseFoodOrderSettings,
} from "@/lib/food-order-settings";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError, isTransactionContention } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The Food Orders settings card (fork #121): the food officer's email address
 * and what the club calls them. Lodge Operations `view` to read, `edit` to save.
 * 404 while the `foodOrders` module is off, here as well as in the proxy.
 *
 * The address is checked ONLY as a valid email (fork #121 owner decision 10) — never
 * against members or committee roles. An empty address is allowed and means
 * ordering is not set up: the order page says so and the API refuses orders.
 */

const putSchema = z
  .object({
    // "" clears it; anything else must be a valid address.
    officerEmail: z.union([z.literal(""), foodOfficerEmailSchema]).nullable(),
    officerLabel: foodOfficerLabelSchema,
  })
  .strict();

export async function GET() {
  if (await foodOrderModuleOff()) {
    return NextResponse.json(FOOD_ORDER_NOT_FOUND, { status: 404 });
  }
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!admin.ok) return admin.response;

  return NextResponse.json({ settings: await loadFoodOrderSettings() });
}

export async function PUT(request: NextRequest) {
  if (await foodOrderModuleOff()) {
    return NextResponse.json(FOOD_ORDER_NOT_FOUND, { status: 404 });
  }
  const admin = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!admin.ok) return admin.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Enter a valid email address (or leave it empty), and a label of up to 60 characters.",
      },
      { status: 400 },
    );
  }
  const data = {
    officerEmail: parsed.data.officerEmail?.trim() || null,
    officerLabel: parsed.data.officerLabel,
  };

  try {
    const settings = await prisma.$transaction(
      async (tx) => {
        // Read, write and audit in ONE Serializable transaction, the repository's
        // singleton-write pattern (environment-safety-override-write.ts): the
        // isolation level keeps `before` true at commit, so the audit row's
        // "from" is the value actually replaced, and the change can never land
        // without its audit row. A concurrent save aborts one side (P2034, or
        // P2002 on a racing first insert) and writes nothing; it is answered 503.
        const before = normaliseFoodOrderSettings(
          await tx.foodOrderSettings.findUnique({
            where: { id: FOOD_ORDER_SETTINGS_ID },
            select: { officerEmail: true, officerLabel: true },
          }),
        );
        const saved = await tx.foodOrderSettings.upsert({
          where: { id: FOOD_ORDER_SETTINGS_ID },
          create: {
            id: FOOD_ORDER_SETTINGS_ID,
            ...data,
            updatedByMemberId: admin.session.user.id,
          },
          update: { ...data, updatedByMemberId: admin.session.user.id },
          select: { officerEmail: true, officerLabel: true },
        });
        await createAuditLog(
          {
            action: "food_order.settings.updated",
            category: "lodge",
            memberId: admin.session.user.id,
            entityType: "FoodOrderSettings",
            entityId: FOOD_ORDER_SETTINGS_ID,
            // The officer address is the club's own operational address,
            // recorded so "when did orders start going somewhere else, and who
            // changed it" has an answer.
            details: JSON.stringify({
              officerEmail: { from: before.officerEmail, to: data.officerEmail },
              officerLabel: { from: before.officerLabel, to: data.officerLabel },
            }),
            ipAddress: foodOrderAuditContext(request).ipAddress,
            outcome: "success",
          },
          tx,
        );
        return normaliseFoodOrderSettings(saved);
      },
      { isolationLevel: "Serializable" },
    );
    return NextResponse.json({ settings });
  } catch (err) {
    if (isTransactionContention(err) || isPrismaUniqueConstraintError(err)) {
      return NextResponse.json(
        { error: "Somebody else saved these settings at the same moment. Please try again." },
        { status: 503 },
      );
    }
    logger.error({ err }, "Failed to save food order settings");
    return NextResponse.json(
      { error: "Failed to save these settings" },
      { status: 500 },
    );
  }
}
