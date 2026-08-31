import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveSession } from "@/lib/session-guards";
import {
  applyRateLimit,
  checkRateLimit,
  rateLimitedResponse,
  rateLimiters,
} from "@/lib/rate-limit";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getOperationalAnthropicApiKey } from "@/lib/ai-assistant-config";
import {
  checkAiBudget,
  isAiMeteringHealthy,
  recordAiUsage,
} from "@/lib/ai-assistant-usage";
import { AI_ASSISTANT_MODEL, answerHelpQuestion } from "@/lib/anthropic-client";
import { buildHelpGrounding } from "@/lib/help/grounding";
import type { HelpSurface } from "@/lib/help/types";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  canOpenAdminPath,
  hasFinanceViewerAccess,
} from "@/lib/admin-permissions";
import { prisma } from "@/lib/prisma";
import { reportAiError } from "@/lib/observability-bridge";

// POST /api/help/chat — the grounded AI help assistant (#2211, epic #2094 C3).
//
// GROUNDING INVARIANT (restated from src/lib/help/grounding.ts): the model's
// only source of truth is the trusted server-side page-help corpus, serialised
// by buildHelpGrounding(surface, pathname) from the DB-free corpus keyed by
// (effective surface, pathname). Client-supplied `pageContext` is NEVER mixed
// into that grounding string — it travels ONLY in the final user turn, wrapped
// and labelled as untrusted data by answerHelpQuestion. The surface used for
// grounding is the DB-verified EFFECTIVE surface, never the claimed one.
//
// This route degrades gracefully: it returns a structured 200 "fallback" (never
// a 404) when the module is off, the key is missing, the budget is exhausted, or
// the provider/metering is unavailable, so a curated help panel still renders.

const TURN_MAX_CHARS = 2000;
const MAX_TRANSCRIPT_TURNS = 8;

const bodySchema = z
  .object({
    pathname: z
      .string()
      .min(1)
      .max(300)
      .regex(/^\//, "pathname must start with /"),
    surface: z.enum(["admin", "finance", "member"]),
    question: z.string().min(1).max(1000),
    transcript: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1).max(TURN_MAX_CHARS),
          })
          .strict(),
      )
      .max(MAX_TRANSCRIPT_TURNS),
    pageContext: z.string().max(4000).optional(),
  })
  .strict();

type FallbackReason =
  | "module_off"
  | "not_configured"
  | "budget_exhausted"
  | "unavailable";

function fallback(reason: FallbackReason): NextResponse {
  return NextResponse.json({ status: "fallback", reason });
}

/**
 * Resolve the EFFECTIVE help surface from the member's DB-loaded access roles.
 * A claimed "admin"/"finance" surface is honoured only when the member actually
 * holds that access — otherwise it is downgraded to "member". Uses the roles
 * read fresh from the database (joined definitions), never the JWT-carried
 * claim, so a stale token can never widen the grounding surface.
 *
 * THE ADMIN SURFACE IS RESOLVED PER PATH, NOT PER PORTAL STANDING (#2984/#2975).
 * `pathname` is client-supplied, and the grounding it selects is the help entry
 * for THAT admin screen — so answering "are you an admin at all" here would
 * hand any administrator the page help for every area of the product, whichever
 * ones they hold. It asks whether this caller could actually OPEN the screen
 * they are asking about instead, by calling the SAME `canOpenAdminPath` that
 * `guardAdminLayout` step 6 calls when they navigate there — including its two
 * adjudicated special cases, the consolidated fee console's bookings-OR-finance
 * rule (#1933) and the ADR-002 admission surface. Nobody legitimate loses
 * anything: a caller asking about the page they are standing on passes by
 * construction. Holding a path's own area implies holding at least one, so this
 * subsumes portal standing rather than needing a second check for it.
 *
 * A refused claim degrades to the member corpus rather than erroring, exactly
 * as an unheld "finance" claim already did.
 */
async function resolveEffectiveSurface(
  claimed: "admin" | "finance" | "member",
  memberId: string,
  pathname: string,
): Promise<HelpSurface> {
  if (claimed === "member") return "member";

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT } },
  });
  const input = { accessRoles: member?.accessRoles ?? [] };

  if (claimed === "admin") {
    return canOpenAdminPath(input, pathname) ? "admin" : "member";
  }
  return hasFinanceViewerAccess(input) ? "finance" : "member";
}

export async function POST(request: Request) {
  // 1. Active session (its own 401/403).
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const memberId = guard.session.user.id;

  // 2 + 3. Rate limits run BEFORE the body is parsed, so an unparseable or
  // oversized body still gets throttled. Per-IP first, then per-member.
  const ipLimited = await applyRateLimit(rateLimiters.aiChatIp, request);
  if (ipLimited) return ipLimited;

  const memberLimit = await checkRateLimit(rateLimiters.aiChatMember, memberId);
  if (!memberLimit.success) return rateLimitedResponse(memberLimit);

  // 4. Parse + validate the body (strict).
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { pathname, surface, question, transcript, pageContext } = parsed.data;

  // 5. Module flag (fail-closed → module_off fallback).
  const flags = await loadEffectiveModuleFlags();
  if (!flags.aiAssistant) return fallback("module_off");

  // 6. Global backstop limiter (a fallback, not a 429).
  const globalLimit = await checkRateLimit(rateLimiters.aiChatGlobal, "global");
  if (!globalLimit.success) return fallback("unavailable");

  // 7. Metering circuit breaker: can't-meter ⇒ don't-spend.
  if (!isAiMeteringHealthy()) return fallback("unavailable");

  // 8. Monthly spend cap (fails closed → budget_exhausted).
  const budget = await checkAiBudget();
  if (!budget.allowed) return fallback("budget_exhausted");

  // 9. Operational key (missing/needs-reentry → not_configured).
  const apiKey = await getOperationalAnthropicApiKey();
  if (!apiKey) return fallback("not_configured");

  // 10. DB-verified surface downgrade, then trusted grounding.
  const effectiveSurface = await resolveEffectiveSurface(
    surface,
    memberId,
    pathname,
  );
  const groundingText = buildHelpGrounding(effectiveSurface, pathname);

  // 11. Ask the model; meter BOTH outcomes; respond.
  const startedAt = Date.now();
  const result = await answerHelpQuestion({
    apiKey,
    groundingText,
    pathname,
    transcript,
    question,
    pageContext,
  });
  const durationMs = Date.now() - startedAt;

  await recordAiUsage({
    memberId,
    surface: effectiveSurface,
    pathname,
    model: AI_ASSISTANT_MODEL,
    success: result.ok,
    usage: result.usage,
    errorCode: result.ok ? null : result.code,
    durationMs,
    questionChars: question.length,
  });

  if (result.ok) {
    const remainingExchanges = Math.floor(
      (MAX_TRANSCRIPT_TURNS - transcript.length) / 2,
    );
    return NextResponse.json({
      status: "answered",
      answer: result.answer,
      truncated: result.truncated,
      remainingExchanges,
    });
  }

  // Every provider error surfaces to the client as a generic "unavailable"
  // fallback (never the underlying code). An auth failure is additionally
  // bridged to Sentry — it means the stored API key is bad and an operator must
  // re-enter it. The question text is never logged.
  if (result.code === "auth") {
    reportAiError({
      tag: "ai-chat-auth",
      message:
        "AI help assistant provider rejected the API key (authentication error) — re-enter the Anthropic key",
      context: { surface: effectiveSurface, pathname },
    });
  }
  return fallback("unavailable");
}
