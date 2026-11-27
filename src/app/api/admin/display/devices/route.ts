import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { nameField } from "@/lib/zod-helpers";

// Admin lobby-display device management (fork issue hoppers99/AlpineClubBookingsNZ#33, epic hoppers99/AlpineClubBookingsNZ#25): list and
// create device records. Creation never generates a token — pairing does
// (ADR-001; confirm endpoint at devices/[id]/pairing, claim on the display).

const DEVICE_SELECT = {
  id: true,
  name: true,
  lodgeId: true,
  lodge: { select: { name: true } },
  templateId: true,
  template: { select: { name: true } },
  pollSeconds: true,
  tokenHash: true,
  pairingCodeExpiresAt: true,
  lastSeenAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

type DeviceRow = {
  id: string;
  name: string;
  lodgeId: string;
  lodge: { name: string };
  templateId: string | null;
  template: { name: string } | null;
  pollSeconds: number | null;
  tokenHash: string | null;
  pairingCodeExpiresAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

// The hash itself never leaves the server — the list exposes only lifecycle
// booleans derived from it.
function toClientDevice(device: DeviceRow) {
  return {
    id: device.id,
    name: device.name,
    lodgeId: device.lodgeId,
    lodgeName: device.lodge.name,
    templateId: device.templateId,
    templateName: device.template?.name ?? null,
    // null = the device uses the default refresh cadence (LTV-039).
    pollSeconds: device.pollSeconds,
    paired: device.tokenHash !== null,
    pairingArmedUntil:
      device.pairingCodeExpiresAt && device.pairingCodeExpiresAt > new Date()
        ? device.pairingCodeExpiresAt.toISOString()
        : null,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    revoked: device.revokedAt !== null,
    createdAt: device.createdAt.toISOString(),
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const devices = await prisma.lodgeDisplayDevice.findMany({
    orderBy: [{ createdAt: "asc" }],
    select: DEVICE_SELECT,
  });
  return NextResponse.json({ devices: devices.map(toClientDevice) });
}

const createSchema = z.object({
  name: nameField(),
  lodgeId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof createSchema>;
  const jsonBody = await parseJsonRequestBody(req);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    body = createSchema.parse(jsonBody.body);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const lodgeId = body.lodgeId;
  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { id: true, active: true },
  });
  if (!lodge || !lodge.active) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  const device = await prisma.lodgeDisplayDevice.create({
    data: { name: body.name, lodgeId },
    select: DEVICE_SELECT,
  });
  return NextResponse.json({ device: toClientDevice(device) }, { status: 201 });
}
