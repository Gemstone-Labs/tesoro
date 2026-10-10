import { useEffect, useState, type ComponentType } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import * as Lucide from "lucide-react";
import * as UiIcons from "@/components/ui/icons";
import { Kit, Quote, Section } from "../kit/Kit";

const meta = { title: "Foundations/Icons", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const sources = import.meta.glob(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;

/** The lucide icons the app imports, found by reading its source for `from "lucide-react"`. */
function useLucideNames() {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(Object.values(sources).map((load) => load())).then((files) => {
      const found = new Set<string>();
      for (const src of files) {
        if (typeof src !== "string") continue;
        for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
          for (const part of m[1].split(",")) {
            const name = part.trim().replace(/^type\s+.*/, "").split(/\s+as\s+/)[0].trim();
            if (/^[A-Z]\w*$/.test(name)) found.add(name);
          }
        }
      }
      if (live) setNames([...found].sort());
    });
    return () => {
      live = false;
    };
  }, []);
  return names;
}

type IconProps = { width?: number; height?: number; size?: number; strokeWidth?: number };

/** The square-cap glyphs in `ui/icons.tsx`, kept for status marks (check, cross, clock). */
export const StatusGlyphs: Story = {
  render: () => {
    const icons = Object.entries(UiIcons).filter(([, v]) => typeof v === "function") as [string, ComponentType<IconProps>][];
    return (
      <Kit>
        <Quote>The original square-cap glyphs in ui/icons.tsx remain for status marks (check, cross, clock). Confirmations carry an icon or words, never colour alone. (DESIGN.md, Components)</Quote>
        <div className="kit-grid" style={{ ["--min" as string]: "110px" }}>
          {icons.map(([name, I]) => (
            <div key={name} className="kit-icon"><I width={28} height={28} />{name}</div>
          ))}
        </div>
      </Kit>
    );
  },
};

function LineIconGrid({ size, strokeWidth }: { size: number; strokeWidth: number }) {
  const names = useLucideNames();
  const lib = Lucide as unknown as Record<string, ComponentType<IconProps>>;
  const shown = names?.filter((n) => lib[n]);
  return (
    <Section title={shown ? `${shown.length} icons in use` : "Reading the source…"}>
      <div className="kit-grid" style={{ ["--min" as string]: "120px" }}>
        {shown?.map((n) => {
          const I = lib[n];
          return <div key={n} className="kit-icon"><I size={size} strokeWidth={strokeWidth} />{n}</div>;
        })}
      </div>
    </Section>
  );
}

/** Neutral line icons used across the shell and pages. The list is read from the app's source, so a new import appears here. */
export const LineIcons: StoryObj<{ size: number; strokeWidth: number }> = {
  args: { size: 24, strokeWidth: 1.75 },
  argTypes: {
    size: { control: { type: "range", min: 12, max: 48, step: 2 } },
    strokeWidth: { control: { type: "range", min: 1, max: 3, step: 0.05 } },
  },
  render: ({ size, strokeWidth }) => (
    <Kit>
      <Quote>Neutral lucide-react line icons (1.7 to 1.8 stroke) in the shell. (DESIGN.md, Components)</Quote>
      <LineIconGrid size={size} strokeWidth={strokeWidth} />
    </Kit>
  ),
};
