"use client";

import Link from "next/link";
import { Building2, Pencil, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";

/** What the list shows of a lodge; the page's own record carries more. */
type ListedLodge = {
  id: string;
  name: string;
  active: boolean;
  travelNote?: string | null;
};

/**
 * The "Lodge properties" card: the list of lodges with their Configure, Edit
 * and (De)activate controls. It only draws. The page owns the data, the
 * view-only decision (`canEdit`) and what Edit and (De)activate do, so a failed
 * list read (`loadFailed`, shown by the page above) and a failed action stay
 * the page's two separate states.
 *
 * The page renders the lodge-area view-only banner above this card and says so
 * with `ancestorRendersViewOnlyBanner`; rendered anywhere else, each control
 * keeps its own view-only reason (#2168).
 */
export function LodgePropertiesCard<T extends ListedLodge>({
  lodges,
  loading,
  loadFailed,
  canEdit,
  saving,
  onEdit,
  onSetActive,
  ancestorRendersViewOnlyBanner = false,
}: {
  lodges: readonly T[];
  loading: boolean;
  /** A failed read hides the list; the page shows the message itself. */
  loadFailed: boolean;
  /** Tri-state, as `ViewOnlyActionButton` takes it: undefined while the session resolves. */
  canEdit: boolean | undefined;
  saving: boolean;
  onEdit: (lodge: T) => void;
  onSetActive: (lodge: T, active: boolean) => void;
  ancestorRendersViewOnlyBanner?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          Lodge properties
        </CardTitle>
        <CardDescription>
          At least one lodge must stay active. Deactivated lodges are kept
          for history but cannot take new bookings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading lodges...</p>
        ) : loadFailed ? null : lodges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No lodges found.</p>
        ) : (
          <ul className="divide-y">
            {lodges.map((lodge) => (
              <li
                key={lodge.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{lodge.name}</span>
                    <Badge variant={lodge.active ? "default" : "secondary"}>
                      {lodge.active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  {lodge.travelNote ? (
                    <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                      {lodge.travelNote}
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/lodges/${lodge.id}`}>
                      <Settings2 className="mr-2 h-4 w-4" />
                      Configure
                    </Link>
                  </Button>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={!ancestorRendersViewOnlyBanner}
                    variant="outline"
                    size="sm"
                    onClick={() => onEdit(lodge)}
                    disabled={saving}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </ViewOnlyActionButton>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={!ancestorRendersViewOnlyBanner}
                    variant="outline"
                    size="sm"
                    onClick={() => onSetActive(lodge, !lodge.active)}
                    disabled={saving}
                  >
                    {lodge.active ? "Deactivate" : "Activate"}
                  </ViewOnlyActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
