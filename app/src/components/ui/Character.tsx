import Image from "next/image";
import { art } from "@/lib/art";

export type BustName = keyof typeof art.busts;

/**
 * A guide character, torso up. Decorative (empty alt). Full-body poses are only for the Guide overlay.
 * `width` is the CSS pixel width; the height follows the crop's aspect. Use inside bust
 * cards and moment overlays only (DESIGN.md, Character placement).
 */
export function Bust({ name, width, className = "", priority = false }: { name: BustName; width: number; className?: string; priority?: boolean }) {
  const b = art.busts[name];
  return <Image className={`bust ${className}`} src={b.src} alt="" width={width} height={Math.round((width * b.h) / b.w)} priority={priority} />;
}

/**
 * An explainer / tip / empty-state card with a bust flush to its bottom edge (the crop ends at the
 * waist, so the card's edge is the cut). `flip` puts the bust on the right.
 */
export function BustCard({
  bust,
  size = 120,
  flip = false,
  className = "",
  children,
}: {
  bust: BustName;
  /** Bust width in px. */
  size?: number;
  flip?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`cut cut-card bust-card${flip ? " flip" : ""} ${className}`} style={{ ["--bust-w" as string]: `${size}px` }}>
      <Bust name={bust} width={size} className="bust-card-img" />
      <div className="bust-card-body">{children}</div>
    </div>
  );
}
