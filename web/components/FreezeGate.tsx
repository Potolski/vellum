"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Redacted, Reveal, useReducedMotion } from "./motion";

type Step = {
  title: string;
  body: ReactNode;
  /** What the account tag shows while this step is current. */
  attestation: string;
  attestationColor?: string;
  stamp: string;
  stampClass?: string;
};

const STEPS: Step[] = [
  {
    title: "Born frozen",
    body: (
      <>
        The mint sets <code>DefaultAccountState = Frozen</code>. Every new account starts unusable.
      </>
    ),
    attestation: "none",
    stamp: "Frozen",
  },
  {
    title: "Thawed if attested",
    body: (
      <>
        <code>thaw_if_attested</code> opens the account only while its owner holds a valid
        attestation.
      </>
    ),
    attestation: "KYC · valid to 2027-03-31",
    attestationColor: "var(--pos)",
    stamp: "Thawed",
    stampClass: "ok",
  },
  {
    title: "Refrozen if invalid",
    body: (
      <>
        When an attestation expires or is revoked, anyone can call{" "}
        <code>refreeze_if_invalid</code>. Frozen, never seized.
      </>
    ),
    attestation: "expired 2027-03-31",
    attestationColor: "var(--neg)",
    stamp: "Refrozen",
  },
];

const ADVANCE_EVERY_MS = 2600;

export function FreezeGate() {
  const reduce = useReducedMotion();
  const [current, setCurrent] = useState(0);
  // The cycle resumes from wherever the visitor last pointed.
  const position = useRef(0);
  const jumpTo = (index: number) => {
    position.current = index;
    setCurrent(index);
  };

  useEffect(() => {
    if (reduce) return;
    const interval = setInterval(
      () => jumpTo((position.current + 1) % STEPS.length),
      ADVANCE_EVERY_MS
    );
    return () => clearInterval(interval);
  }, [reduce]);

  const step = STEPS[current];
  return (
    <div className="how">
      <ol className="steps">
        {STEPS.map(({ title, body }, index) => (
          <li
            key={title}
            className={index === current ? "cur" : undefined}
            onMouseEnter={() => jumpTo(index)}
            onClick={() => jumpTo(index)}
          >
            <span className="n">{index + 1}</span>
            <div>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="tagw">
        <Reveal className="paper tag">
          <span className="eye" aria-hidden="true" />
          <span className="string" aria-hidden="true" />
          <span className="k">Token account · NWRB</span>
          <div className="acct">7xKp…m3fQ</div>
          <div className="kv">
            <span>Attestation</span>
            <span style={{ color: step.attestationColor }}>{step.attestation}</span>
          </div>
          <div className="kv">
            <span>Jurisdiction</span>
            <span>US</span>
          </div>
          <div className="kv">
            <span>Balance</span>
            <span>
              <Redacted drawn delay={0}>
                650
              </Redacted>
            </span>
          </div>
          <div className="st" aria-live="polite">
            {STEPS.map(({ stamp, stampClass }, index) => (
              <span
                key={stamp}
                className={["stamp", stampClass, index === current ? "show" : ""]
                  .filter(Boolean)
                  .join(" ")}
                aria-hidden={index !== current}
              >
                {stamp}
              </span>
            ))}
          </div>
        </Reveal>
      </div>
    </div>
  );
}
