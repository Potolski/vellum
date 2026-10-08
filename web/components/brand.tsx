export const LINKS = {
  repo: "https://github.com/Potolski/vellum",
  spec: "https://github.com/Potolski/vellum/blob/main/SPEC.md",
  specConfidential: "https://github.com/Potolski/vellum/blob/main/SPEC-confidential.md",
};

/** The mark: a redaction bar with a V cut out of it. */
export function Mark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path fill="currentColor" d="M2 9h9.2l4.8 8.4L20.8 9H30v14H2z" />
    </svg>
  );
}

export function Wordmark({ label }: { label: string }) {
  return (
    <a className="wordmark" href="#top" aria-label={label}>
      <Mark />
      <span>Vellum</span>
    </a>
  );
}

// Lucide icons, inlined so the page ships no icon font or runtime.
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function ArrowRight() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke} strokeWidth={1.8}>
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

export function Github() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke} strokeWidth={1.8}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

export function KeyRound() {
  return (
    <svg viewBox="0 0 24 24" width={12} height={12} aria-hidden="true" {...stroke} strokeWidth={2}>
      <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
    </svg>
  );
}

/** The two calls to action, shared by the hero and the close. */
export function Ctas() {
  return (
    <div className="ctas">
      <a className="btn btn-p" href={LINKS.specConfidential}>
        Read the spec
        <ArrowRight />
      </a>
      <a className="btn btn-s" href={LINKS.repo}>
        <Github />
        View on GitHub
      </a>
    </div>
  );
}
