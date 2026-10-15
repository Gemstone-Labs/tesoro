import type { MetadataRoute } from "next";

/** robots.txt for a host: crawlers are allowed on the production host and refused everywhere else. */
export function robotsFor(siteUrl: string, indexable: boolean): MetadataRoute.Robots {
  if (!indexable) return { rules: { userAgent: "*", disallow: "/" } };
  return { rules: { userAgent: "*", allow: "/", disallow: ["/api/"] }, host: siteUrl };
}
