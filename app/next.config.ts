import type { NextConfig } from "next";

// Extra hosts allowed to load dev-only resources, e.g. a phone preview over Tailscale (comma-separated).
const nextConfig: NextConfig = { allowedDevOrigins: ["omarchy.tailde1773.ts.net", "100.91.135.33", ...(process.env.NEXT_DEV_ORIGINS?.split(",").filter(Boolean) ?? [])] };

export default nextConfig;
