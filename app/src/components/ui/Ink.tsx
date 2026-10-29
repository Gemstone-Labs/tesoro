/** Placeholder text: a faint block with the line box of the text it stands in for, so a skeleton is as tall as the loaded content. */
export function Ink({ className, children = "00" }: { className?: string; children?: string }) {
  return <span className={`skel-ink${className ? ` ${className}` : ""}`}>{children}</span>;
}
