import type { Metadata } from "next";
import { LINKS, Wordmark } from "@/components/brand";
import { HolderView } from "@/components/HolderView";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Holder view · Vellum",
  description:
    "Read a confidential position on Solana devnet: what the chain shows, and what the holder's own key decrypts.",
};

export default function Page() {
  return (
    <>
      <Nav />
      <main>
        <section className="sec hv-sec">
          <div className="wrap">
            <div className="sec-h">
              <span className="lbl">Holder view · live on devnet</span>
              <h1>
                Read it with <i>your key.</i>
              </h1>
              <p>
                A real confidential mint, gated by Vellum. The left sheet is what anyone can read
                from the chain. The right one is decrypted here, in your browser, and nowhere
                else.
              </p>
            </div>
            <HolderView />
          </div>
        </section>
      </main>
      <footer>
        <Wordmark label="Vellum, home" />
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
