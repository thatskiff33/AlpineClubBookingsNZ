import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  coerceWhakapapaCurlData,
  emptyWhakapapaCurlData,
} from "@/lib/whakapapa-report";
import { fetchWhakapapaCurlData } from "@/lib/whakapapa-report.server";

const WHAKAPAPA_SOURCE = "whakapapa-report";
const ADMIN_FREEZE_TTL_MS = 12 * 60 * 60 * 1000;

type WhakapapaReportCacheRecord = {
  source: string;
  payload: Prisma.JsonValue;
  fetchedAt: Date;
  frozenUntil: Date | null;
  updatedAt: Date;
};

type WhakapapaReportCacheDelegate = {
  findUnique(args: {
    where: { source: string };
  }): Promise<WhakapapaReportCacheRecord | null>;
  upsert(args: {
    where: { source: string };
    create: {
      source: string;
      payload: Prisma.InputJsonValue;
      fetchedAt: Date;
      frozenUntil: Date | null;
    };
    update: {
      payload: Prisma.InputJsonValue;
      fetchedAt: Date;
      frozenUntil: Date | null;
    };
  }): Promise<WhakapapaReportCacheRecord>;
};

const whakapapaReportCache = (
  prisma as unknown as { whakapapaReportCache: WhakapapaReportCacheDelegate }
).whakapapaReportCache;

function toResponseRecord(record: {
  source: string;
  payload: Prisma.JsonValue;
  fetchedAt: Date;
  frozenUntil: Date | null;
  updatedAt: Date;
}) {
  const payload =
    coerceWhakapapaCurlData(record.payload) ?? emptyWhakapapaCurlData();

  return {
    source: record.source,
    payload,
    fetchedAt: record.fetchedAt.toISOString(),
    frozenUntil: record.frozenUntil?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function getCurrentRecord() {
  const record = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });

  return record ? toResponseRecord(record) : null;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json({
    record: await getCurrentRecord(),
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawJson =
    body && typeof body === "object" && "rawJson" in body
      ? String((body as { rawJson?: unknown }).rawJson ?? "")
      : "";

  if (!rawJson.trim()) {
    return NextResponse.json({ error: "rawJson is required" }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON content" },
      { status: 400 },
    );
  }

  const payload = coerceWhakapapaCurlData(parsed);
  if (!payload) {
    return NextResponse.json(
      { error: "JSON does not match the Whakapapa conditions shape" },
      { status: 400 },
    );
  }

  const now = new Date();
  const frozenUntil = new Date(now.getTime() + ADMIN_FREEZE_TTL_MS);

  const record = await whakapapaReportCache.upsert({
    where: { source: WHAKAPAPA_SOURCE },
    create: {
      source: WHAKAPAPA_SOURCE,
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
      frozenUntil,
    },
    update: {
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
      frozenUntil,
    },
  });

  return NextResponse.json({
    record: toResponseRecord(record),
    message: "Mountain conditions saved. Auto refresh is paused for 12 hours.",
  });
}

export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const payload = await fetchWhakapapaCurlData();
  const now = new Date();

  const record = await whakapapaReportCache.upsert({
    where: { source: WHAKAPAPA_SOURCE },
    create: {
      source: WHAKAPAPA_SOURCE,
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
      frozenUntil: null,
    },
    update: {
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
      frozenUntil: null,
    },
  });

  return NextResponse.json({
    record: toResponseRecord(record),
    message: "Mountain conditions refreshed from Whakapapa.",
  });
}
