//! Proof of control over a Game program, read from the loader accounts.
//!
//! Registration and every later change must be signed by whoever controls the program: its
//! upgrade authority, or, once the program can no longer be upgraded, the program itself through
//! the PDA `["tesoro-register"]`. This module only reads bytes (no CPI, no Anchor types), so
//! every refusal is a plain unit test. Nothing here trusts an account because of its address
//! alone: the loader owner, the executable flag, the derived ProgramData address and the loader's
//! state tag are all checked.

use crate::state::REGISTER_SEED;
use anchor_lang::prelude::*;

pub const LOADER_UPGRADEABLE: Pubkey = pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
pub const LOADER_V4: Pubkey = pubkey!("LoaderV411111111111111111111111111111111111");
pub const LOADER_V2: Pubkey = pubkey!("BPFLoader2111111111111111111111111111111111");

/// What this module needs to know about an account, so tests need no runtime.
pub struct View<'a> {
    pub key: Pubkey,
    pub owner: Pubkey,
    pub executable: bool,
    pub data: &'a [u8],
}

/// Where a program's executable bytes live.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeAt {
    /// In the ProgramData account, after its 45-byte header.
    ProgramData,
    /// In the program account itself, after this many header bytes.
    Program(usize),
}

/// What the loader says about a program right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deploy {
    /// The key that may upgrade the program; `None` when it can no longer be changed.
    pub controller: Option<Pubkey>,
    /// Slot of the last deployment. Zero for a loader that does not record one (immutable).
    pub slot: u64,
    pub code: CodeAt,
}

/// Largest account data `code_hash` reads. Measured on LiteSVM: about 0.55 CU a byte for the scan and the hash together (784 KB: 402k CU)
/// so the cap stays inside one 1.4M CU transaction.
pub const MAX_CODE_BYTES: usize = 1_800_000;
const PROGRAM_DATA_HEADER: usize = 45;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProofError {
    /// The program account is not an executable program of a loader this registry understands.
    NotAProgram,
    /// The ProgramData account is missing, not the derived address, not the loader's, or not live
    /// ProgramData (closed, a buffer, truncated).
    BadProgramData,
    /// The executable is larger than the registry hashes in one transaction.
    TooLarge,
    /// Loader v4 program that is retracted, or finalized into a different version.
    NotDeployed,
}

const TAG_PROGRAM: u32 = 2;
const TAG_PROGRAM_DATA: u32 = 3;

fn tag(data: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(0..4)?.try_into().ok()?))
}

/// Reads the program's deployment from the loader accounts. `game` is the program id being
/// registered; `program` must be that exact account.
pub fn read_deploy(
    game: &Pubkey,
    program: &View,
    program_data: Option<&View>,
) -> std::result::Result<Deploy, ProofError> {
    if program.key != *game || !program.executable {
        return Err(ProofError::NotAProgram);
    }
    if program.owner == LOADER_UPGRADEABLE {
        read_upgradeable(game, program, program_data)
    } else if program.owner == LOADER_V4 {
        read_v4(game, program)
    } else if program.owner == LOADER_V2 {
        Ok(Deploy {
            controller: None,
            slot: 0,
            code: CodeAt::Program(0),
        })
    } else {
        Err(ProofError::NotAProgram)
    }
}

fn read_upgradeable(
    game: &Pubkey,
    program: &View,
    program_data: Option<&View>,
) -> std::result::Result<Deploy, ProofError> {
    if program.data.len() != 36 || tag(program.data) != Some(TAG_PROGRAM) {
        return Err(ProofError::NotAProgram);
    }
    let named = Pubkey::new_from_array(
        program.data[4..36]
            .try_into()
            .map_err(|_| ProofError::NotAProgram)?,
    );
    let derived = Pubkey::find_program_address(&[game.as_ref()], &LOADER_UPGRADEABLE).0;
    let pd = program_data.ok_or(ProofError::BadProgramData)?;
    if pd.key != named || pd.key != derived || pd.owner != LOADER_UPGRADEABLE {
        return Err(ProofError::BadProgramData);
    }
    if pd.data.len() < 45 || tag(pd.data) != Some(TAG_PROGRAM_DATA) {
        return Err(ProofError::BadProgramData);
    }
    let slot = u64::from_le_bytes(
        pd.data[4..12]
            .try_into()
            .map_err(|_| ProofError::BadProgramData)?,
    );
    let controller = match pd.data[12] {
        0 => None,
        1 => Some(Pubkey::new_from_array(
            pd.data[13..45]
                .try_into()
                .map_err(|_| ProofError::BadProgramData)?,
        )),
        _ => return Err(ProofError::BadProgramData),
    };
    Ok(Deploy {
        controller,
        slot,
        code: CodeAt::ProgramData,
    })
}

