import { notFound } from "next/navigation";
import { PosterGem } from "@/components/landing/gem/PosterGem";

/** Dev only: the gem at its rest pose on transparency, captured by scripts/render-gem-poster.mjs. */
export default function GemPoster() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PosterGem />;
}
