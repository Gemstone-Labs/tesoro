"use client";

import { useEffect } from "react";
import { gemState } from "./gem/store";
import { howFlow, STOPS } from "./howFlow";

/**
 * Every scroll effect on the landing page, in one place. The server HTML is the complete, static page;
 * this only adds motion on top, and adds none under prefers-reduced-motion. Below 1024px: reveals and
 * count-ups only (no smooth scroll, pins, scrubs or parallax).
 */
export function LandingMotion() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let undo = () => {};
    let cancelled = false;

    (async () => {
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([import("gsap"), import("gsap/ScrollTrigger")]);
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);
      const Lenis = matchMedia("(pointer: fine)").matches ? (await import("lenis")).default : null;
      if (cancelled) return;

      const ctx = gsap.context(() => {
        const below = (el: Element) => el.getBoundingClientRect().top > innerHeight * 0.9;

        const reveals = gsap.utils.toArray<HTMLElement>("[data-reveal]").filter(below);
        gsap.set(reveals, { autoAlpha: 0, y: 16 });
        ScrollTrigger.batch(reveals, {
          start: "top 88%",
          once: true,
          onEnter: (els) => gsap.to(els, { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out", stagger: 0.08, overwrite: true }),
        });

        for (const el of gsap.utils.toArray<HTMLElement>("[data-count]").filter(below)) {
          const target = Number(el.dataset.count);
          const suffix = el.dataset.suffix ?? "";
          el.style.minWidth = `${el.offsetWidth}px`;
          const n = { v: 0 };
          ScrollTrigger.create({
            trigger: el,
            start: "top 90%",
            once: true,
            onEnter: () =>
              gsap.fromTo(n, { v: 0 }, {
                v: target,
                duration: 1.1,
                ease: "power2.out",
                onUpdate: () => void (el.textContent = `${Math.round(n.v).toLocaleString("en-US")}${suffix}`),
              }),
          });
        }


        for (const el of gsap.utils.toArray<HTMLElement>("[data-slide]").filter(below)) {
          gsap.fromTo(el, { autoAlpha: 0, x: 24 }, { autoAlpha: 1, x: 0, duration: 0.8, ease: "power2.out", scrollTrigger: { trigger: el, start: "top 80%", once: true } });
        }

      });

      // Desktop-only motion (smooth scroll, pins, scrubs, parallax) is set up and torn down with the viewport, so a
      // window resized below 1024px never keeps the Gemas pin or the smooth scroll.
      const mm = gsap.matchMedia();
      mm.add("(min-width: 1024px)", () => {
        let lenis: InstanceType<NonNullable<typeof Lenis>> | null = null;
        const tick = (t: number) => lenis?.raf(t * 1000);
        if (Lenis) {
          lenis = new Lenis({ anchors: true });
          lenis.on("scroll", ScrollTrigger.update);
          gsap.ticker.add(tick);
          gsap.ticker.lagSmoothing(0);
        }

        const hero = document.querySelector<HTMLElement>(".lp-hero");
        if (hero) {
          const scrub = { trigger: hero, start: "top top", end: "bottom top", scrub: true };
          // Small, fixed offsets: Astra's layers hold together up to about 100 art px (60 page px) apart.
          gsap.to(".lp-hero .layer.back", { y: 60, ease: "none", scrollTrigger: scrub });
          gsap.to(".lp-hero .layer.mid", { y: 30, ease: "none", scrollTrigger: scrub });
          gsap.to(".lp-hero-light .layer", { y: 50, ease: "none", scrollTrigger: scrub });
          gsap.to("[data-hero-copy]", { autoAlpha: 0, y: -40, ease: "none", scrollTrigger: { ...scrub, end: "60% top" } });
        }

        for (const el of gsap.utils.toArray<HTMLElement>("[data-parallax]")) {
          const v = Number(el.dataset.parallax) * 100;
          gsap.fromTo(el, { yPercent: -v }, { yPercent: v, ease: "none", scrollTrigger: { trigger: el.closest("section"), start: "top bottom", end: "bottom top", scrub: true } });
        }


        // How it works is the page's peak: held longer than Gemas while the scroll draws the flow node by node.
        const how = document.querySelector<HTMLElement>("[data-how]");
        if (how && innerHeight >= 760) {
          const apply = (progress: number) => {
            const f = howFlow(progress);
            f.tubes.forEach((t, i) => how.style.setProperty(`--h-tube${i}`, t.toFixed(3)));
            for (const s of STOPS) how.style.setProperty(`--h-${s}`, f.nodes[s].toFixed(3));
          };
          how.classList.add("is-held");
          apply(0);
          ScrollTrigger.create({ trigger: how, start: "top top", end: "+=160%", pin: true, onUpdate: (self) => apply(self.progress) });
        }

        const gemas = document.querySelector<HTMLElement>("[data-gemas]");
        if (gemas && innerHeight >= 760) {
          gemas.classList.add("is-stepped");
          ScrollTrigger.create({
            trigger: gemas,
            start: "top top",
            end: "+=200%",
            pin: true,
            onUpdate: (self) => {
              // Past the pin every point reads at full strength; scrolling back in steps them again.
              gemas.classList.toggle("is-stepped", self.progress < 1);
              const beat = Math.min(2, Math.floor(self.progress * 3));
              if (gemState.beat !== beat) {
                gemState.beat = beat;
                gemas.dataset.beat = String(beat);
              }
            },
          });
        }


        const final = document.querySelector<HTMLElement>(".lp-final");
        if (final) {
          const scrub = { trigger: final, start: "top bottom", end: "bottom bottom", scrub: true };
          gsap.fromTo("[data-climb]", { y: 40 }, { y: -20, ease: "none", scrollTrigger: scrub });
          gsap.fromTo(".lp-final .layer", { y: -40 }, { y: 0, ease: "none", scrollTrigger: scrub });
        }
        return () => {
          gsap.ticker.remove(tick);
          lenis?.destroy();
          document.querySelector("[data-gemas]")?.classList.remove("is-stepped");
          document.querySelector<HTMLElement>("[data-how]")?.removeAttribute("style");
          document.querySelector("[data-how]")?.classList.remove("is-held");
          gemState.beat = 0;
        };
      });

      const refresh = () => ScrollTrigger.refresh();
      addEventListener("load", refresh);
      undo = () => {
        removeEventListener("load", refresh);
        mm.revert();
        ctx.revert();
        gemState.beat = 0;
      };
    })();

    return () => {
      cancelled = true;
      undo();
    };
  }, []);

  return null;
}