fn read_v4(game: &Pubkey, program: &View) -> std::result::Result<Deploy, ProofError> {
    if program.data.len() < 48 {
        return Err(ProofError::NotAProgram);
    }
    let slot = u64::from_le_bytes(
        program.data[0..8]
            .try_into()
            .map_err(|_| ProofError::NotAProgram)?,
    );
    let other = Pubkey::new_from_array(
        program.data[8..40]
            .try_into()
            .map_err(|_| ProofError::NotAProgram)?,
    );
    let status = u64::from_le_bytes(
        program.data[40..48]
            .try_into()
            .map_err(|_| ProofError::NotAProgram)?,
    );
    match status {
        1 => Ok(Deploy {
            controller: Some(other),
            slot,
            code: CodeAt::Program(48),
        }),
        // Finalized: the field forwards to the next version. Only a program that points at itself
        // is the final one.
        2 if other == *game => Ok(Deploy {
            controller: None,
            slot,
            code: CodeAt::Program(48),
        }),
        _ => Err(ProofError::NotDeployed),
    }
}

/// Length of `data` without its trailing zero bytes. Extending a program appends zeros, so the
/// executable is identified without them (an ELF ignores bytes after its end).
pub fn trimmed_len(data: &[u8]) -> usize {
    let mut end = data.len();
    while !end.is_multiple_of(8) {
        if data[end - 1] != 0 {
            return end;
        }
        end -= 1;
    }
    for chunk in data[..end].rchunks_exact(8) {
        let mut word = [0u8; 8];
        word.copy_from_slice(chunk);
        if u64::from_le_bytes(word) != 0 {
            break;
        }
        end -= 8;
    }
    while end > 0 && data[end - 1] == 0 {
        end -= 1;
    }
    end
}

/// SHA-256 of the program's executable bytes without trailing zeros. The same rule is applied
/// off-chain when the admin approves a build. Refused for a program larger than `MAX_CODE_BYTES`.
pub fn code_hash(
    program: &View,
    program_data: &View,
    deploy: &Deploy,
) -> std::result::Result<[u8; 32], ProofError> {
    let (data, from) = match deploy.code {
        CodeAt::ProgramData => (program_data.data, PROGRAM_DATA_HEADER),
        CodeAt::Program(n) => (program.data, n),
    };
    if data.len() > MAX_CODE_BYTES || data.len() < from {
        return Err(ProofError::TooLarge);
    }
    let code = &data[from..];
    let end = trimmed_len(code);
    Ok(anchor_lang::solana_program::hash::hash(&code[..end]).to_bytes())
}

/// The PDA a program signs with when it can no longer be upgraded.
pub fn register_pda(game: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[REGISTER_SEED], game).0
}

