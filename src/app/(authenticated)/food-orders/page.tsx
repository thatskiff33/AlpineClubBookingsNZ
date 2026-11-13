import Link from "next/link";
import { notFound } from "next/navigation";
import { ShoppingBasket } from "lucide-react";

import { FoodOrderHistory } from "@/components/food-orders/food-order-history";
import { Button } from "@/components/ui/button";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

/**
 * Food order history (fork #121). A member sees their own orders; committee
 * members, current hut leaders and Lodge Operations admins see every order,
 * with filters and the totals the club forecasts from. Which of the two a
 * viewer gets is decided by the history API (`canViewAllFoodOrders`).
 *
 * The module is checked here as well as by the proxy's feature-route rule, so
 * the gate does not live only in middleware. `?order=<id>` (the link in the
 * food officer's email) highlights that order when it is on the page shown.
 */

export const metadata = { title: "Food orders" };

export default async function FoodOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.foodOrders) notFound();

  const { order } = await searchParams;
  const highlightOrderId = typeof order === "string" ? order : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ShoppingBasket className="h-6 w-6" aria-hidden="true" />
          Food orders
        </h1>
        <Button asChild>
          <Link href="/food-order">Order food</Link>
        </Button>
      </div>
      <FoodOrderHistory highlightOrderId={highlightOrderId} />
    </div>
  );
}
