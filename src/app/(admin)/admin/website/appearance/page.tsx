import {
  BadgeInfo,
  FilePenLine,
  Images,
  Megaphone,
  Mountain,
  Palette,
  PanelBottom,
} from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { adminLink, getAdminPage } from "@/lib/admin-hubs";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

/** A card's link and title: the page's `adminHref` and its registry label. */
const card = ({ href, label }: { href: string; label: string }) => ({ href, title: label });

const sections: AdminHubSection[] = [
  {
    ...card(adminLink("club-identity")),
    description:
      "Set the club name, short name, hut-leader label, and your lodge's public details.",
    icon: BadgeInfo,
  },
  {
    ...card(adminLink("site-style")),
    description:
      "Set the public theme, logo, colours, fonts, and first-run style completion.",
    icon: Palette,
  },
  {
    ...card(adminLink("site-content")),
    description:
      "Edit shared public site chrome such as footer columns and reusable site text.",
    icon: PanelBottom,
  },
  {
    ...card(adminLink("page-content")),
    description:
      "Manage public website pages, menus, rich text, tokens, and publishing state.",
    icon: FilePenLine,
  },
  {
    ...card(adminLink("site-banners")),
    description:
      "Publish dated notice banners for public visitors and signed-in members.",
    icon: Megaphone,
  },
  {
    ...card(adminLink("mountain-conditions")),
    description:
      "Configure Snow.nz condition widgets and public mountain condition content.",
    icon: Mountain,
  },
  {
    ...card(adminLink("image-manager")),
    description:
      "Upload and organise filesystem images used by public content editors.",
    icon: Images,
  },
];

export default async function AppearanceHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <AdminHubPage
      title={getAdminPage("appearance").label}
      description="Manage the public site's style, editable content, banners, images, and mountain condition widgets."
      sections={sections}
      features={features}
    />
  );
}
