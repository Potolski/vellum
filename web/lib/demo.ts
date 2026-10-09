// The mint and holders left on devnet by scripts/confidential-e2e.sh.

export const DEMO_MINT = "GKV7ZsXVNLGcPrChz5E8W9Qgx5qBUNL7fckJv2jFnGFD";

export type DemoHolder = {
  name: string;
  owner: string;
  note: string;
  /** Viewing keys only, as hex. They read this holder's balance; they cannot
   *  sign for the wallet, so publishing them does not put the position at risk. */
  viewing?: { ae: string; elgamal: string };
};

export const DEMO_HOLDERS: DemoHolder[] = [
  {
    name: "Alice",
    owner: "BJXCkPf3s2muaKnz9p9JNQkFpQnSp9Qk2YFRdppLoefL",
    note: "Attested, thawed, holding.",
    viewing: {
      ae: "dabae7c3af2df8e8d5d47c6550cc124c",
      elgamal: "2aca4cd7ecc01852f01632f842b2e43c5f41715daefc30c0a38738c41ef1ccc",
    },
  },
  {
    name: "Bob",
    owner: "2c9tZQoTUCu3k43ovRXi34R5tUpvHeCYo3DiujCbKF1f",
    note: "Attested, with a transfer received but not yet applied.",
    viewing: {
      ae: "d3a43a414c8833e68d3e6535985ef8fc",
      elgamal: "6cdd7c31e1589ab7cc2ee1b282d34d402f9d76ff37f47f31554dc8389357589",
    },
  },
  {
    name: "Carol",
    owner: "GMxL1h3MXinya8oTS3JfPTmfXhivR4L6wM5uFxA7C128",
    note: "Never attested. Her account was born frozen and stays that way.",
  },
];
