/**
 * Save the sidebar's role-menu choice (epic #4468, C14 #4811).
 *
 * The cookie changes the menu only. This handler never reads it back to
 * decide access. While admin hubs are off it answers 404 before any
 * authentication, the same JSON a switched-off module route sends, so the
 * address cannot be told apart from one that is not there.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { MEMBER_PRIVILEGE_CHECK_SELECT } from "@/lib/access-role-definitions";
import { ADMIN_HUBS_LIVE } from "@/lib/admin-hubs/release";
import {
  ADMIN_MENU_ROLE_COOKIE,
  adminMenuRoleCookieOptions,
  resolveAdminMenu,
} from "@/lib/admin-menu-role";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const bodySchema = z.object({
  role: z.union([z.string().min(1), z.null()]),
});

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function invalid(): NextResponse {
  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}

/** 404 while hubs are off, before auth. Otherwise the method is not this route. */
async function unsupportedMethod(): Promise<NextResponse> {
  if (!ADMIN_HUBS_LIVE) return notFound();
  const guard = await requireAdmin({ permission: "any-admin" });
  if (!guard.ok) return guard.response;
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}

export async function GET() {
  return unsupportedMethod();
}

export async function PUT() {
  return unsupportedMethod();
}

export async function PATCH() {
  return unsupportedMethod();
}

export async function DELETE() {
  return unsupportedMethod();
}

export async function HEAD() {
  return unsupportedMethod();
}

export async function OPTIONS() {
  return unsupportedMethod();
}

export async function POST(request: Request) {
  if (!ADMIN_HUBS_LIVE) return notFound();

  const guard = await requireAdmin({ permission: "any-admin" });
  if (!guard.ok) return guard.response;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return invalid();
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return invalid();

  const member = await prisma.member.findUnique({
    where: { id: guard.session.user.id },
    select: MEMBER_PRIVILEGE_CHECK_SELECT,
  });
  if (!member?.canLogin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const secure = process.env.NODE_ENV === "production";
  const { role } = parsed.data;
  if (role !== null) {
    const held = resolveAdminMenu(member, null).roles.some(
      (choice) => choice.token === role,
    );
    if (!held) return invalid();
  }

  const response = NextResponse.json({ ok: true });
  if (role === null) {
    response.cookies.set(ADMIN_MENU_ROLE_COOKIE, "", {
      ...adminMenuRoleCookieOptions(secure),
      maxAge: 0,
    });
  } else {
    response.cookies.set(
      ADMIN_MENU_ROLE_COOKIE,
      role,
      adminMenuRoleCookieOptions(secure),
    );
  }
  return response;
}
