import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The landing moved from /welcome to /; keep old links working.
  async redirects() {
    return [{ source: "/welcome", destination: "/", permanent: false }];
  },
};

export default nextConfig;
