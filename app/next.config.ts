import type { NextConfig } from "next";

// Extra hosts allowed to load dev-only resources, e.g. a phone preview over Tailscale (comma-separated).
const nextConfig: NextConfig = { allowedDevOrigins: process.env.NEXT_DEV_ORIGINS?.split(",").filter(Boolean) };

export default nextConfig;
