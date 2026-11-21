import { notFound } from "next/navigation";

import { FoodOrderPageClient } from "@/components/food-orders/food-order-page-client";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

/**
 * Order food (fork #121). The module is checked here as well as by the proxy's
 * feature-route rule, so the page 404s with the module off even if the edge gate
 * were bypassed, the same as `/food-orders`. The form itself is client-side.
 */

export const metadata = { title: "Order food" };

export default async function FoodOrderPage() {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.foodOrders) notFound();
  return <FoodOrderPageClient />;
}
