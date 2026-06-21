import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  coerceWhakapapaCurlData,
  emptyWhakapapaCurlData,
} from "@/lib/whakapapa-report";
import { fetchWhakapapaCurlData } from "@/lib/whakapapa-report.server";

export const runtime = "nodejs";

const WHAKAPAPA_SOURCE = "whakapapa-report";
const CACHE_TTL_MS = 60 * 60 * 1000;

type WhakapapaReportCacheRecord = {
  source: string;
  payload: Prisma.JsonValue;
  fetchedAt: Date;
  frozenUntil: Date | null;
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

function isFresh(fetchedAt: Date): boolean {
  return Date.now() - fetchedAt.getTime() < CACHE_TTL_MS;
}

function isFrozenUntil(frozenUntil: Date | null): boolean {
  return frozenUntil != null && frozenUntil.getTime() > Date.now();
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const existing = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });

  const cachedData = coerceWhakapapaCurlData(existing?.payload);
  if (
    existing &&
    cachedData &&
    (isFrozenUntil(existing.frozenUntil) || isFresh(existing.fetchedAt))
  ) {
    return NextResponse.json(cachedData, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const curlData = await fetchWhakapapaCurlData();

    await whakapapaReportCache.upsert({
      where: { source: WHAKAPAPA_SOURCE },
      create: {
        source: WHAKAPAPA_SOURCE,
        payload: curlData as unknown as Prisma.InputJsonValue,
        fetchedAt: new Date(),
        frozenUntil: null,
      },
      update: {
        payload: curlData as unknown as Prisma.InputJsonValue,
        fetchedAt: new Date(),
        frozenUntil: null,
      },
    });

    return NextResponse.json(curlData, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (cachedData) {
      return NextResponse.json(
        {
          ...cachedData,
          error:
            error instanceof Error
              ? error.message
              : "Unable to refresh Whakapapa report data.",
          stale: true,
        },
        {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const empty = emptyWhakapapaCurlData();
    empty.updated = new Date().toISOString();

    return NextResponse.json(
      {
        ...empty,
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch Whakapapa report data.",
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
