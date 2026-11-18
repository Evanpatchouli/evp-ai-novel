import { useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router";
import { OverlayScrollbars } from "overlayscrollbars";
import "overlayscrollbars/overlayscrollbars.css";

const storageKey = "evp-ai-novel:main-view-scroll";

function readScrollPositions() {
  try {
    const entries = Object.entries(
      JSON.parse(sessionStorage.getItem(storageKey) ?? "{}"),
    );
    return new Map(
      entries.filter((entry): entry is [string, number] => {
        const position = entry[1];
        return (
          typeof position === "number" &&
          Number.isFinite(position) &&
          position >= 0
        );
      }),
    );
  } catch {
    return new Map<string, number>();
  }
}

export function useMainViewScroll() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef<Map<string, number> | null>(null);
  const cancelRestorationRef = useRef<(() => void) | null>(null);
  const { key, pathname, search, hash } = useLocation();
  const entryKey = `${key}:${pathname}${search}${hash}`;

  useLayoutEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!host || !viewport || !content) return;

    const scrollbars = OverlayScrollbars(
      { target: host, elements: { viewport, content, padding: false } },
      {
        overflow: { x: "hidden", y: "scroll" },
        scrollbars: {
          theme: "os-theme-workbench",
          visibility: "auto",
          autoHide: "scroll",
          autoHideDelay: 650,
          clickScroll: "instant",
        },
      },
    );
    // CSS transitions can resize the page without a mutation at the end.
    const contentResize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => scrollbars.update(true));
    contentResize?.observe(content);

    return () => {
      contentResize?.disconnect();
      scrollbars.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!host || !viewport || !content) return;

    const positions = (positionsRef.current ??= readScrollPositions());
    const position = positions.get(entryKey);
    let observer: ResizeObserver | undefined;

    const savePosition = () => {
      if (!observer) positions.set(entryKey, viewport.scrollTop);
    };
    const stopWaiting = () => {
      observer?.disconnect();
      observer = undefined;
    };
    const cancelRestoration = () => {
      if (observer) {
        stopWaiting();
        savePosition();
      }
    };
    const persistPositions = () => {
      savePosition();
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify(Object.fromEntries(positions)),
        );
      } catch {
        // Keep in-memory navigation history if session storage is unavailable.
      }
    };

    viewport.scrollTop = position ?? 0;
    if (
      position !== undefined &&
      viewport.scrollTop + 1 < position &&
      typeof ResizeObserver !== "undefined"
    ) {
      // A returning route can load its content after the scroll position is applied.
      observer = new ResizeObserver(() => {
        viewport.scrollTop = position;
        if (viewport.scrollTop + 1 >= position) stopWaiting();
      });
      observer.observe(content);
      observer.observe(viewport);
    } else if (position === undefined && hash) {
      try {
        const anchor = document.getElementById(
          decodeURIComponent(hash.slice(1)),
        );
        if (anchor && content.contains(anchor)) anchor.scrollIntoView();
      } catch {
        // A malformed fragment keeps the view at the top.
      }
    }

    const inputEvents = ["pointerdown", "wheel", "keydown"] as const;
    cancelRestorationRef.current = cancelRestoration;
    for (const event of inputEvents) {
      host.addEventListener(event, cancelRestoration, {
        capture: true,
        passive: true,
      });
    }
    viewport.addEventListener("scroll", savePosition, { passive: true });
    window.addEventListener("pagehide", persistPositions);
    return () => {
      stopWaiting();
      cancelRestorationRef.current = null;
      for (const event of inputEvents) {
        host.removeEventListener(event, cancelRestoration, true);
      }
      viewport.removeEventListener("scroll", savePosition);
      window.removeEventListener("pagehide", persistPositions);
    };
  }, [entryKey, hash]);

  const scrollToTop = () => {
    cancelRestorationRef.current?.();
    viewportRef.current?.scrollTo({
      top: 0,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };

  return { hostRef, viewportRef, contentRef, scrollToTop };
}
