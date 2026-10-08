"use client";

import { useEffect, useState } from "react";
import { Github, LINKS, Wordmark } from "./brand";

export function Nav() {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={stuck ? "nav stuck" : "nav"} id="top">
      <Wordmark label="Vellum, home" />
      <a className="l" href="#how">
        How it works
      </a>
      <a className="l" href="#hides">
        What it hides
      </a>
      <a className="l" href={LINKS.specConfidential}>
        Spec
      </a>
      <a className="gh" href={LINKS.repo} aria-label="Vellum on GitHub">
        <Github />
        <span>GitHub</span>
      </a>
    </header>
  );
}
