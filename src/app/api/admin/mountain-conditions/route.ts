import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { parseJsonRequestBody, parseOptionalJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  coerceWhakapapaCurlData,
  coerceWhakapapaSectionVisibility,
  coerceWhakapapaSourceConfig,
  emptyWhakapapaCurlData,
  resolveWhakapapaSelectors,
  validateWhakapapaSourceUrl,
  WHAKAPAPA_SELECTOR_LABELS,
  type WhakapapaSectionVisibility,
  type WhakapapaSourceConfig,
} from "@/lib/whakapapa-report";
import {
  fetchWhakapapaCurlData,
  findInvalidSelectorOverrides,
} from "@/lib/whakapapa-report.server";

const WHAKAPAPA_SOURCE = "whakapapa-report";
const ADMIN_FREEZE_TTL_MS = 12 * 60 * 60 * 1000;

type WhakapapaReportCacheRecord = {
  source: string;
  payload: Prisma.JsonValue;
  config: Prisma.JsonValue;
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
      config?: Prisma.InputJsonValue;
      fetchedAt: Date;
      frozenUntil: Date | null;
    };
    update: {
      payload?: Prisma.InputJsonValue;
      config?: Prisma.InputJsonValue;
      fetchedAt?: Date;
      frozenUntil?: Date | null;
    };
  }): Promise<WhakapapaReportCacheRecord>;
};

const whakapapaReportCache = (
  prisma as unknown as { whakapapaReportCache: WhakapapaReportCacheDelegate }
).whakapapaReportCache;

function toResponseRecord(record: WhakapapaReportCacheRecord) {
  const payload =
    coerceWhakapapaCurlData(record.payload) ?? emptyWhakapapaCurlData();
  const config = coerceWhakapapaSourceConfig(record.config);

  return {
    source: record.source,
    payload,
    config,
    fetchedAt: record.fetchedAt.toISOString(),
    frozenUntil: record.frozenUntil?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function configToInputJson(config: WhakapapaSourceConfig): Prisma.InputJsonValue {
  return config as unknown as Prisma.InputJsonValue;
}

/**
 * Shared 400 for a selector override the scraper's own engine cannot compile.
 * Used by BOTH the save and the preview paths so a malformed selector names the
 * offending field either way, instead of surfacing as the generic upstream 502.
 * Returns null when every override compiles.
 */
function invalidSelectorResponse(
  overrides: WhakapapaSourceConfig["selectorOverrides"],
): NextResponse | null {
  const invalidSelectors = findInvalidSelectorOverrides(overrides);
  if (invalidSelectors.length === 0) {
    return null;
  }
  const fields = invalidSelectors
    .map((key) => WHAKAPAPA_SELECTOR_LABELS[key])
    .join(", ");
  return NextResponse.json(
    {
      error: `Invalid CSS selector for: ${fields}. Fix the selector so it is valid, or clear the field to use the default.`,
    },
    { status: 400 },
  );
}

async function saveConfig(rawConfig: unknown): Promise<NextResponse> {
  const rawUrl =
    rawConfig && typeof rawConfig === "object"
      ? (rawConfig as { sourceUrl?: unknown }).sourceUrl
      : undefined;

  // Validate the raw URL explicitly so an out-of-allowlist value returns a clear
  // error instead of silently falling back to the default.
  const urlCheck = validateWhakapapaSourceUrl(rawUrl);
  if (!urlCheck.ok) {
    return NextResponse.json({ error: urlCheck.error }, { status: 400 });
  }

  const config: WhakapapaSourceConfig = {
    sourceUrl: urlCheck.url,
    selectorOverrides:
      coerceWhakapapaSourceConfig(rawConfig).selectorOverrides,
  };

  // Refuse a malformed selector up front, naming the field, rather than saving
  // cleanly and then throwing on every scrape (a stale public widget and a 500
  // on Update from upstream). This compiles each override against the same
  // engine the scraper uses.
  const selectorError = invalidSelectorResponse(config.selectorOverrides);
  if (selectorError) {
    return selectorError;
  }

  // Preserve the cached report data, its fetch timestamp, and any freeze window;
  // only the config column changes here.
  const existing = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });
  const payload =
    coerceWhakapapaCurlData(existing?.payload) ?? emptyWhakapapaCurlData();
  const fetchedAt = existing?.fetchedAt ?? new Date(0);
  const frozenUntil = existing?.frozenUntil ?? null;

  const record = await whakapapaReportCache.upsert({
    where: { source: WHAKAPAPA_SOURCE },
    create: {
      source: WHAKAPAPA_SOURCE,
      payload: payload as unknown as Prisma.InputJsonValue,
      config: configToInputJson(config),
      fetchedAt,
      frozenUntil,
    },
    update: {
      config: configToInputJson(config),
    },
  });

  return NextResponse.json({
    record: toResponseRecord(record),
    message: "Source configuration saved.",
  });
}

