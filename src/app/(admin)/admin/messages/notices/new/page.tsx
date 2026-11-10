"use client";

import { BackLink } from "@/components/admin/back-link";
import { NoticeEditor } from "@/components/admin/notice-editor";
import { adminLink } from "@/lib/admin-hubs";

export default function NewNoticePage() {
  return (
    <div className="space-y-4">
      <BackLink {...adminLink("notices")} />
      <NoticeEditor mode="create" />
    </div>
  );
}
