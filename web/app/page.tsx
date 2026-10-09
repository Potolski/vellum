import { Ctas, KeyRound, LINKS, Wordmark } from "@/components/brand";
import { FreezeGate } from "@/components/FreezeGate";
import { Hero } from "@/components/Hero";
import { Redacted, Reveal } from "@/components/motion";
import { Nav } from "@/components/Nav";

// Every figure on this page is illustrative and static. The register and the
// accounts (Northwind Robotics, NWRB) are fictional, and the numbers agree
// with each other: received 1,100 - sent 450 = 650.

export default function Page() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Why />
        <Problem />
        <How />
        <Hides />
        <Modes />
        <Tradeoffs />
        <Close />
      </main>
      <footer>
        <Wordmark label="Vellum, back to top" />
        <span>The confidential share register · Solana</span>
        <nav>
          <a href={LINKS.repo}>GitHub</a>
          <a href={LINKS.spec}>SPEC.md</a>
          <a href={LINKS.specConfidential}>SPEC-confidential.md</a>
        </nav>
      </footer>
    </>
  );
}

function Why() {
  return (
    <section className="sec" id="why">
      <div className="wrap why">
        <Reveal as="blockquote">
          Every US stock is already held privately, registered to one nominee,{" "}
          <em>Cede &amp; Co.</em> Beneficial owners are known only down the custody chain. We
          rebuilt that on Solana.
        </Reveal>
        <Reveal className="paper nominee">
          <span
            className="clip"
            style={{ right: 150, transform: "rotate(-5deg)" }}
            aria-hidden="true"
          />
          <div className="rh">
            <span>Holder of record</span>
            <span>US equities</span>
          </div>
          <div className="r">
            <b>Cede &amp; Co.</b>
            <span className="pct">83%</span>
          </div>
          <p className="note">
            One name on the register. The beneficial owners behind it are known to their brokers,
            not to the market.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function Problem() {
  return (
    <section className="sec" id="problem">
      <div className="wrap">
        <Reveal className="sec-h">
          <span className="lbl">The problem</span>
          <h2>
            On Solana, a security could be compliant or confidential. <i>Never both.</i>
          </h2>
        </Reveal>
        <Reveal bare className="prob">
          <div className="paper ext a">
            <span className="k">Token-2022 extension</span>
            <h3>TransferHook</h3>
            <p>Runs the issuer&rsquo;s policy on every transfer. It is handed the plaintext amount.</p>
          </div>
          <div className="paper ext b">
            <span className="k">Token-2022 extension</span>
            <h3>ConfidentialTransfer</h3>
            <p>ElGamal-encrypted balances and amounts, with an optional auditor key.</p>
          </div>
          <span className="stamp big">
            Not allowed
            <br />
            on the same mint
          </span>
        </Reveal>
        <Reveal className="answer">
          <span className="lbl">Our answer</span>
          <h3>
            Our policy never needed the amount. <i>So we moved it to the account.</i>
          </h3>
          <p>
            KYC, accreditation, jurisdiction and expiry are facts about the holder. Vellum checks
            them when an account opens, which works with encrypted balances.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function How() {
  return (
    <section className="sec" id="how">
      <div className="wrap">
        <Reveal className="sec-h">
          <span className="lbl">How it works</span>
          <h2>The freeze gate</h2>
        </Reveal>
        <FreezeGate />
      </div>
    </section>
  );
}

function Hides() {
  return (
    <section className="sec" id="hides">
      <div className="wrap">
        <Reveal className="sec-h">
          <span className="lbl">What it hides</span>
          <h2>
            Balance privacy. <i>Not anonymity.</i>
          </h2>
          <p>
            A transfer agent is required to know its holders. Vellum keeps them on the record and
            encrypts what they hold.
          </p>
        </Reveal>

        <div className="cmp">
          <Reveal>
            <span className="lbl-m">Public</span>
            <h3>What an explorer sees</h3>
            <div className="paper receipt">
              <div className="rh">Account lookup · Solana</div>
              <Row k="Owner" v="7xKp…m3fQ" />
              <Row k="Mint" v="NWRB Class A" />
              <Row k="Attestation" v="KYC · US · 2027-03-31" />
              <Row k="Approved" v="true" />
              <Row k="Available" v="3hi4LKK1W9AIbxgAPZaW…" />
              <Row
                k="Last transfer"
                v={
                  <>
                    → 9bQe…Lk7d · <Redacted>450</Redacted>
                  </>
                }
              />
              <div className="tot">
                <span>Balance</span>
                <b>0</b>
              </div>
            </div>
          </Reveal>
          <Reveal>
            <span className="lbl-m">Private</span>
            <h3>What the holder sees</h3>
            <div className="paper hstmt">
              <span className="keytag">
                <KeyRound />
                Your key
              </span>
              <Row k="Received" v="1,100" />
              <Row k="Sent → 9bQe…Lk7d" v="(450)" />
              <Row k="Status" v={<span style={{ color: "var(--pos)" }}>Thawed · attested</span>} />
              <Row k="Also readable by" v="Issuer auditor key" />
              <div className="tot">
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}>Balance</span>
                <b>650</b>
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal className="split">
          <div>
            <span className="lbl">Encrypted</span>
            <ul>
              <li>Account balances</li>
              <li>Transfer amounts</li>
              <li>Position sizes</li>
              <li>Portfolio value</li>
            </ul>
          </div>
          <div className="no">
            <span className="lbl" style={{ color: "var(--on-desk-muted)" }}>
              On the record
            </span>
            <ul>
              <li>Who holds the security</li>
              <li>Who sent to whom</li>
              <li>Each holder&rsquo;s attestation</li>
              <li>The full holder set</li>
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

function Modes() {
  return (
    <section className="sec" id="modes">
      <div className="wrap">
        <Reveal className="sec-h">
          <span className="lbl">Architecture</span>
          <h2>
            One registry, <i>two modes.</i>
          </h2>
          <p>Same attestations, same attestor. The issuer picks the mode for each mint.</p>
        </Reveal>
        <Reveal className="paper modes">
          <div className="holes" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <table>
            <thead>
              <tr>
                <th />
                <th>
                  Mode A<b>Hook</b>
                </th>
                <th>
                  Mode B<b>Confidential</b>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Enforced</td>
                <td>Per transfer</td>
                <td className="em">Per account</td>
              </tr>
              <tr>
                <td>Amounts</td>
                <td>Public</td>
                <td className="gold">ElGamal-encrypted</td>
              </tr>
              <tr>
                <td>Oversight</td>
                <td>Public ledger</td>
                <td className="em">Auditor key decrypts</td>
              </tr>
              <tr>
                <td>Works with</td>
                <td>AMMs, lending, any CPI</td>
                <td>Holding, direct transfer</td>
              </tr>
              <tr>
                <td>Use</td>
                <td>Trading venue leg</td>
                <td>Cap table, institutional leg</td>
              </tr>
            </tbody>
          </table>
          <div className="foot">
            <span>Mode B follows sRFC-37 · Token ACL</span>
            {/* Keep in step with `anchor test`. */}
            <span className="stamp" style={{ color: "var(--pos)", borderColor: "var(--pos)" }}>
              34 tests passing
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

const TRADEOFFS = [
  {
    title: "Coarser checks",
    body: "Jurisdiction is checked when an account thaws, not on every transfer. The refreeze crank closes the gap.",
  },
  {
    title: "No amount rules",
    body: "Per-transfer caps are impossible once amounts are encrypted. Those rules move to the auditor key, off-chain.",
  },
  {
    title: "No AMM for Mode B",
    body: "Confidential balances don’t trade on an AMM. Mode A stays the venue leg.",
  },
  {
    title: "Platform risk",
    body: "The ZK ElGamal proof program was disabled from June 2025 to June 2026. It has been live on mainnet since.",
  },
];

function Tradeoffs() {
  return (
    <section className="sec" id="tradeoffs">
      <div className="wrap">
        <Reveal className="sec-h">
          <span className="lbl">Footnotes</span>
          <h2>What we gave up</h2>
        </Reveal>
        <div className="fn">
          {TRADEOFFS.map(({ title, body }, index) => (
            <Reveal key={title}>
              <sup>{index + 1}</sup>
              <h3>{title}</h3>
              <p>{body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const MILESTONES = [
  { id: "M1", what: "Registry, hook, policy engine", done: true },
  { id: "M2", what: "AMM composability shim", done: true },
  { id: "M3", what: "Confidential mode, freeze gate, auditor key", done: true },
  { id: "M4", what: "Holder wallet, devnet", done: false },
];

function Close() {
  return (
    <section className="sec" id="status">
      <div className="wrap close">
        <Reveal>
          <span className="lbl">Built for Colosseum · Crypto World&rsquo;s Fair 2026</span>
          <h2 style={{ marginTop: 16 }}>
            Every holder named. Every amount{" "}
            <span className="on-desk">
              <Redacted alignLeft>sealed.</Redacted>
            </span>
          </h2>
          <Ctas />
        </Reveal>
        <Reveal className="paper log">
          <span
            className="clip"
            style={{ right: 130, transform: "rotate(6deg)" }}
            aria-hidden="true"
          />
          <div className="rh">
            <span>Status</span>
            <span>Oct 2026</span>
          </div>
          {MILESTONES.map(({ id, what, done }) => (
            <div className="m" key={id}>
              <b>{id}</b>
              <span>{what}</span>
              <span className={done ? "ok" : "nx"}>{done ? "Done" : "Next"}</span>
            </div>
          ))}
          <pre>
            <span>$</span> anchor test
          </pre>
        </Reveal>
      </div>
    </section>
  );
}
