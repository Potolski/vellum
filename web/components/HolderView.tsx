"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CLAIMS, explorer, isAddress, loadHolder, type Holder } from "@/lib/chain";
import {
  DERIVATION_MESSAGE,
  decryptAvailable,
  decryptPending,
  deriveViewingKeys,
  type ViewingKeys,
} from "@/lib/confidential";
import { DEMO_HOLDERS, DEMO_MINT, type DemoHolder } from "@/lib/demo";
import { connectWallet, hasWallet, signMessage } from "@/lib/wallet";
import { KeyRound } from "./brand";

/** Whose position is on the desk, and where the key to read it comes from. */
type Subject =
  | { kind: "demo"; holder: DemoHolder }
  | { kind: "wallet"; owner: string }
  | { kind: "lookup"; owner: string };

const ownerOf = (subject: Subject) =>
  subject.kind === "demo" ? subject.holder.owner : subject.owner;

const JURISDICTIONS: Record<number, string> = {
  276: "DE",
  408: "KP",
  702: "SG",
  826: "GB",
  840: "US",
};

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

const hex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function amount(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = (raw / unit).toLocaleString("en-US");
  return decimals === 0 ? whole : `${whole}.${(raw % unit).toString().padStart(decimals, "0")}`;
}

function describeAttestation(holder: Holder, now: number): { text: string; valid: boolean } {
  const record = holder.attestation.record;
  if (!record) return { text: "none", valid: false };
  const claims = [
    record.claims & CLAIMS.KYC && "KYC",
    record.claims & CLAIMS.ACCREDITED && "ACCR",
    record.claims & CLAIMS.VENUE && "VENUE",
  ].filter(Boolean);
  const where = JURISDICTIONS[record.jurisdiction] ?? (record.jurisdiction || null);
  const expired = record.expiresAt !== 0 && record.expiresAt < now;
  const until = record.expiresAt
    ? `${expired ? "expired" : "to"} ${new Date(record.expiresAt * 1000).toISOString().slice(0, 10)}`
    : "no expiry";
  return { text: [claims.join(" · "), where, until].filter(Boolean).join(" · "), valid: !expired };
}

