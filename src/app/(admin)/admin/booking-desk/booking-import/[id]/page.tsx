"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { BookingImportBatchDetail } from "@/components/admin/booking-import/booking-import-batch-detail";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { adminLink } from "@/lib/admin-hubs";

/** One paid-booking import batch: its totals, its bookings and Reverse (#5005, child C). */
export default function BookingImportBatchPage() {
  const { id } = useParams<{ id: string }>();
  const financeEdit = useAdminAreaEditAccess("finance");
  const bookingsEdit = useAdminAreaEditAccess("bookings");
  const canReverse = financeEdit === undefined || bookingsEdit === undefined ? undefined : financeEdit && bookingsEdit;
  const back = adminLink("booking-import");
  return (
    <div className="space-y-6">
      <Link href={back.href} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        Back to {back.label}
      </Link>
      <AdminPageHeader title="Import Batch" />
      <BookingImportBatchDetail batchId={id} canReverse={canReverse} />
    </div>
  );
}
