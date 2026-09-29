import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function Icon({ children, ...p }: P) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...p}
    >
      {children}
    </svg>
  );
}

export const CheckIcon = (p: P) => <Icon {...p}><path d="M4 12.5 9.5 18 20 6.5" /></Icon>;
export const XIcon = (p: P) => <Icon {...p}><path d="M5 5l14 14M19 5 5 19" /></Icon>;
export const ClockIcon = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5.5l3.5 2" /></Icon>;
export const MinusIcon = (p: P) => <Icon {...p}><path d="M6 12h12" /></Icon>;
export const ArrowIcon = (p: P) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
export const AlertIcon = (p: P) => <Icon {...p}><path d="M12 4 3 20h18L12 4zM12 10v4.5M12 17.5v.5" /></Icon>;
export const UndoIcon = (p: P) => <Icon {...p}><path d="M9 6 4 11l5 5M4 11h10a6 6 0 0 1 6 6" /></Icon>;
