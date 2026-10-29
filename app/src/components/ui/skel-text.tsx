import "./skel-text.css";

/**
 * A loading bar made of real text set in the real figure's font, so it takes the same line, height
 * and width the figure will take once it lands. The text is hidden and never read out. Put it inside
 * a container with `aria-busy="true"` to get the shimmer.
 */
export function SkelText({ children, className }: { children: string; className?: string }) {
  return <span className={`skel-text${className ? ` ${className}` : ""}`} aria-hidden="true">{children}</span>;
}
