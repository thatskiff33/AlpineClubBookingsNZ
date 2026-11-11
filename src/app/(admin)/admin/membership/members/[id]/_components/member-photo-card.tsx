"use client";

import { MemberPhotoEditor } from "@/components/member-photo-editor";
import type { MemberDetail } from "../_types";

interface MemberPhotoCardProps {
  member: Pick<
    MemberDetail,
    "id" | "firstName" | "lastName" | "photoImageId" | "photoUpdatedAt"
  >;
  /**
   * Membership-edit gate (#1997/#2065). Tri-state: only `true` lets the admin
   * upload/replace/remove; `false`/`undefined` renders a read-only view. The MP2
   * endpoint enforces the same `membership:edit` permission server-side.
   */
  canEdit: boolean | undefined;
}

/**
 * Admin member-detail photo control (epic #171, MP4). Renders the shared
 * {@link MemberPhotoEditor} in admin mode at the top of the Contact & Personal
 * group, gated on membership-edit. Mutations go through the member-scoped MP2
 * endpoints (audited server-side); a read-only admin sees the photo but no
 * controls.
 */
export function MemberPhotoCard({ member, canEdit }: MemberPhotoCardProps) {
  return (
    <div className="mb-6 border-b pb-6">
      <h3 className="mb-4 text-sm font-semibold text-foreground">Photo</h3>
      <MemberPhotoEditor
        mode="admin"
        canEdit={canEdit}
        memberId={member.id}
        memberName={`${member.firstName} ${member.lastName}`.trim()}
        initialHasPhoto={member.photoImageId !== null}
        initialPhotoVersion={member.photoUpdatedAt}
      />
    </div>
  );
}
