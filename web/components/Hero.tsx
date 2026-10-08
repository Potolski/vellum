"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Ctas } from "./brand";
import { Redacted, useReducedMotion } from "./motion";

type View = "public" | "holder" | "auditor";
const VIEWS: { id: View; label: string }[] = [
  { id: "public", label: "Public" },
  { id: "holder", label: "Holder" },
  { id: "auditor", label: "Auditor" },
];

const CAPTIONS: Record<View, ReactNode> = {
  public: (
    <>
      <b>Public.</b> Every holder listed. Every amount encrypted.
    </>
  ),
  holder: (
    <>
      <b>Holder.</b> Your key decrypts your row only.
    </>
  ),
  auditor: (
    <>
      <b>Auditor.</b> The issuer’s key decrypts the full register.
    </>
  ),
};

// Illustrative register. Northwind Robotics is fictional; nothing here is
// read from chain.
const HOLDERS = [
  { address: "7xKp…m3fQ", jurisdiction: "US", attestation: "KYC · ACCR", shares: "650", mine: true },
  { address: "4Rt9…Wn2c", jurisdiction: "US", attestation: "KYC", shares: "12,400" },
  { address: "9bQe…Lk7d", jurisdiction: "GB", attestation: "KYC", shares: "3,180" },
  { address: "Hf2M…8sVu", jurisdiction: "SG", attestation: "KYC · ACCR", shares: "88,000" },
  { address: "Dq7N…b4Rx", jurisdiction: "DE", attestation: "KYC", shares: "2,975" },
];

const FIRST_ADVANCE_MS = 2800;
const ADVANCE_EVERY_MS = 3200;
const BARS_DRAW_AFTER_MS = 900;
const BAR_STAGGER_MS = 160;

export function Hero() {
  const reduce = useReducedMotion();
  const [view, setView] = useState<View>("public");
  const [barsDrawn, setBarsDrawn] = useState(false);
  // The tour through the three views stops for good at the first sign the
  // visitor wants to drive.
  const [touring, setTouring] = useState(true);
  const stopTour = useCallback(() => setTouring(false), []);
  const position = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setBarsDrawn(true), BARS_DRAW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!touring || reduce) return;
    let interval: ReturnType<typeof setInterval>;
    const advance = () => {
      position.current = (position.current + 1) % VIEWS.length;
      setView(VIEWS[position.current].id);
    };
    const start = setTimeout(() => {
      interval = setInterval(advance, ADVANCE_EVERY_MS);
    }, FIRST_ADVANCE_MS);
    return () => {
      clearTimeout(start);
      clearInterval(interval);
    };
  }, [touring, reduce]);

  return (
    <section className="hero" aria-labelledby="h1">
      <div className="h-copy">
        <span className="lbl">The confidential share register</span>
        <h1 id="h1">
          Registered.
          <br />
          <i>Not revealed.</i>
        </h1>
        <p className="h-sub">
          Tokenized stocks on Solana with KYC rules enforced and balances encrypted.
        </p>
        <Ctas />
      </div>

      <div className="h-desk">
        <div className="viewas">
          <span>View as</span>
          <div className="seg" role="group" aria-label="View the register as">
            {VIEWS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => {
                  stopTour();
                  setView(id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="sheets" onMouseEnter={stopTour}>
          <div className="sheet-back" aria-hidden="true" />
          <div className="paper doc" data-view={view}>
            <div className="holes" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <span className="clip" aria-hidden="true" />
            <div className="dh">
              <div>
                <b>Northwind Robotics, Inc.</b>
                <small>Register of holders · Class A</small>
              </div>
              <div className="fol">
                Folio 12
                <br />
                2026-10-08
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Holder</th>
                  <th>Jur.</th>
                  <th className="col-att">Attestation</th>
                  <th>Shares</th>
                </tr>
              </thead>
              <tbody>
                {HOLDERS.map((holder, index) => (
                  <tr key={holder.address} className={holder.mine ? "mine" : undefined}>
                    <td>
                      {holder.address}
                      {holder.mine && <span className="you">You</span>}
                    </td>
                    <td>{holder.jurisdiction}</td>
                    <td className="col-att">{holder.attestation}</td>
                    <td>
                      <Redacted
                        className={holder.mine ? "mine" : undefined}
                        drawn={barsDrawn}
                        delay={index * BAR_STAGGER_MS}
                        onToggle={stopTour}
                      >
                        {holder.shares}
                      </Redacted>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="df">
              <div className="sig">
                <b>M. Okafor</b>
                <i />
                Transfer agent
              </div>
              <div className="stamp">
                Amounts encrypted
                <br />
                ElGamal · Token-2022
              </div>
            </div>
          </div>
        </div>

        <p className="h-cap" aria-live="polite">
          {CAPTIONS[view]}
        </p>
      </div>
    </section>
  );
}
