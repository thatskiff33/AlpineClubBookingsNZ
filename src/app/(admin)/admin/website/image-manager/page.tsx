import { BackLink } from "@/components/admin/back-link";
import { ImageManagerClient } from "./image-manager-client";
import { adminHref } from "@/lib/admin-hubs";

export default function ImageManagerPage() {
  return (
    <div className="space-y-6">
      <BackLink href={adminHref("appearance")} label="Site Appearance & Content" />
      <ImageManagerClient />
    </div>
  );
}
