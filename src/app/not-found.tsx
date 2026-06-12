import Link from "next/link";
import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { getSanitizedPageContentByPath } from "@/lib/page-content-html";

export default async function NotFound() {
  const page = await getSanitizedPageContentByPath("/404");

  const heading = page?.caption?.trim() || "404";
  const title = page?.title?.trim() || "Page Not Found";
  const fallbackHeaderText =
    "The page you're looking for doesn't exist or has been moved.";
  const headerText = page?.headerText?.trim() || fallbackHeaderText;
  const hasBody = (page?.contentHtml ?? "").trim().length > 0;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center max-w-2xl mx-auto px-4">
        <h1 className="text-6xl font-bold text-gray-900 mb-4">{heading}</h1>
        <h2 className="text-2xl font-semibold text-gray-700 mb-4">{title}</h2>
        <div
          className="text-gray-500 mb-4 [&_a]:underline [&_h1]:text-3xl [&_h2]:text-2xl [&_h3]:text-xl [&_p]:mb-3"
          dangerouslySetInnerHTML={{ __html: headerText }}
        />
        {hasBody ? (
          <div
            className="text-left text-gray-600 mb-8 [&_a]:underline [&_h1]:text-3xl [&_h2]:text-2xl [&_h3]:text-xl [&_li]:ml-5 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-3"
            dangerouslySetInnerHTML={{ __html: page?.contentHtml ?? "" }}
          />
        ) : (
          <p className="text-gray-500 mb-8">Please use the links below.</p>
        )}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center px-6 py-3 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
          >
            Go Home
          </Link>
          <Link
            href={buildBookingLoginPath()}
            className="inline-flex items-center justify-center px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
          >
            Book a Stay
          </Link>
        </div>
      </div>
    </div>
  );
}
