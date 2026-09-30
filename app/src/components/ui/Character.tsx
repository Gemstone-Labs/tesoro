import Image from "next/image";
import { art } from "@/lib/art";

export type CharacterName = keyof typeof art.characters;

/**
 * A guide character. Decorative (empty alt). `desktopOnly` hides it below 1024px; otherwise size it
 * with `width` (px). Wide art (duo) is 2:1.
 */
export function Character({
  name,
  width,
  desktopOnly = false,
  className = "",
  priority = false,
}: {
  name: CharacterName;
  width: number;
  desktopOnly?: boolean;
  className?: string;
  priority?: boolean;
}) {
  const wide = name === "duoWin" || name === "duoHero";
  return (
    <Image
      className={`character${desktopOnly ? " desktop-only" : ""} ${className}`}
      src={art.characters[name]}
      alt=""
      width={width}
      height={wide ? width / 2 : width}
      priority={priority}
    />
  );
}
