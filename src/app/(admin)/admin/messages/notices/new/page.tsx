"use client";

import { BackLink } from "@/components/admin/back-link";
import { NoticeEditor } from "@/components/admin/notice-editor";
import { adminHref } from "@/lib/admin-hubs";

export default function NewNoticePage() {
  return (
    <div className="space-y-4">
      <BackLink href={adminHref("notices")} label="Member notices" />
      <NoticeEditor mode="create" />
    </div>
  );
}
