/**
 * What the locker actions send an AI app connection (ALP-720, `INV-MCP-006`).
 * The list route also carries every active member's name for the screen's
 * allocation dropdown; a connection is sent the lockers only.
 */
import { connectionShapeFor, type ConnectionShape } from "@/lib/connection-projection";

interface LockerAnswer {
  id: string;
  name: string;
  lodgeId: string;
  allocatedToMemberId: string | null;
  allocatedTo: { id: string; firstName: string; lastName: string } | null;
}

const LOCKER_SHAPE = connectionShapeFor<LockerAnswer>({
  id: true,
  name: true,
  lodgeId: true,
  allocatedToMemberId: true,
  allocatedTo: { id: true, firstName: true, lastName: true },
});

export const LOCKER_LIST_CONNECTION_SHAPE: ConnectionShape = { lockers: LOCKER_SHAPE };

export const LOCKER_CONNECTION_SHAPE: ConnectionShape = { locker: LOCKER_SHAPE };

export const LOCKER_DELETED_CONNECTION_SHAPE = connectionShapeFor<{ success: boolean }>({ success: true });

export const LOCKER_BULK_CREATED_CONNECTION_SHAPE = connectionShapeFor<{ createdCount: number }>({
  createdCount: true,
});
