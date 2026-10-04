"use client";

import { useEffect } from "react";

// iOS Safari overlays the on-screen keyboard instead of resizing the layout
// viewport, so in-flow layouts end up behind it. When the visual viewport
// shrinks by more than KEYBOARD_THRESHOLD px we treat the keyboard as open:
// expose the visual viewport height as --vvh (the body's height), tag <html>
// with data-keyboard (hides the bottom nav), and cancel iOS auto-panning.
//
// The threshold plus the scale guard keep pinch-zoom and orientation changes
// from triggering any of this — those also fire visualViewport resize.
const KEYBOARD_THRESHOLD = 150;

export default function KeyboardViewportSync() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;

    const onResize = () => {
      const pinchZoomed = vv.scale > 1.01;
      const delta = window.innerHeight - vv.height;
      const keyboardOpen = !pinchZoomed && delta > KEYBOARD_THRESHOLD;

      if (keyboardOpen) {
        root.style.setProperty("--vvh", `${vv.height}px`);
        root.setAttribute("data-keyboard", "open");
        window.scrollTo(0, 0);
      } else {
        root.style.removeProperty("--vvh");
        root.removeAttribute("data-keyboard");
      }
    };

    vv.addEventListener("resize", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      root.style.removeProperty("--vvh");
      root.removeAttribute("data-keyboard");
    };
  }, []);

  return null;
}
