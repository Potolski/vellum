"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react";

/** True once we know the visitor asked for reduced motion. */
export function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduce(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduce;
}

/** Whether the nearest `Reveal` has scrolled into view. */
const InView = createContext(true);

type RevealProps = {
  as?: ElementType;
  className?: string;
  id?: string;
  /** Skip the fade-up and only flag the block as in view (adds `in`). */
  bare?: boolean;
  children: ReactNode;
};

/** Fades a block up when a quarter of it is in view, once, and lets the
 *  redaction bars inside it know they can draw on. */
export function Reveal({ as: Tag = "div", className = "", id, bare, children }: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Already scrolled past (deep link, restored scroll position): show
        // it now, so scrolling back up never meets a blank block.
        const passed = entry.boundingClientRect.bottom < 0;
        if (!entry.isIntersecting && !passed) return;
        setInView(true);
        observer.disconnect();
      },
      { threshold: 0.25, rootMargin: "0px 0px -8% 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const classes = [className, bare ? "" : "rv", inView ? "in" : ""].filter(Boolean).join(" ");
  return (
    <Tag ref={ref} id={id} className={classes}>
      <InView.Provider value={inView}>{children}</InView.Provider>
    </Tag>
  );
}

type RedactedProps = {
  /** Who can read the figure underneath. A bar is never shipped without it. */
  who?: string;
  /** Draw the bar on. Defaults to "when the surrounding Reveal is in view". */
  drawn?: boolean;
  /** Delay before the bar draws on, in ms. */
  delay?: number;
  /** Anchor the label to the left edge instead of the right. */
  alignLeft?: boolean;
  className?: string;
  onToggle?: () => void;
  children: ReactNode;
};

/** A figure under a redaction bar. The real value stays in the DOM; the bar
 *  lifts on hover, focus or tap, and is always labelled with who can read it. */
export function Redacted({
  who = "Holder · Auditor key",
  drawn,
  delay = 400,
  alignLeft,
  className = "",
  onToggle,
  children,
}: RedactedProps) {
  const inView = useContext(InView);
  const shouldDraw = drawn ?? inView;
  const [on, setOn] = useState(false);
  const [open, setOpen] = useState(false);
  const labelId = useId();

  useEffect(() => {
    if (!shouldDraw) return;
    const timer = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(timer);
  }, [shouldDraw, delay]);

  const toggle = () => {
    setOpen((value) => !value);
    onToggle?.();
  };

  const classes = ["rx", on ? "on" : "", open ? "open" : "", alignLeft ? "l" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={classes}
      tabIndex={0}
      aria-describedby={labelId}
      onClick={(event) => {
        event.stopPropagation();
        toggle();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      }}
    >
      {children}
      <i className="bar" aria-hidden="true" />
      <span className="who" id={labelId} role="tooltip">
        Visible to {who}
      </span>
    </span>
  );
}
