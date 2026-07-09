import { cn } from "@/lib/utils";

interface BrandLogoProps {
  className?: string;
  decorative?: boolean;
}

export default function BrandLogo({
  className,
  decorative = true,
}: BrandLogoProps): React.ReactElement {
  return (
    <img
      src="/logo.png"
      alt={decorative ? "" : "TokenPanel"}
      aria-hidden={decorative || undefined}
      className={cn("block shrink-0 rounded-[22%] object-cover", className)}
    />
  );
}
