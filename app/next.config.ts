import type { NextConfig } from "next";

// Extra hosts allowed to load dev-only resources, e.g. a phone preview over Tailscale (comma-separated).
const nextConfig: NextConfig = {
  allowedDevOrigins: process.env.NEXT_DEV_ORIGINS?.split(",").filter(Boolean),
  // The Wallet is now the Advanced view of the Vault. Next passes the query string through (`/wallet?open=1` keeps `open=1`).
  // `/wallet/opening` is its own route and is not matched by this exact source.
  redirects: async () => [{ source: "/wallet", destination: "/vault", permanent: false }],
};

export default nextConfig;
