"use client";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { BookingImportBatchesCard } from "@/components/admin/booking-import/booking-import-batches-card";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";

/**
 * Admin → Bookings → Import Paid Bookings (#5005, child C): a moving-in
 * club's future stays that were already paid for, carried over at what was
 * paid. Importing and reversing need finance edit and bookings edit (O4).
 */
export default function BookingImportPage() {
  const financeEdit = useAdminAreaEditAccess("finance");
  const bookingsEdit = useAdminAreaEditAccess("bookings");
  const canImport = financeEdit === undefined || bookingsEdit === undefined ? undefined : financeEdit && bookingsEdit;
  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Import Paid Bookings"
        description="Bring across future stays already paid for in your previous system. Each is stored as paid at the amount paid and holds its beds; no invoice, card payment or email is made. See the moving-in guide before you start."
      />
      <BookingImportBatchesCard canImport={canImport} />
    </div>
  );
}
