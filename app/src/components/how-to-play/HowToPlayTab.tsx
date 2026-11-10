import { BookOpen } from "lucide-react";
import "./how-to-play.css";

/** The How to play tab (founder pick b4): hung from the top right corner of a Game's art. */
export function HowToPlayTab({ name, onClick, className }: { name: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={className ? `htp-tab ${className}` : "htp-tab"} onClick={onClick}>
      <BookOpen aria-hidden="true" /> How to play<span className="sr-only"> {name}</span>
    </button>
  );
}