/// The one key whose signature proves control of the program right now.
pub fn required_signer(game: &Pubkey, deploy: &Deploy) -> Pubkey {
    deploy.controller.unwrap_or_else(|| register_pda(game))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upgradeable_program(game: Pubkey) -> (Vec<u8>, Pubkey) {
        let pd = Pubkey::find_program_address(&[game.as_ref()], &LOADER_UPGRADEABLE).0;
        let mut d = TAG_PROGRAM.to_le_bytes().to_vec();
        d.extend_from_slice(pd.as_ref());
        (d, pd)
    }

    fn program_data(slot: u64, authority: Option<Pubkey>) -> Vec<u8> {
        let mut d = TAG_PROGRAM_DATA.to_le_bytes().to_vec();
        d.extend_from_slice(&slot.to_le_bytes());
        match authority {
            Some(k) => {
                d.push(1);
                d.extend_from_slice(k.as_ref());
            }
            None => {
                d.push(0);
                d.extend_from_slice(&[0; 32]);
            }
        }
        d.extend_from_slice(&[7; 100]);
        d
    }

    fn view<'a>(key: Pubkey, owner: Pubkey, executable: bool, data: &'a [u8]) -> View<'a> {
        View {
            key,
            owner,
            executable,
            data,
        }
    }

    #[test]
    fn upgradeable_program_names_its_authority_and_slot() {
        let game = Pubkey::new_unique();
        let auth = Pubkey::new_unique();
        let (pdata, pd) = upgradeable_program(game);
        let body = program_data(42, Some(auth));
        let d = read_deploy(
            &game,
            &view(game, LOADER_UPGRADEABLE, true, &pdata),
            Some(&view(pd, LOADER_UPGRADEABLE, false, &body)),
        )
        .unwrap();
        assert_eq!(
            d,
            Deploy {
                controller: Some(auth),
                slot: 42,
                code: CodeAt::ProgramData
            }
        );
        assert_eq!(required_signer(&game, &d), auth);
    }

    #[test]
    fn an_upgradeable_program_without_authority_is_immutable_and_signs_by_pda() {
        let game = Pubkey::new_unique();
        let (pdata, pd) = upgradeable_program(game);
        let body = program_data(9, None);
        let d = read_deploy(
            &game,
            &view(game, LOADER_UPGRADEABLE, true, &pdata),
            Some(&view(pd, LOADER_UPGRADEABLE, false, &body)),
        )
        .unwrap();
        assert_eq!(d.controller, None);
        assert_eq!(required_signer(&game, &d), register_pda(&game));
        assert_ne!(required_signer(&game, &d), game);
    }

    #[test]
    fn a_fake_program_data_is_refused() {
        let game = Pubkey::new_unique();
        let attacker = Pubkey::new_unique();
        let (pdata, pd) = upgradeable_program(game);
        let body = program_data(1, Some(attacker));
        let prog = view(game, LOADER_UPGRADEABLE, true, &pdata);
        // Right bytes at an address the loader would never use.
        let elsewhere = Pubkey::new_unique();
        for (key, owner) in [
            (elsewhere, LOADER_UPGRADEABLE),
            (pd, Pubkey::new_unique()),
            (pd, Pubkey::default()),
        ] {
            let r = read_deploy(&game, &prog, Some(&view(key, owner, false, &body)));
            assert_eq!(r, Err(ProofError::BadProgramData));
        }
        // The attacker's own program's ProgramData, valid in itself, for someone else's program.
        let mine = Pubkey::new_unique();
        let (_, mine_pd) = upgradeable_program(mine);
        let r = read_deploy(
            &game,
            &prog,
            Some(&view(mine_pd, LOADER_UPGRADEABLE, false, &body)),
        );
        assert_eq!(r, Err(ProofError::BadProgramData));
        assert_eq!(
            read_deploy(&game, &prog, None),
            Err(ProofError::BadProgramData)
        );
    }

    #[test]
    fn program_data_that_is_closed_a_buffer_or_cut_short_is_refused() {
        let game = Pubkey::new_unique();
        let (pdata, pd) = upgradeable_program(game);
        let prog = view(game, LOADER_UPGRADEABLE, true, &pdata);
        let mut closed = program_data(1, Some(Pubkey::new_unique()));
        closed[0..4].copy_from_slice(&0u32.to_le_bytes());
        let mut buffer = program_data(1, Some(Pubkey::new_unique()));
        buffer[0..4].copy_from_slice(&1u32.to_le_bytes());
        let short = program_data(1, Some(Pubkey::new_unique()))[..30].to_vec();
        let mut odd_option = program_data(1, None);
        odd_option[12] = 2;
        for body in [closed, buffer, short, odd_option, Vec::new()] {
            let r = read_deploy(
                &game,
                &prog,
                Some(&view(pd, LOADER_UPGRADEABLE, false, &body)),
            );
            assert_eq!(r, Err(ProofError::BadProgramData));
        }
    }

    #[test]
    fn a_program_account_that_is_not_a_live_program_is_refused() {
        let game = Pubkey::new_unique();
        let (pdata, pd) = upgradeable_program(game);
        let body = program_data(1, Some(Pubkey::new_unique()));
        let pdv = view(pd, LOADER_UPGRADEABLE, false, &body);
        // Not executable, wrong key, wrong loader, wrong state tag, wrong length.
        let cases: Vec<View> = vec![
            view(game, LOADER_UPGRADEABLE, false, &pdata),
            view(Pubkey::new_unique(), LOADER_UPGRADEABLE, true, &pdata),
            view(game, anchor_lang::system_program::ID, true, &pdata),
            view(game, Pubkey::new_unique(), true, &pdata),
            view(game, LOADER_UPGRADEABLE, true, &body),
            view(game, LOADER_UPGRADEABLE, true, &pdata[..20]),
        ];
        for c in cases {
            assert_eq!(
                read_deploy(&game, &c, Some(&pdv)),
                Err(ProofError::NotAProgram)
            );
        }
    }

    fn v4(slot: u64, field: Pubkey, status: u64) -> Vec<u8> {
        let mut d = slot.to_le_bytes().to_vec();
        d.extend_from_slice(field.as_ref());
        d.extend_from_slice(&status.to_le_bytes());
        d.extend_from_slice(&[1; 64]);
        d
    }

    #[test]
    fn loader_v4_reads_the_authority_from_the_header() {
        let game = Pubkey::new_unique();
        let auth = Pubkey::new_unique();
        let body = v4(77, auth, 1);
        let d = read_deploy(&game, &view(game, LOADER_V4, true, &body), None).unwrap();
        assert_eq!(
            d,
            Deploy {
                controller: Some(auth),
                slot: 77,
                code: CodeAt::Program(48)
            }
        );
    }

    #[test]
    fn loader_v4_retracted_or_forwarded_is_refused_and_finalized_in_place_is_immutable() {
        let game = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        for body in [
            v4(1, other, 0),
            v4(1, other, 2),
            v4(1, other, 3),
            v4(1, game, 0),
        ] {
            assert_eq!(
                read_deploy(&game, &view(game, LOADER_V4, true, &body), None),
                Err(ProofError::NotDeployed)
            );
        }
        let fin = v4(5, game, 2);
        let d = read_deploy(&game, &view(game, LOADER_V4, true, &fin), None).unwrap();
        assert_eq!(d.controller, None);
        assert_eq!(
            read_deploy(&game, &view(game, LOADER_V4, true, &fin[..40]), None),
            Err(ProofError::NotAProgram)
        );
    }

    #[test]
    fn a_non_upgradeable_loader_program_is_immutable_with_slot_zero() {
        let game = Pubkey::new_unique();
        let d = read_deploy(&game, &view(game, LOADER_V2, true, &[1, 2, 3]), None).unwrap();
        assert_eq!(
            d,
            Deploy {
                controller: None,
                slot: 0,
                code: CodeAt::Program(0)
            }
        );
    }

    #[test]
    fn programs_of_other_owners_are_refused() {
        let game = Pubkey::new_unique();
        for owner in [
            anchor_lang::system_program::ID,
            Pubkey::new_unique(),
            pubkey!("NativeLoader1111111111111111111111111111111"),
        ] {
            assert_eq!(
                read_deploy(&game, &view(game, owner, true, &[0; 64]), None),
                Err(ProofError::NotAProgram)
            );
        }
    }

    #[test]
    fn trailing_zeros_do_not_change_the_code_hash_but_other_bytes_do() {
        let game = Pubkey::new_unique();
        let (pdata, pd) = upgradeable_program(game);
        let hash = |body: &[u8]| {
            let prog = view(game, LOADER_UPGRADEABLE, true, &pdata);
            let pdv = view(pd, LOADER_UPGRADEABLE, false, body);
            let d = read_deploy(&game, &prog, Some(&pdv)).unwrap();
            code_hash(&prog, &pdv, &d)
        };
        let base = program_data(5, Some(Pubkey::new_unique()));
        let mut extended = base.clone();
        extended.extend_from_slice(&[0; 10_240 + 3]);
        let mut changed = base.clone();
        changed[60] ^= 1;
        let mut tail_changed = extended.clone();
        tail_changed[base.len() + 7] = 1;
        assert_eq!(hash(&base), hash(&extended));
        assert_ne!(hash(&base), hash(&changed));
        assert_ne!(hash(&base), hash(&tail_changed));
        // The header (slot, authority) is not part of the code.
        let other_slot = program_data(99, Some(Pubkey::new_unique()));
        assert_eq!(hash(&base), hash(&other_slot));
        let mut big = base.clone();
        big.resize(MAX_CODE_BYTES + 1, 1);
        assert_eq!(hash(&big), Err(ProofError::TooLarge));
    }

    #[test]
    fn trimmed_len_matches_a_byte_scan() {
        for len in 0..40usize {
            for last in 0..=len {
                let mut d = vec![0u8; len];
                if last > 0 {
                    d[last - 1] = 3;
                }
                assert_eq!(trimmed_len(&d), last, "len {len} last {last}");
            }
        }
        assert_eq!(
            trimmed_len(&[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            1
        );
    }

    #[test]
    fn the_register_pda_belongs_to_the_game_program() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        assert_ne!(register_pda(&a), register_pda(&b));
        assert_eq!(
            register_pda(&a),
            Pubkey::find_program_address(&[b"tesoro-register"], &a).0
        );
    }
}
