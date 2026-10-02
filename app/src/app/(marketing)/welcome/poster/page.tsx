import { notFound } from "next/navigation";
import { PosterScene, type PosterKind } from "@/components/landing/PosterScene";

const KINDS: PosterKind[] = ["gem", "chains-wide", "chains-tall"];

/** Dev only: a 3D scene at rest on transparency, in either theme's palette, captured by scripts/render-landing-posters.mjs. */
export default async function Poster({ searchParams }: { searchParams: Promise<{ scene?: string; theme?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { scene, theme } = await searchParams;
  const kind = KINDS.find((k) => k === scene) ?? "gem";
  return <PosterScene kind={kind} theme={theme === "light" ? "light" : "dark"} />;
}
