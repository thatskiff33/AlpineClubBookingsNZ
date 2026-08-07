import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { buildStructuredAuditLogCreateArgs, getAuditRequestContext } from "@/lib/audit";
import { DEFAULT_PUBLIC_CONTENT_SETTINGS } from "@/config/club-settings-defaults";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z.object({
  membershipTypes: z.boolean(),
  entranceFees: z.boolean(),
  hutFees: z.boolean(),
  bookingPolicySummary: z.boolean(),
  cancellationPolicy: z.boolean(),
  // Dedicated {{annual-fees}} double-opt-in gate (#1933, E7).
  annualFees: z.boolean(),
  // Configurable public Book Now button (E3 #1929).
  showBookNow: z.boolean(),
  bookNowTarget: z.enum(["BOOKING_FLOW", "PAGE"]),
  bookNowPageId: z.string().min(1).nullable(),
  // Committee-roster photo display + shape (MP5, #171).
  committeePhotoDisplay: z.enum(["NONE", "CIRCLE", "SQUARE"]),
}).strict();

type Settings = {
  membershipTypes: boolean;
  entranceFees: boolean;
  hutFees: boolean;
  bookingPolicySummary: boolean;
  cancellationPolicy: boolean;
  annualFees: boolean;
  showBookNow: boolean;
  bookNowTarget: "BOOKING_FLOW" | "PAGE";
  bookNowPageId: string | null;
  committeePhotoDisplay: "NONE" | "CIRCLE" | "SQUARE";
};

// What this GET synthesises for a club that has never saved the singleton. The
// portable policy fields come from the ONE shared constant the public read path
// and the config-transfer exporter also read (#2200, #2430), so the admin panel
// can never show a different "unsaved" state than the website renders; only the
// two instance-local Book Now destination fields are declared here.
const defaults: Settings = {
  ...DEFAULT_PUBLIC_CONTENT_SETTINGS,
  bookNowTarget: "BOOKING_FLOW",
  bookNowPageId: null,
};

const settingsSelect = {
  membershipTypes: true,
  entranceFees: true,
  hutFees: true,
  bookingPolicySummary: true,
  cancellationPolicy: true,
  annualFees: true,
  showBookNow: true,
  bookNowTarget: true,
  bookNowPageId: true,
  committeePhotoDisplay: true,
} as const;

function serializeSettings(row: Settings): Settings {
  return {
    membershipTypes: row.membershipTypes,
    entranceFees: row.entranceFees,
    hutFees: row.hutFees,
    bookingPolicySummary: row.bookingPolicySummary,
    cancellationPolicy: row.cancellationPolicy,
    annualFees: row.annualFees,
    showBookNow: row.showBookNow,
    bookNowTarget: row.bookNowTarget,
    bookNowPageId: row.bookNowPageId,
    committeePhotoDisplay: row.committeePhotoDisplay,
  };
}

// Published pages offered as Book Now targets in the admin select.
async function loadPublishedPages() {
  const pages = await prisma.pageContent.findMany({
    where: { published: true },
    select: { id: true, title: true, path: true },
    orderBy: { sortOrder: "asc" },
  });
  return pages;
}

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "content", level: "view" } });
  if (!guard.ok) return guard.response;
  const [settings, pages] = await Promise.all([
    prisma.publicContentSettings.findUnique({ where: { id: "default" }, select: settingsSelect }),
    loadPublishedPages(),
  ]);
  return NextResponse.json({ settings: settings ? serializeSettings(settings) : defaults, pages });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: { area: "content", level: "edit" } });
  if (!guard.ok) return guard.response;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid settings" }, { status: 400 });

  // Book Now integrity: a PAGE target must name a published page. (Runtime also
  // fails open, but reject at write time so the admin gets clear feedback.)
  if (parsed.data.bookNowTarget === "PAGE") {
    if (!parsed.data.bookNowPageId) {
      return NextResponse.json({ error: "Select a published page for the Book Now target." }, { status: 400 });
    }
    const page = await prisma.pageContent.findUnique({
      where: { id: parsed.data.bookNowPageId },
      select: { published: true },
    });
    if (!page?.published) {
      return NextResponse.json({ error: "The selected Book Now page is not published." }, { status: 400 });
    }
  }
  // Never persist a stray page id when the target is the booking flow.
  const bookNowPageId = parsed.data.bookNowTarget === "PAGE" ? parsed.data.bookNowPageId : null;
  const writeData = { ...parsed.data, bookNowPageId };

  const actorMemberId = guard.session.user.id;

  // The published-page check above runs OUTSIDE this transaction, and since #2352
  // gave `PageContent` a supported delete there is a writer that can invalidate it
  // in the window (second review of that PR, finding S4): validate page P as
  // published, the page-content DELETE removes P and commits, and the upsert's
  // foreign key then fails with P2003 — an uncaught 500 for what is really the
  // same "that page is not available" answer the check already gives. Mapped to
  // the message the settings panel is already written to display, following the
  // raced-delete pattern in `display/templates/[id]/route.ts`. Not retried: the
  // officer's chosen target genuinely no longer exists, so re-running the same
  // body would fail identically.
  let settings: Settings;
  try {
    settings = await prisma.$transaction(async (tx) => {
      const before = await tx.publicContentSettings.findUnique({ where: { id: "default" }, select: settingsSelect });
      const saved = await tx.publicContentSettings.upsert({
        where: { id: "default" },
        update: { ...writeData, updatedByMemberId: actorMemberId },
        create: { id: "default", ...writeData, updatedByMemberId: actorMemberId },
        select: settingsSelect,
      });
      await tx.auditLog.create(buildStructuredAuditLogCreateArgs({
        action: "PUBLIC_CONTENT_SETTINGS_UPDATED",
        actor: { memberId: actorMemberId },
        entity: { type: "PublicContentSettings", id: "default" },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Public fee and policy content visibility updated",
        metadata: { before: before ? serializeSettings(before) : defaults, after: writeData },
        request: getAuditRequestContext(request),
      }));
      return saved;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return NextResponse.json({ error: "The selected Book Now page is not published." }, { status: 400 });
    }
    throw error;
  }
  revalidatePath("/", "layout");
  return NextResponse.json({ settings: serializeSettings(settings) });
}
