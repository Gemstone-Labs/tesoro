"use client";

import { useEffect } from "react";
import { chainsState } from "./chains/store";
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
          // The copy leaves with the scroll, faster than the page, and is gone by a third of the hero so it never ghosts over the art.
          gsap.to("[data-hero-copy]", { autoAlpha: 0, y: -140, ease: "none", scrollTrigger: { ...scrub, end: "35% top" } });
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
          ScrollTrigger.create({ trigger: how, start: "top top", end: "+=130%", pin: true, onUpdate: (self) => apply(self.progress) });
        }

        const gemas = document.querySelector<HTMLElement>("[data-gemas]");
        if (gemas && innerHeight >= 760) {
          gemas.classList.add("is-stepped", "is-scrubbed");
          gemas.style.setProperty("--g-sweep", "0");
          ScrollTrigger.create({
            trigger: gemas,
            start: "top top",
            end: "+=120%",
            pin: true,
            onUpdate: (self) => {
              // Past the pin every point reads at full strength; scrolling back in steps them again.
              gemas.classList.toggle("is-stepped", self.progress < 1);
              // The vitrine's outline sweep runs one lap over the pin, tied to the scroll.
              gemas.style.setProperty("--g-sweep", self.progress.toFixed(4));
              const beat = Math.min(2, Math.floor(self.progress * 3));
              if (gemState.beat !== beat) {
                gemState.beat = beat;
                gemas.dataset.beat = String(beat);
              }
            },
          });
        }


        // Multichain: the streams reach the Tesoro ledger by the time the section is centred.
        const chains = document.querySelector<HTMLElement>("#multichain");
        if (chains) {
          const apply = (progress: number) => {
            chainsState.progress = progress;
            chains.dataset.chainsProgress = progress.toFixed(2);
          };
          apply(0);
          ScrollTrigger.create({ trigger: chains, start: "top bottom", end: "center center", onUpdate: (self) => apply(self.progress), onRefresh: (self) => apply(self.progress) });
        }

        // Backing: the two Requests behind the Offer card fan out as the section arrives.
        const backing = document.querySelector<HTMLElement>("[data-backing]");
        if (backing) {
          backing.classList.add("is-fanned");
          backing.style.setProperty("--b-fan", "0");
          ScrollTrigger.create({
            trigger: backing.querySelector(".lp-backing-stage"),
            start: "top 90%",
            end: "top 45%",
            onUpdate: (self) => backing.style.setProperty("--b-fan", self.progress.toFixed(4)),
          });
        }

        // Studios: the Pot ring's arcs draw in to today's proportions as the section arrives.
        const pot = document.querySelector<HTMLElement>(".lp-pot");
        if (pot) {
          pot.classList.add("is-drawn");
          pot.style.setProperty("--p-draw", "0");
          ScrollTrigger.create({
            trigger: pot,
            start: "top 85%",
            end: "top 40%",
            onUpdate: (self) => pot.style.setProperty("--p-draw", self.progress.toFixed(4)),
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
          document.querySelector("[data-gemas]")?.classList.remove("is-stepped", "is-scrubbed");
          document.querySelector<HTMLElement>("[data-gemas]")?.style.removeProperty("--g-sweep");
          document.querySelector<HTMLElement>("[data-how]")?.removeAttribute("style");
          document.querySelector("[data-how]")?.classList.remove("is-held");
          const backing = document.querySelector<HTMLElement>("[data-backing]");
          backing?.classList.remove("is-fanned");
          backing?.style.removeProperty("--b-fan");
          const pot = document.querySelector<HTMLElement>(".lp-pot");
          pot?.classList.remove("is-drawn");
          pot?.style.removeProperty("--p-draw");
          gemState.beat = 0;
          chainsState.progress = 1;
          document.querySelector<HTMLElement>("#multichain")?.removeAttribute("data-chains-progress");
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
