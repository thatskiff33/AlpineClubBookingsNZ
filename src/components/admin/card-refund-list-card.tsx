"use client";

import { useState, type ReactNode } from "react";
import { CreditCard } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The stuck-states page's card refund lists' shared frame
 * (`dead-card-refunds-panel.tsx`), split out of that file unchanged (#4210).
 *
 * #3924 round 9 (UX): a list's card, once it has had a row, stays for as long
 * as the page is open - also after its last row is closed or resolved - so the
 * status line focus moves to after the action is still there, and the card
 * says the list is empty. A list that never had a row renders nothing.
 */
export function useShownOnceItHadRows(rowCount: number): boolean {
  const [shown, setShown] = useState(rowCount > 0);
  // Adjusted while rendering, as React's derived-state pattern does.
  if (!shown && rowCount > 0) setShown(true);
  return shown;
}

export function RefundListCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
