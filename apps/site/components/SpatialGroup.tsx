"use client";

import { useEffect, useRef, Children } from "react";
import { motion } from "framer-motion";
import { useReducedMotion } from "./useReducedMotion";
import { staggerContainer } from "@/lib/motion";

/**
 * Puts a grid of cards into the same 3D space as the WebGL stage behind it.
 *
 * WHY CSS 3D AND NOT WEBGL GEOMETRY
 * ---------------------------------
 * The obvious reading of "make the cards 3D" is drei's `<Html transform>`, or
 * card geometry with the copy baked into a texture. Both were rejected:
 *
 *  - Text rendered into WebGL is not text. It leaves the accessibility tree,
 *    stops being selectable, stops being findable with the browser's own
 *    find-in-page, and resolves to whatever the texture resolution happens to
 *    be. For a page whose entire job is explaining a product, that is a bad
 *    trade for a visual effect.
 *  - `<Html transform>` keeps real DOM but binds its screen position to the
 *    camera. Under prefers-reduced-motion this scene's camera is deliberately
 *    frozen at the opening framing, so every section the camera would
 *    otherwise travel to becomes unreachable — the page would be genuinely
 *    broken for those users, not merely stiller.
 *
 * So the cards stay real DOM in normal document flow — accessible,
 * selectable, reflowable, correct with JS disabled — and are placed *in
 * depth* with real 3D CSS transforms on a shared perspective. The container
 * establishes the perspective origin; each card is positioned on an arc
 * (outer cards yawed inward, like panels angled toward a viewer at the
 * centre) and pushed back in Z proportional to its distance from the
 * viewport centre. The reader moves *through* the grid rather than past it,
 * in the same apparent space as the constellation rendering behind it.
 *
 * MECHANICS
 * ---------
 * Framer Motion owns `transform` on the cards themselves (the scroll-in
 * reveal), so the depth transform cannot also live there — the two would
 * overwrite each other every frame. Each card therefore gets a wrapper
 * element that this component owns exclusively. `itemAs` keeps that wrapper
 * semantically correct: an `ol` grid wraps its cards in `li`, so the list
 * semantics survive the extra element.
 *
 * The rAF loop writes only `transform` and `opacity` — both compositor-only,
 * so no layout and no paint — and never touches React state.
 *
 * Under prefers-reduced-motion the loop never starts, no perspective is
 * established, and no transform is ever written: an ordinary flat, fully
 * legible grid.
 */
export function SpatialGroup({
  children,
  className,
  as = "div",
  itemAs = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "ol";
  itemAs?: "div" | "li";
}) {
  const reducedMotion = useReducedMotion();
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const items = Array.from(container.children) as HTMLElement[];

    const clear = () => {
      for (const item of items) {
        item.style.transform = "";
        item.style.opacity = "";
      }
    };

    // Depth choreography is a wide-viewport device. In a single-column
    // layout the grid is a tall stack, most of it is far from the viewport
    // centre at any moment, and applying the same falloff there pushes cards
    // back and fades them to near-invisibility while the reader is trying to
    // read them. Narrow viewports get the flat grid — the same honest
    // degradation the WebGL stage makes on the low tier.
    const enabled = () => !reducedMotion && window.innerWidth >= 768;

    let frame = 0;

    const update = () => {
      frame = requestAnimationFrame(update);
      if (!enabled()) return;

      const vh = window.innerHeight || 1;
      // The container itself is never transformed, so its box is a stable
      // reference. Item offsets are layout values (unaffected by the
      // transforms written below), which avoids a read/write feedback loop.
      const rect = container.getBoundingClientRect();
      const width = container.offsetWidth || 1;

      for (const item of items) {
        const centerY = rect.top + item.offsetTop + item.offsetHeight / 2;
        // Per CARD, not per grid: a 2x2 grid's two rows should arrive
        // separately, and a tall stack should never dim as a single block.
        const t = Math.max(-1.2, Math.min(1.2, (centerY - vh / 2) / vh));
        const away = Math.abs(t);

        // Lateral position within the row, from real layout — so the fan
        // adapts to whatever column count the responsive grid resolved to.
        const lateral =
          (item.offsetLeft + item.offsetWidth / 2 - width / 2) / width;

        // Outer cards yaw toward the centre of the arc; the yaw relaxes as
        // the card leaves centre screen so nothing presents an extreme,
        // unreadable angle.
        const yaw = -lateral * 26 * (1 - away * 0.4);
        const depth = -(away * 200 + Math.abs(lateral) * 120);

        item.style.transform =
          `translate3d(0, ${(t * 26).toFixed(2)}px, ${depth.toFixed(2)}px)` +
          ` rotateX(${(t * 6).toFixed(2)}deg) rotateY(${yaw.toFixed(2)}deg)`;
        // Floor raised to 0.55: this is body copy, and depth must never cost
        // enough contrast to make it hard to read.
        item.style.opacity = String(Math.max(0.55, 1 - away * 0.4));
      }
    };

    const onResize = () => {
      if (!enabled()) clear();
    };

    frame = requestAnimationFrame(update);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      clear();
    };
  }, [reducedMotion]);

  const Container = as === "ol" ? motion.ol : motion.div;
  const Item = itemAs === "li" ? "li" : "div";

  return (
    <Container
      // The container is also the Framer stagger parent for the cards inside
      // it — variant context passes down through the plain wrappers.
      ref={containerRef as never}
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.2 }}
      variants={staggerContainer(reducedMotion)}
      style={
        reducedMotion
          ? undefined
          : {
              // `relative` makes the container the offsetParent, so the
              // per-item offsetTop/offsetLeft reads above are relative to it.
              position: "relative",
              perspective: "1500px",
              perspectiveOrigin: "50% 50%",
              transformStyle: "preserve-3d",
            }
      }
    >
      {Children.map(children, (child, i) => (
        <Item
          key={i}
          className="[transform-style:preserve-3d] [will-change:transform,opacity]"
        >
          {child}
        </Item>
      ))}
    </Container>
  );
}