async function getCurrentRecord() {
  const record = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });

  return record ? toResponseRecord(record) : null;
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json({
    record: await getCurrentRecord(),
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const parsedJson = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!parsedJson.ok) return parsedJson.response;
  const body = parsedJson.body;

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

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  // POST accepts an optional body. `{ preview: true, config }` fetches and
  // parses with the supplied (unsaved) config so an admin can test a URL /
  // selector change before committing it. An empty body refreshes from the
  // stored config and persists as usual.
  const jsonBody = await parseOptionalJsonRequestBody(request, { error: "Invalid JSON", objectOnly: true });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const isPreview = Boolean(
    body && typeof body === "object" && (body as { preview?: unknown }).preview,
  );

  const existing = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });

  if (isPreview) {
    const rawConfig = (body as { config?: unknown }).config;
    const rawUrl =
      rawConfig && typeof rawConfig === "object"
        ? (rawConfig as { sourceUrl?: unknown }).sourceUrl
        : undefined;

    // Validate the raw URL so a bad value returns a clear error rather than
    // silently previewing the default host.
    const urlCheck = validateWhakapapaSourceUrl(rawUrl);
    if (!urlCheck.ok) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 });
    }

    const candidate = coerceWhakapapaSourceConfig(rawConfig);
    // Same compile check as the save path, so a typo names the field here too
    // rather than coming back as the generic "Preview failed" 502 below.
    const selectorError = invalidSelectorResponse(candidate.selectorOverrides);
    if (selectorError) {
      return selectorError;
    }

    try {
      const preview = await fetchWhakapapaCurlData({
        sourceUrl: urlCheck.url,
        selectors: resolveWhakapapaSelectors(candidate.selectorOverrides),
      });
      return NextResponse.json({
        preview,
        message: "Preview generated. Nothing was saved.",
      });
    } catch (previewError) {
      // Do not leak the raw error to the client (api-error-response-contract);
      // log the detail server-side and return a generic, actionable message.
      logger.error(
        { err: previewError },
        "Whakapapa report preview fetch failed",
      );
      return NextResponse.json(
        {
          error:
            "Preview failed. Check the report URL and selectors, then try again.",
        },
        { status: 502 },
      );
    }
  }

  const storedConfig = coerceWhakapapaSourceConfig(existing?.config);
  // A selector saved under an older selector engine can be one the current engine
  // refuses (jsdom 31 does, for `:contains()`; #5183). Name the field, as save and
  // preview do, instead of letting the scrape throw as a bare 500.
  const storedSelectorError = invalidSelectorResponse(
    storedConfig.selectorOverrides,
  );
  if (storedSelectorError) {
    return storedSelectorError;
  }
  const payload = await fetchWhakapapaCurlData({
    sourceUrl: storedConfig.sourceUrl,
    selectors: resolveWhakapapaSelectors(storedConfig.selectorOverrides),
  });

  // Section visibility is admin-controlled config stored in the payload; keep
  // the current choices instead of resetting them on an upstream refresh.
  const existingData = coerceWhakapapaCurlData(existing?.payload);
  if (existingData) {
    payload.visibility = existingData.visibility;
  }

  const now = new Date();

  const record = await whakapapaReportCache.upsert({
    where: { source: WHAKAPAPA_SOURCE },
    create: {
      source: WHAKAPAPA_SOURCE,
      payload: payload as unknown as Prisma.InputJsonValue,
      config: configToInputJson(storedConfig),
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

export async function PATCH(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  // A `{ config }` body saves the source URL + selector overrides, which live in
  // the separate `config` column so an upstream refresh never wipes them.
  if (body && typeof body === "object" && "config" in body) {
    return saveConfig((body as { config?: unknown }).config);
  }

  const rawVisibility =
    body && typeof body === "object" && "visibility" in body
      ? (body as { visibility?: unknown }).visibility
      : undefined;

  if (!rawVisibility || typeof rawVisibility !== "object") {
    return NextResponse.json(
      { error: "visibility or config object is required" },
      { status: 400 },
    );
  }

  const visibility: WhakapapaSectionVisibility =
    coerceWhakapapaSectionVisibility(rawVisibility);

  // Read-modify-write: a concurrent POST/PUT/public-GET refresh between this
  // read and the upsert below can clobber a just-fetched report with the older
  // report data carried on this toggle (last write wins). Accepted at club
  // scale — admin toggles are rare and self-heal on the next upstream refresh.
  const existing = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });

  // Toggling visibility only changes display config, so preserve the cached
  // report data, its fetch timestamp, and any active freeze window.
  const payload =
    coerceWhakapapaCurlData(existing?.payload) ?? emptyWhakapapaCurlData();
  payload.visibility = visibility;

  // On the create path (no cache row yet) the report data is empty, so backdate
  // fetchedAt to the epoch to mark the row stale. Otherwise the public GET would
  // treat this visibility-only row as "fresh" for the TTL window and serve empty
  // sections instead of triggering an upstream fetch. An existing row keeps its
  // real fetch timestamp so a genuine cached report stays fresh.
  const fetchedAt = existing?.fetchedAt ?? new Date(0);
  const frozenUntil = existing?.frozenUntil ?? null;

  const record = await whakapapaReportCache.upsert({
    where: { source: WHAKAPAPA_SOURCE },
    create: {
      source: WHAKAPAPA_SOURCE,
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt,
      frozenUntil,
    },
    update: {
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt,
      frozenUntil,
    },
  });

  return NextResponse.json({
    record: toResponseRecord(record),
    message: "Section visibility saved.",
  });
}
