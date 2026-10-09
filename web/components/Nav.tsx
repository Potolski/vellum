"use client";

import Link from "next/link";
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
      <Link className="l" href="/#how">
        How it works
      </Link>
      <Link className="l" href="/#hides">
        What it hides
      </Link>
      <Link className="l" href="/holder">
        Holder view
      </Link>
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
