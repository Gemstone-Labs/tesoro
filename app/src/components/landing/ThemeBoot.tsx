import { THEME_KEY } from "./theme";
import { ThemeCleanup } from "./ThemeCleanup";

/** Runs before first paint: the stored choice, else the system preference, else dark. */
const BOOT = `(function(){var t;try{t=localStorage.getItem("${THEME_KEY}")}catch(e){}if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.dataset.theme=t})()`;

export function ThemeBoot() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      <ThemeCleanup />
    </>
  );
}
