import { redirect } from "next/navigation";

import { FoodOrderSettingsSection } from "@/components/admin/food-orders/food-order-settings-section";
import { guardAdminLayout } from "@/lib/admin-layout-guard";

/**
 * Food Orders — the admin settings page (fork #121). Lodge Operations: view to
 * read the card, edit to change it.
 *
 * `guardAdminLayout()` is re-run here rather than trusted from the parent
 * layout, as on the Lodge Maintenance page. The `foodOrders` module gates this
 * page through its hub registry entry, so with the module off it is a 404 and
 * this file never runs; its settings API re-checks the module as well.
 */

export const metadata = { title: "Food Orders" };

export default async function FoodOrdersAdminPage() {
  const guard = await guardAdminLayout();
  if (guard.outcome === "redirect") redirect(guard.destination);

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Food Orders</h1>
        <p className="text-sm text-muted-foreground">
          Where members&apos; food orders are emailed, and what your club calls
          the person who buys the food. Members place orders and see their own,
          and hut leaders and committee members see every order, under Food
          orders in the members&apos; area.
        </p>
      </header>

      <FoodOrderSettingsSection />
    </div>
  );
}
