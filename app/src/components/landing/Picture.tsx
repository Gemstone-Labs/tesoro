import { landingArt, largestSrc, srcSet, type LandingKey } from "@/lib/landing/art";

type Props = {
  k: LandingKey;
  sizes: string;
  className?: string;
  priority?: boolean;
  /** Served instead below 768px (the phone composition of the same scene). */
  mobile?: LandingKey;
};

/** Astra art as AVIF/WebP per width with intrinsic size (no layout shift). Decorative: empty alt. Null until delivered. */
export function Picture({ k, sizes, className, priority, mobile }: Props) {
  const a = landingArt(k);
  if (!a) return null;
  const m = mobile ? landingArt(mobile) : undefined;
  return (
    <picture className={className}>
      {m && mobile && <source media="(max-width: 767px)" type="image/avif" srcSet={srcSet(mobile, m, "avif")} sizes="100vw" />}
      {m && mobile && <source media="(max-width: 767px)" type="image/webp" srcSet={srcSet(mobile, m, "webp")} sizes="100vw" />}
      <source type="image/avif" srcSet={srcSet(k, a, "avif")} sizes={sizes} />
      <img
        src={largestSrc(k, a)}
        srcSet={srcSet(k, a, "webp")}
        sizes={sizes}
        width={a.w}
        height={a.h}
        alt=""
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
      />
    </picture>
  );
}