export function HolderView() {
  const [subject, setSubject] = useState<Subject>({ kind: "demo", holder: DEMO_HOLDERS[0] });
  const [holder, setHolder] = useState<Holder | null>(null);
  const [keys, setKeys] = useState<ViewingKeys | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [walletFound, setWalletFound] = useState(false);
  const [lookup, setLookup] = useState("");
  const [now] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => setWalletFound(hasWallet()), []);

  const owner = ownerOf(subject);
  useEffect(() => {
    let stale = false;
    setHolder(null);
    setKeys(null);
    setError(null);
    loadHolder(owner, DEMO_MINT)
      .then((loaded) => !stale && setHolder(loaded))
      .catch((cause: Error) => !stale && setError(cause.message));
    return () => {
      stale = true;
    };
  }, [owner]);

  /** Runs a wallet step, turning a refusal into a message rather than a crash. */
  const attempt = useCallback(async (step: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet declined.");
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = () =>
    attempt(async () => setSubject({ kind: "wallet", owner: await connectWallet() }));

  const unlock = () => {
    if (subject.kind === "demo" && subject.holder.viewing) {
      const { ae, elgamal } = subject.holder.viewing;
      setKeys({ ae: hex(ae), elgamal: BigInt(`0x${elgamal}`) });
    } else if (subject.kind === "wallet") {
      attempt(async () => setKeys(deriveViewingKeys(await signMessage(DERIVATION_MESSAGE))));
    }
  };

  const state = holder?.account.state ?? null;
  const confidential = state?.confidential ?? null;
  const attestation = holder ? describeAttestation(holder, now) : null;

  // Decryption is local: the keys never leave this page.
  const available = keys && confidential ? decryptAvailable(keys.ae, confidential.decryptableAvailable) : null;
  const pending =
    keys && confidential ? decryptPending(keys.elgamal, confidential.pendingLo, confidential.pendingHi) : null;
  const wrongKey = keys !== null && confidential !== null && available === null;
  const decimals = holder?.decimals ?? 0;

  const canUnlock =
    confidential !== null &&
    keys === null &&
    ((subject.kind === "demo" && subject.holder.viewing !== undefined) || subject.kind === "wallet");

  return (
    <div className="hv">
      <div className="hv-pick">
        <div className="viewas">
          <span>Read as</span>
          <div className="seg" role="group" aria-label="Demo holder">
            {DEMO_HOLDERS.map((demo) => (
              <button
                key={demo.owner}
                type="button"
                aria-pressed={subject.kind === "demo" && subject.holder === demo}
                onClick={() => setSubject({ kind: "demo", holder: demo })}
              >
                {demo.name}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="btn btn-s" onClick={connect} disabled={busy || !walletFound}>
          {subject.kind === "wallet" ? `Connected ${short(subject.owner)}` : "Connect your wallet"}
        </button>
        <form
          className="hv-lookup"
          onSubmit={(event) => {
            event.preventDefault();
            if (isAddress(lookup.trim())) setSubject({ kind: "lookup", owner: lookup.trim() });
            else setError("That is not a Solana address.");
          }}
        >
          <label htmlFor="hv-address">Or look up any wallet</label>
          <input
            id="hv-address"
            value={lookup}
            onChange={(event) => setLookup(event.target.value)}
            placeholder="Wallet address"
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className="btn btn-s">
            Look up
          </button>
        </form>
      </div>

      <p className="hv-note" aria-live="polite">
        {error ??
          (subject.kind === "demo"
            ? subject.holder.note
            : subject.kind === "wallet"
              ? "Your wallet. Signing a message derives your viewing key; it is not a transaction."
              : "Public view. Without the holder's key there is nothing more to read.")}
        {!walletFound && !error && subject.kind === "demo" && " No wallet extension found in this browser."}
      </p>

      <div className="cmp">
        <div>
          <span className="lbl-m">Public</span>
          <h3>What the chain shows</h3>
          <div className="paper receipt">
            <div className="rh">Token account · devnet</div>
            <Row k="Owner" v={<a href={explorer(owner)}>{short(owner)}</a>} />
            <Row k="Mint" v={<a href={explorer(DEMO_MINT)}>{short(DEMO_MINT)}</a>} />
            {!holder ? (
              <Row k="Status" v={error ? "unavailable" : "reading devnet…"} />
            ) : (
              <>
                <Row
                  k="Attestation"
                  v={
                    <a
                      href={explorer(holder.attestation.address)}
                      style={{ color: attestation?.valid ? "var(--pos)" : "var(--neg)" }}
                    >
                      {attestation?.text}
                    </a>
                  }
                />
                <Row
                  k="Account"
                  v={
                    state ? (
                      <a href={explorer(holder.account.address)}>{short(holder.account.address)}</a>
                    ) : (
                      "not opened"
                    )
                  }
                />
                {state && (
                  <>
                    <Row
                      k="State"
                      v={
                        <span style={{ color: state.frozen ? "var(--neg)" : "var(--pos)" }}>
                          {state.frozen ? "Frozen" : "Thawed"}
                        </span>
                      }
                    />
                    <Row
                      k="Encrypted balance"
                      v={
                        confidential
                          ? confidential.approved
                            ? "approved by Vellum"
                            : "awaiting approval"
                          : "not configured"
                      }
                    />
                    {confidential && (
                      <Row k="Available" v={`${base64(confidential.available).slice(0, 22)}…`} />
                    )}
                  </>
                )}
                {holder.policy.paused && <Row k="Mint" v="paused by the issuer" />}
              </>
            )}
            <div className="tot">
              <span>Balance</span>
              <b>{state ? amount(state.publicBalance, decimals) : "0"}</b>
            </div>
          </div>
        </div>

        <div>
          <span className="lbl-m">Private</span>
          <h3>What the holder reads</h3>
          <div className="paper hstmt">
            <span className="keytag">
              <KeyRound />
              {subject.kind === "wallet" ? "Your key" : "Viewing key"}
            </span>
            <Row k="Available" v={<Sealed value={available} decimals={decimals} empty={!confidential} />} />
            <Row k="Pending" v={<Sealed value={pending} decimals={decimals} empty={!confidential} />} />
            <Row k="Also readable by" v="Issuer auditor key" />
            <div className="tot">
              <span style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}>Balance</span>
              <b>
                <Sealed
                  value={available !== null && pending !== null ? available + pending : null}
                  decimals={decimals}
                  empty={!confidential}
                />
              </b>
            </div>
            <div className="hv-act">
              {canUnlock && (
                <button type="button" className="btn hv-unlock" onClick={unlock} disabled={busy}>
                  {subject.kind === "wallet" ? "Sign to read your balance" : "Read with the viewing key"}
                </button>
              )}
              {wrongKey && <p>This key does not open this account.</p>}
              {available !== null && <p>Decrypted in this browser. Nothing was sent anywhere.</p>}
              {holder && !confidential && (
                <p>
                  {state
                    ? "No encrypted position: this account was never approved to hold one."
                    : "No account for this mint. One opened today would be born frozen."}
                </p>
              )}
              {confidential && !canUnlock && keys === null && (
                <p>Only this wallet&rsquo;s key, or the issuer&rsquo;s auditor key, reads these.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

/** A figure that stays under its bar until a key has decrypted it. `empty`
 *  means there is no ciphertext at all, so there is nothing to put a bar on. */
function Sealed({
  value,
  decimals,
  empty,
}: {
  value: bigint | null;
  decimals: number;
  empty: boolean;
}) {
  if (value !== null) return <>{amount(value, decimals)}</>;
  if (empty) return <>—</>;
  return (
    <span className="sealed">
      <span aria-hidden="true">000.00</span>
      <span className="sr">Encrypted</span>
    </span>
  );
}
