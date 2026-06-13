import { cn } from "@/lib/utils";

type WebsiteLogoProps = {
  label: string;
  logoDataUrl?: string | null;
  className?: string;
  textClassName?: string;
};

export function WebsiteLogo({
  label,
  logoDataUrl,
  className,
  textClassName,
}: WebsiteLogoProps) {
  if (logoDataUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoDataUrl}
        alt={label}
        className={cn("h-10 w-auto object-contain", className)}
      />
    );
  }

  return (
    <span
      data-website-heading="true"
      className={cn("font-heading text-lg font-bold leading-tight", textClassName)}
    >
      {label}
    </span>
  );
}
