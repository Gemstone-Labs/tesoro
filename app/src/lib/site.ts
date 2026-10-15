import { activeCluster, type ClusterId } from "./cluster-settings";

/** The one host that search engines may index. The test host and previews never are. */
export const PRODUCTION_HOST = "www.playtesoro.com";
export const TEST_ORIGIN = "https://test.playtesoro.com";
export const PRODUCTION_ORIGIN = `https://${PRODUCTION_HOST}`;

interface SiteEnv {
  explicit?: string;
  vercelProductionUrl?: string;
  cluster: ClusterId;
  production: boolean;
}

/**
 * The public origin of this deployment, no trailing slash. NEXT_PUBLIC_SITE_URL wins; then the Vercel
 * project's production domain; then a host by cluster (test host / www) in a production build, and
 * localhost otherwise. A test-cluster build never defaults to www, so it cannot claim to be it.
 */
export function resolveSiteUrl({ explicit, vercelProductionUrl, cluster, production }: SiteEnv): string {
  const pick = explicit?.trim() || (vercelProductionUrl?.trim() ? `https://${vercelProductionUrl.trim()}` : "");
  if (pick) return pick.replace(/\/+$/, "");
  if (!production) return "http://localhost:3000";
  return cluster === "mainnet" ? PRODUCTION_ORIGIN : TEST_ORIGIN;
}

/** Only the production host is indexable; anything else (test host, previews, localhost) is noindex. */
export function isIndexable(siteUrl: string): boolean {
  try {
    return new URL(siteUrl).host === PRODUCTION_HOST;
  } catch {
    return false;
  }
}

/** Next inlines NEXT_PUBLIC_ variables only when written out in full, so the name is spelled out here. */
export const SITE_URL = resolveSiteUrl({
  explicit: process.env.NEXT_PUBLIC_SITE_URL,
  vercelProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  cluster: activeCluster().id,
  production: process.env.NODE_ENV === "production",
});
export const SITE_INDEXABLE = isIndexable(SITE_URL);
