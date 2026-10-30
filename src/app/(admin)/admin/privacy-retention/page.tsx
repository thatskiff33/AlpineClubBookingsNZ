import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { guardAdminLayout } from "@/lib/admin-layout-guard";
import { PrivacyRetentionClient } from "./privacy-retention-client";

export const metadata: Metadata = { title: "Privacy & Retention" };

export default async function PrivacyRetentionPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; memberCursor?: string | string[] }>;
}) {
  const guard = await guardAdminLayout("/admin/privacy-retention");
  if (guard.outcome === "redirect") redirect(guard.destination);
  const query = await searchParams;
  const requestedPage = Number(query.page ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const memberCursors = typeof query.memberCursor === "string" ? [query.memberCursor] : query.memberCursor ?? [];
  return <PrivacyRetentionClient key={`${page}:${memberCursors.join(":")}`} page={page} memberCursors={memberCursors} />;
}
