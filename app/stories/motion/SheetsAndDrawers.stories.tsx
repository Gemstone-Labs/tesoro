import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import "@/app/(app)/backing/backing.css";
import { Button, Sheet } from "@/components/ui";
import { SidebarBody } from "@/components/shell/Sidebar";
import { useTiming } from "./lab";
import "./motion.css";

function SheetDemo() {
  const [open, setOpen] = useState(false);
  const { panel, rule } = useTiming({ dur: 320, ease: "cubic-bezier(0.2, 0.8, 0.2, 1)" }, "Sheet");
  return (
    <section className="sbm-panel">
      <h3>Sheet</h3>
      <p className="meta">sheet-in (ui.css:289) and the backdrop fade-in (ui.css:290). A bottom sheet on phones, a centred dialog on wide screens. Timing here sets the sheet; the backdrop keeps 240 ms.</p>
      <style>{rule("dialog.sheet[open]")}</style>
      {panel}
      <div className="sbm-row">
        <Button variant="money" onClick={() => setOpen(true)}>Open Sheet</Button>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title="Open a Position">
        <p className="meta">Close with Esc, the X or a click outside, then open it again.</p>
      </Sheet>
    </section>
  );
}

function MenuDrawerDemo() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const { panel, rule } = useTiming({ dur: 300, ease: "cubic-bezier(0.2, 0.8, 0.2, 1)" }, "Menu drawer");
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <section className="sbm-panel">
      <h3>Menu drawer</h3>
      <p className="meta">drawer-in (shell.css:117), the sidebar sliding in from the left below 1024px.</p>
      <style>{rule("dialog.drawer[open]")}</style>
      {panel}
      <div className="sbm-row">
        <Button onClick={() => setOpen(true)}>Open menu drawer</Button>
      </div>
      <dialog ref={ref} className="drawer" aria-label="Menu" onClose={() => setOpen(false)} onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
        <div className="drawer-in">
          <button type="button" className="cut icon-btn drawer-x" aria-label="Close menu" onClick={() => setOpen(false)}>
            <X aria-hidden="true" />
          </button>
          <SidebarBody onNavigate={() => setOpen(false)} />
        </div>
      </dialog>
    </section>
  );
}

function OfferDrawerDemo() {
  const [open, setOpen] = useState(false);
  const { panel, rule } = useTiming({ dur: 320, ease: "cubic-bezier(0.2, 0.8, 0.2, 1)" }, "Offer drawer");
  return (
    <section className="sbm-panel">
      <h3>Offer drawer</h3>
      <p className="meta">The Backing Offer drawer. Below 1024px it rises like a sheet (sheet-in); from 1024px it slides in from the right (bk-drawer-in, backing.css:82).</p>
      <style>{rule(".bk-drawer")}</style>
      {panel}
      <div className="sbm-row">
        <Button variant="money" onClick={() => setOpen(true)}>Open Offer drawer</Button>
      </div>
      {open && (
        <aside className="cut cut-frame bk-drawer" role="dialog" aria-label="Make an Offer">
          <div className="bk-drawer-head">
            <h2>Make an Offer</h2>
            <button type="button" className="cut icon-btn" aria-label="Close" onClick={() => setOpen(false)}>
              <X aria-hidden="true" />
            </button>
          </div>
          <p className="meta">Close it, then open it again to replay.</p>
        </aside>
      )}
    </section>
  );
}

function Demo() {
  return (
    <div className="sbm" style={{ maxWidth: 760 }}>
      <SheetDemo />
      <MenuDrawerDemo />
      <OfferDrawerDemo />
    </div>
  );
}

const meta = {
  title: "Motion/Sheets and drawers",
  component: Demo,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Demo>;
export default meta;

export const OpenAndClose: StoryObj = {};
