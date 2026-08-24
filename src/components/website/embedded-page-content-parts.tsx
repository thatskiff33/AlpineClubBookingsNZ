import { ContactPageClient } from "@/app/(website)/contact/contact-page-client";
import { JoinApplyPageClient } from "@/app/(website)/join/apply/join-apply-page-client";
import { BookingRequestFormEmbed } from "@/app/(website-dynamic)/booking-requests/booking-request-form-embed";
import { SchoolBookingFormEmbed } from "@/app/(website-dynamic)/school-bookings/school-booking-form-embed";
import { CommitteeMembersGrid } from "@/components/website/committee-members-grid";
import { PhotoGalleryToken } from "@/components/website/photo-gallery-token";
import { SkifieldConditionsWidget } from "@/components/website/skifield-conditions-widget";
import { SkifieldWhakapapaEmbed } from "@/components/website/skifield-whakapapa-embed";
import type { ClubIdentity } from "@/config/club-identity-types";
import type { EmbeddedBodyPart } from "@/lib/page-content-embeds";
import {
  BookingPolicyToken,
  CancellationPolicyToken,
  FeeGroupsToken,
  FeeTableToken,
} from "@/components/website/public-page-content-token";

type EmbeddedPageContentPartsProps = {
  parts: EmbeddedBodyPart[];
  pageSlug: string;
  keyPrefix?: string;
  // DB-first club identity (E3 #1929). Threaded from the resolving server page so
  // the embedded contact/join forms render the live club name instead of the
  // static config value. The (website) route group has no ClubIdentityProvider,
  // so this must come through props rather than a client hook.
  clubIdentity: ClubIdentity;
  // Contact-form context, threaded the same way as clubIdentity so a
  // {{contact-form}} embed renders the club address and the admin-configured
  // Club Details committee role. Absent on pages that do not resolve them (the
  // form then hides the address and falls back to the booking-officer heuristic).
  lodge?: { name: string; address: string | null };
  contactRoleKey?: string | null;
};

function galleryIdSlug(pageSlug: string) {
  return pageSlug.replace(/[^a-z0-9_-]+/gi, "-") || "page";
}

export function EmbeddedPageContentParts({
  parts,
  pageSlug,
  keyPrefix = "embedded",
  clubIdentity,
  lodge,
  contactRoleKey,
}: EmbeddedPageContentPartsProps) {
  const idSlug = galleryIdSlug(pageSlug);

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "committee") {
          return <CommitteeMembersGrid key={`${keyPrefix}-committee-${index}`} />;
        }

        if (part.type === "member-application-form") {
          return (
            <JoinApplyPageClient
              key={`${keyPrefix}-member-application-form-${index}`}
              club={clubIdentity}
              showHero={false}
            />
          );
        }

        if (part.type === "contact-form") {
          return (
            <ContactPageClient
              key={`${keyPrefix}-contact-form-${index}`}
              club={clubIdentity}
              lodge={lodge}
              contactRoleKey={contactRoleKey}
              showHero={false}
            />
          );
        }

        if (part.type === "booking-requests") {
          return (
            <BookingRequestFormEmbed
              key={`${keyPrefix}-booking-requests-${index}`}
              club={clubIdentity}
            />
          );
        }

        if (part.type === "school-bookings") {
          return (
            <SchoolBookingFormEmbed
              key={`${keyPrefix}-school-bookings-${index}`}
              club={clubIdentity}
            />
          );
        }

        if (part.type === "skifield-conditions") {
          return (
            <SkifieldConditionsWidget
              key={`${keyPrefix}-skifield-conditions-${index}`}
              dataHash={part.dataHash}
            />
          );
        }

        if (part.type === "skifield-whakapapa") {
          return (
            <SkifieldWhakapapaEmbed
              key={`${keyPrefix}-skifield-whakapapa-${index}`}
            />
          );
        }

        if (part.type === "photo-gallery") {
          return (
            <PhotoGalleryToken
              key={`${keyPrefix}-photo-gallery-${index}`}
              galleryId={`photo-gallery-${idSlug}-${index}`}
              variant="gallery"
              images={part.images}
            />
          );
        }

        if (part.type === "photo-slideshow") {
          return (
            <PhotoGalleryToken
              key={`${keyPrefix}-photo-slideshow-${index}`}
              galleryId={`photo-slideshow-${idSlug}-${index}`}
              variant="slideshow"
              images={part.images}
            />
          );
        }

        if (part.type === "hut-fees") return <FeeTableToken key={`${keyPrefix}-hut-fees-${index}`} idPrefix={`hut-fees-${idSlug}-${index}`} tables={part.tables} />;
        if (part.type === "joining-fees") return <FeeGroupsToken key={`${keyPrefix}-joining-fees-${index}`} groups={part.groups} />;
        if (part.type === "annual-fees") return <FeeGroupsToken key={`${keyPrefix}-annual-fees-${index}`} groups={part.groups} />;
        if (part.type === "booking-policy-summary") return <BookingPolicyToken key={`${keyPrefix}-booking-policy-${index}`} policy={part.policy} />;
        if (part.type === "cancellation-policy") return <CancellationPolicyToken key={`${keyPrefix}-cancellation-policy-${index}`} policy={part.policy} />;

        return (
          <div
            key={`${keyPrefix}-html-${index}`}
            /* Admin-authored page HTML, sanitised on write and read. nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml */
            dangerouslySetInnerHTML={{ __html: part.value }}
          />
        );
      })}
    </>
  );
}
