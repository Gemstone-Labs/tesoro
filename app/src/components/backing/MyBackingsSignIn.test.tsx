import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MyBackingsSignIn } from "./MyBackingsSignIn";

const findClick = (n: ReactNode): (() => void) | null => {
  if (!isValidElement(n)) return Array.isArray(n) ? n.map(findClick).find(Boolean) ?? null : null;
  const props = (n as ReactElement<{ onClick?: () => void; children?: ReactNode }>).props;
  return props.onClick ?? findClick(props.children);
};

describe("My Backings sign-in invite", () => {
  it("asks to sign in and never shows the empty state", () => {
    const html = renderToStaticMarkup(<MyBackingsSignIn onSignIn={() => {}} />);
    expect(html).toContain("Sign in to see them");
    expect(html).toContain("Sign in</button>");
    expect(html).not.toContain("No Backings yet");
  });
  it("wires the button to the sign-in action", () => {
    const onSignIn = vi.fn();
    findClick(MyBackingsSignIn({ onSignIn }))?.();
    expect(onSignIn).toHaveBeenCalledOnce();
  });
});
