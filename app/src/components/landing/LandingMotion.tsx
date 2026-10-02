"use client";

import { useEffect } from "react";
import { gemState } from "./gem/store";

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
      const desktop = matchMedia("(min-width: 1024px)").matches;

      let stopLenis = () => {};
      if (desktop && matchMedia("(pointer: fine)").matches) {
        const { default: Lenis } = await import("lenis");
        if (cancelled) return;
        const lenis = new Lenis({ anchors: true });
        lenis.on("scroll", ScrollTrigger.update);
        const tick = (t: number) => lenis.raf(t * 1000);
        gsap.ticker.add(tick);
        gsap.ticker.lagSmoothing(0);
        stopLenis = () => (gsap.ticker.remove(tick), lenis.destroy());
      }

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

        for (const el of gsap.utils.toArray<HTMLElement>("[data-flow]").filter(below)) {
          el.classList.add("is-armed");
          ScrollTrigger.create({ trigger: el, start: "top 75%", once: true, onEnter: () => el.classList.add("is-live") });
        }

        for (const el of gsap.utils.toArray<HTMLElement>("[data-slide]").filter(below)) {
          gsap.fromTo(el, { autoAlpha: 0, x: 24 }, { autoAlpha: 1, x: 0, duration: 0.8, ease: "power2.out", scrollTrigger: { trigger: el, start: "top 80%", once: true } });
        }

        if (!desktop) return;

        const hero = document.querySelector<HTMLElement>(".lp-hero");
        if (hero) {
          const scrub = { trigger: hero, start: "top top", end: "bottom top", scrub: true };
          // Small, fixed offsets: Astra's layers hold together up to about 100 art px (60 page px) apart.
          gsap.to(".lp-hero .layer.back", { y: 60, ease: "none", scrollTrigger: scrub });
          gsap.to(".lp-hero .layer.mid", { y: 30, ease: "none", scrollTrigger: scrub });
          gsap.to("[data-hero-copy]", { autoAlpha: 0, y: -40, ease: "none", scrollTrigger: { ...scrub, end: "60% top" } });
        }

        for (const el of gsap.utils.toArray<HTMLElement>("[data-parallax]")) {
          const v = Number(el.dataset.parallax) * 100;
          gsap.fromTo(el, { yPercent: -v }, { yPercent: v, ease: "none", scrollTrigger: { trigger: el.closest("section"), start: "top bottom", end: "bottom top", scrub: true } });
        }

        const rail = document.querySelector<HTMLElement>("[data-rail]");
        if (rail) gsap.fromTo(rail, { "--rail": 0 }, { "--rail": 1, ease: "none", scrollTrigger: { trigger: rail, start: "top 75%", end: "bottom 65%", scrub: true } });

        const gemas = document.querySelector<HTMLElement>("[data-gemas]");
        if (gemas && innerHeight >= 640) {
          gemas.classList.add("is-stepped");
          ScrollTrigger.create({
            trigger: gemas,
            start: "top top",
            end: "+=200%",
            pin: true,
            onUpdate: (self) => {
              const beat = Math.min(2, Math.floor(self.progress * 3));
              if (gemState.beat !== beat) {
                gemState.beat = beat;
                gemas.dataset.beat = String(beat);
              }
            },
          });
        }

        for (const el of gsap.utils.toArray<HTMLElement>("[data-wipe]")) {
          gsap.fromTo(el, { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", ease: "none", scrollTrigger: { trigger: el, start: "top 85%", end: "center 55%", scrub: true } });
        }

        const final = document.querySelector<HTMLElement>(".lp-final");
        if (final) {
          const scrub = { trigger: final, start: "top bottom", end: "bottom bottom", scrub: true };
          gsap.fromTo("[data-climb]", { y: 60 }, { y: -60, ease: "none", scrollTrigger: scrub });
          gsap.fromTo(".lp-final .layer", { y: -40 }, { y: 0, ease: "none", scrollTrigger: scrub });
        }
      });

      const refresh = () => ScrollTrigger.refresh();
      addEventListener("load", refresh);
      undo = () => {
        removeEventListener("load", refresh);
        ctx.revert();
        stopLenis();
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
