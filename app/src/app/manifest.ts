import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tesoro",
    short_name: "Tesoro",
    description: "Play now with yield you haven't earned yet. Skill games on Solana; your staking Principal is never played.",
    start_url: "/",
    display: "standalone",
    background_color: "#0C0E10",
    theme_color: "#0C0E10",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
