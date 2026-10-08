//! Client-side decryption for a Vellum confidential mint. Nothing here touches
//! the chain: every command reads JSON on stdin and a keypair from disk.
//!
//! The holder's view, with keys derived from the holder's own wallet signature:
//!
//!   spl-token account-info --address <ACCOUNT> --output json \
//!     | vellum-reveal balance <OWNER_KEYPAIR>
//!
//! The issuer's view. `auditor-key` prints the ElGamal key to set on the mint
//! (`spl-token update-confidential-transfer-settings --auditor-pubkey`), and
//! `audit` rebuilds the whole register from the mint's history:
//!
//!   vellum-reveal auditor-key <AUDITOR_KEYPAIR>
//!   node scripts/vellum.js history <MINT> | vellum-reveal audit <AUDITOR_KEYPAIR>
//!
//! This is the other half of "what any explorer sees: 0". The derivation is
//! the one spl-token-cli uses (`derive_confidential_keys` over an empty public
//! seed), so `balance` reads any account that CLI configured.

use std::{collections::BTreeMap, io::Read};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use solana_keypair::read_keypair_file;
use solana_zk_sdk::encryption::{
    auth_encryption::AeCiphertext,
    derivation::derive_confidential_keys,
    elgamal::{ElGamalCiphertext, ElGamalSecretKey},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Encrypted amounts are split so each half stays small enough to brute-force
/// out of the exponent: a 16-bit low part and the remaining high part.
const AMOUNT_LO_BITS: u32 = 16;

const USAGE: &str = "usage: vellum-reveal balance <OWNER_KEYPAIR> < account-info.json
       vellum-reveal auditor-key <AUDITOR_KEYPAIR>
       vellum-reveal audit <AUDITOR_KEYPAIR> < history.json";

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [command, keypair_path] = args.as_slice() else {
        return Err(USAGE.into());
    };
    let keypair = read_keypair_file(keypair_path)?;
    let (elgamal, aes) = derive_confidential_keys(&keypair, b"")?;

    match command.as_str() {
        "auditor-key" => {
            println!("{}", elgamal.pubkey());
            Ok(())
        }
        "balance" => balance(&stdin_json()?, elgamal.secret(), |c| aes.decrypt(c)),
        "audit" => {
            let history = stdin_json()?;
            if history["auditor"].as_str() != Some(&elgamal.pubkey().to_string()) {
                return Err("this keypair is not the mint's auditor".into());
            }
            audit(&history, elgamal.secret())
        }
        _ => Err(USAGE.into()),
    }
}

fn stdin_json() -> Result<Value> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    Ok(serde_json::from_str(&input)?)
}

/// One base64 ElGamal ciphertext of at most 32 bits.
fn decrypt(secret: &ElGamalSecretKey, value: &Value, name: &str) -> Result<u64> {
    let encoded = value[name].as_str().ok_or(format!("missing {name}"))?;
    ElGamalCiphertext::from_bytes(&STANDARD.decode(encoded)?)
        .and_then(|c| secret.decrypt_u32(&c))
        .ok_or_else(|| format!("could not decrypt {name}").into())
}

fn raw_amount(value: &Value, name: &str) -> Result<u64> {
    Ok(value[name].as_str().ok_or(format!("missing {name}"))?.parse()?)
}

fn balance(
    account: &Value,
    secret: &ElGamalSecretKey,
    decrypt_available: impl Fn(&AeCiphertext) -> Option<u64>,
) -> Result<()> {
    let state = account["extensions"]
        .as_array()
        .and_then(|exts| {
            exts.iter()
                .find(|e| e["extension"] == "confidentialTransferAccount")
        })
        .map(|e| &e["state"])
        .ok_or("account is not configured for confidential transfers")?;

    // The available balance is mirrored under the holder's AES key precisely so
    // it can be read back without solving a discrete log.
    let encoded = state["decryptableAvailableBalance"]
        .as_str()
        .ok_or("missing decryptableAvailableBalance")?;
    let available = AeCiphertext::from_bytes(&STANDARD.decode(encoded)?)
        .and_then(|c| decrypt_available(&c))
        .ok_or("could not decrypt: this keypair does not own the account")?;

    let pending = decrypt(secret, state, "pendingBalanceLo")?
        + (decrypt(secret, state, "pendingBalanceHi")? << AMOUNT_LO_BITS);

    let decimals = account["tokenAmount"]["decimals"].as_u64().unwrap_or(0) as u32;
    println!("available {}", ui_amount(available, decimals));
    println!("pending   {}", ui_amount(pending, decimals));
    Ok(())
}

/// Rebuilds every holder's position. Balances are encrypted to their holders,
/// not to the auditor, so the auditor reads them the way a transfer agent
/// would: deposits and withdrawals are public, and each transfer carries its
/// amount encrypted to the auditor key.
fn audit(history: &Value, secret: &ElGamalSecretKey) -> Result<()> {
    let decimals = history["decimals"].as_u64().unwrap_or(0) as u32;
    let list = |name: &str| history[name].as_array().cloned().unwrap_or_default();

    let mut confidential: BTreeMap<String, i128> = BTreeMap::new();
    let mut transfers = Vec::new();
    for event in list("events") {
        let account = event["account"].as_str().ok_or("missing account")?.to_string();
        match event["kind"].as_str() {
            Some("deposit") => {
                *confidential.entry(account).or_default() += raw_amount(&event, "amount")? as i128
            }
            Some("withdraw") => {
                *confidential.entry(account).or_default() -= raw_amount(&event, "amount")? as i128
            }
            Some("transfer") => {
                let amount = decrypt(secret, &event, "lo")?
                    + (decrypt(secret, &event, "hi")? << AMOUNT_LO_BITS);
                let destination = event["destination"]
                    .as_str()
                    .ok_or("missing destination")?
                    .to_string();
                *confidential.entry(account.clone()).or_default() -= amount as i128;
                *confidential.entry(destination.clone()).or_default() += amount as i128;
                transfers.push((account, destination, amount));
            }
            _ => return Err("unknown event kind".into()),
        }
    }

    let accounts = list("accounts");
    let owner_of = |address: &str| {
        accounts
            .iter()
            .find(|a| a["address"] == address)
            .and_then(|a| a["owner"].as_str())
            .unwrap_or(address)
            .to_string()
    };

    println!("transfers");
    for (source, destination, amount) in &transfers {
        println!(
            "  {} -> {}  {}",
            owner_of(source),
            owner_of(destination),
            ui_amount(*amount, decimals)
        );
    }
    println!("register");
    for account in &accounts {
        let address = account["address"].as_str().ok_or("missing address")?;
        let public = raw_amount(account, "publicBalance")?;
        let hidden = u64::try_from(confidential.get(address).copied().unwrap_or(0))
            .map_err(|_| "history does not add up: negative confidential balance")?;
        println!(
            "  {}  public {}  confidential {}  total {}",
            owner_of(address),
            ui_amount(public, decimals),
            ui_amount(hidden, decimals),
            ui_amount(public + hidden, decimals)
        );
    }
    Ok(())
}

fn ui_amount(raw: u64, decimals: u32) -> String {
    if decimals == 0 {
        return raw.to_string();
    }
    let unit = 10u64.pow(decimals);
    format!("{}.{:0width$}", raw / unit, raw % unit, width = decimals as usize)
}
