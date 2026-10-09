# Vellum landing page

The Vellum site, built from the "Filing" identity: the share register as a
paper document on a dark desk, holder names visible, amounts under redaction
bars that lift to show who can read them.

Next.js (App Router) + TypeScript, exported as static files. Two pages:

- `/` is the landing page. No data fetching: every figure is illustrative, and
  the register (Northwind Robotics, NWRB) is fictional.
- `/holder` is live. It reads a real confidential mint on devnet and decrypts a
  holder's balance in the browser, with the demo holders' viewing keys or a
  connected wallet's own.

```bash
yarn install
yarn dev        # http://localhost:3000
yarn build      # static site in ./out
yarn test       # the browser decryption, against a real devnet account
```

Serve `out/` from any static host. If the site lives under a sub-path, build
with `NEXT_PUBLIC_BASE_PATH=/vellum yarn build`.

## Deploying to Vercel

Import the repository and set **Root Directory** to `web`; the repository root
is the Anchor workspace, not the site. `vercel.json` pins the framework to
Next.js, so the build and output settings need no overrides, and there are no
environment variables to set. Leave
`NEXT_PUBLIC_BASE_PATH` unset: Vercel serves the site from the domain root.

From a terminal instead: `cd web && npx vercel` (add `--prod` to promote).

## Layout

- `app/globals.css` — the design tokens and every style. Colors, type, spacing
  and motion values come from the design handoff; change them there, not here.
- `app/page.tsx` — the sections, top to bottom, with final copy.
- `components/motion.tsx` — `Reveal` (scroll-in) and `Redacted` (the bar).
- `components/Hero.tsx` — the register and its Public / Holder / Auditor views.
- `components/FreezeGate.tsx` — the three-step account lifecycle.
- `components/HolderView.tsx` — the holder page: public sheet, private sheet.
- `lib/confidential.ts` — key derivation and decryption, a port of
  `tools/reveal`. `lib/chain.ts` reads the accounts over plain JSON-RPC;
  `lib/demo.ts` names the devnet mint and holders. Set `NEXT_PUBLIC_RPC_URL`
  to use another RPC node.

## Rules worth keeping

- A redaction bar is always liftable and always labelled with who can read
  the figure. Never ship a permanent bar.
- The balance is readable by the holder **and** the issuer's auditor key.
  Never write "only you".
- Never claim anonymity. The holder set is public by design.
- The figures agree with each other: received 1,100 − sent 450 = 650.
- Serif for voice, mono for the record. No sans-serif.
- The "tests passing" stamp in the Architecture section is a claim about
  `anchor test`; update it when the count changes.
