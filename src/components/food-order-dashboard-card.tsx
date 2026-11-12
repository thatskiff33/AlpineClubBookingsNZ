import Link from "next/link";
import { ShoppingBasket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The dashboard's Order food card (fork #121), beside "Report an issue". The
 * dashboard renders it only while the `foodOrders` module is on; organisation
 * accounts, who cannot order, are not shown it.
 */
export function FoodOrderDashboardCard() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Food Orders</CardTitle>
        <ShoppingBasket className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-lg font-semibold">Need food for your stay?</div>
        <p className="text-xs text-muted-foreground mt-1">
          Order it for the lodge, and see whether it has arrived.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link href="/food-order">Order food</Link>
          </Button>
          <Button asChild size="sm" variant="ghost" className="w-full">
            <Link href="/food-orders">My food orders</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
