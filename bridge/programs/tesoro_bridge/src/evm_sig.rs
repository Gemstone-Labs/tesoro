//! EIP-191 (`personal_sign`) signature recovery, used to prove that the signer of a Tesoro Account
//! also controls an EVM address before the bridge routes Positions and payouts to it.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::{keccak, secp256k1_recover::secp256k1_recover};

/// The text an EVM wallet signs to link `account` (the `TesoroAccount` PDA) to its address.
pub fn link_message(account: &Pubkey) -> String {
    format!("Tesoro: link EVM address to Account {account}")
}

pub fn eip191_hash(message: &[u8]) -> [u8; 32] {
    keccak::hashv(&[b"\x19Ethereum Signed Message:\n", message.len().to_string().as_bytes(), message])
        .0
}

/// The EVM address that signed `message` (65-byte `r | s | v` signature), if the signature is valid.
pub fn recover_address(message: &[u8], signature: &[u8; 65]) -> Option<[u8; 20]> {
    let v = signature[64];
    let recovery_id = match v {
        27 | 28 => v - 27,
        0 | 1 => v,
        _ => return None,
    };
    let public_key = secp256k1_recover(&eip191_hash(message), recovery_id, &signature[..64]).ok()?;
    let digest = keccak::hash(&public_key.to_bytes()).0;
    let mut address = [0u8; 20];
    address.copy_from_slice(&digest[12..]);
    Some(address)
}

#[cfg(test)]
mod tests {
    use super::*;

    // `cast wallet sign --private-key <anvil key 0> "<link message for the default Pubkey>"`
    const SIGNATURE: &str = "664e20742859d3f87198858d88a9ab7eff20e207f9009f025c7c9eb529094b315b9ede1bb49097e8ee3b00f7745f22620b0bdf2cf2f30c86d982ef04678b2ee11c";
    const ANVIL_0: &str = "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    fn signature() -> [u8; 65] {
        hex(SIGNATURE).try_into().unwrap()
    }

    #[test]
    fn recovers_the_signer() {
        let message = link_message(&Pubkey::default());
        let expected: [u8; 20] = hex(&ANVIL_0.to_lowercase()).try_into().unwrap();
        assert_eq!(recover_address(message.as_bytes(), &signature()), Some(expected));
    }

    #[test]
    fn a_different_message_recovers_a_different_address() {
        let other = link_message(&Pubkey::new_from_array([1; 32]));
        let expected: [u8; 20] = hex(&ANVIL_0.to_lowercase()).try_into().unwrap();
        assert_ne!(recover_address(other.as_bytes(), &signature()), Some(expected));
    }

    #[test]
    fn rejects_bad_recovery_ids() {
        let mut sig = signature();
        sig[64] = 5;
        assert_eq!(recover_address(link_message(&Pubkey::default()).as_bytes(), &sig), None);
    }
}
