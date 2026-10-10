import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { Card } from "@/components/ui";
import { useTiming } from "./lab";
import "./motion.css";

function Demo() {
  const [n, setN] = useState(0);
  const { panel, rule } = useTiming({ dur: 450, ease: "cubic-bezier(0.2, 0.8, 0.2, 1)" }, "Page in");
  return (
    <>
      <style>{rule(".app-main")}</style>
      <div className="sbm-note" style={{ flexWrap: "wrap", maxWidth: "min(720px, 96vw)" }}>
        <button type="button" className="sbm-btn primary" onClick={() => setN((v) => v + 1)}>
          Replay
        </button>
        {panel}
      </div>
      <AppShell key={n}>
        <Card>
          <h2>Any page</h2>
          <p className="meta">Every page rises 10px and fades in (page-in, shell.css:169). Press Replay to see the whole shell arrive.</p>
        </Card>
      </AppShell>
    </>
  );
}

const meta = {
  title: "Motion/Page in",
  component: Demo,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Demo>;
export default meta;

export const AppMain: StoryObj = {};
