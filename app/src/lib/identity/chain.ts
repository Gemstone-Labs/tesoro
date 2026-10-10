import "@/lib/chain/polyfill";
import { PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { TESORO_CORE_PROGRAM_ID, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "@/lib/chain/client";
import { decodeAll } from "@/lib/chain/read";
import { createAccountIx } from "@/lib/chain/match-flow";
import { accountExists } from "@/lib/chain/read";
import { ensureSol, type GetToken } from "@/lib/chain/demo-client";
import { coreAccountPda, evmLinkPda, fetchLinkState, linkEvmIx, linkMessage } from "@/lib/chain/eth";
import type { EvmSigner } from "@/lib/auth/types";
import { avatarArg, profileFromChain } from "./codec";
import type { AvatarPick, ProfileData } from "./display";

const MIN_SOL_LAMPORTS = 5_000_000;

export function profilePda(account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("profile"), account.toBuffer()], TESORO_CORE_PROGRAM_ID)[0];
}

export interface PlayerChainData {
  profile: ProfileData | null;
  /** What the Player attached to their Profile for names; null when nothing. */
  attached: { wallet: string | null; evm: string | null };
  /** Solana wallets whose .sol name may show, best first: the one the Player attached, then the Account's own. */
  wallets: string[];
  /** EVM addresses whose .eth name may show, best first: the one the Player attached, then the Account's own. */
  evms: string[];
}

const ZERO_EVM = /^0x0{40}$/;

/** Reads the Profile and the wallet / EVM addresses of up to 50 Accounts in two lookups. */
export async function fetchPlayerChainData(accounts: PublicKey[]): Promise<PlayerChainData[]> {
  const core = getChain().core;
  const [profiles, accts] = await Promise.all([
    decodeAll(accounts.map(profilePda), (d) => core.coder.accounts.decode("profile", d)),
    decodeAll(accounts, (d) => core.coder.accounts.decode("tesoroAccount", d)),
  ]);
  const evmHex = (bytes: ArrayLike<number> | undefined) => {
    const hex = bytes ? `0x${Buffer.from(Uint8Array.from(bytes)).toString("hex")}` : null;
    return hex && !ZERO_EVM.test(hex) ? hex : null;
  };
  return accounts.map((_, i) => {
    const a = accts[i];
    const p = profiles[i];
    const attachedKey = p ? new PublicKey(p.nameWallet) : null;
    const attachedWallet = attachedKey && !attachedKey.equals(PublicKey.default) ? attachedKey.toBase58() : null;
    const attachedEvm = evmHex(p?.nameEvm)?.toLowerCase() ?? null;
    const own = { wallet: a ? new PublicKey(a.authority).toBase58() : null, evm: evmHex(a?.evmAddress)?.toLowerCase() ?? null };
    return {
      profile: profileFromChain(p),
      attached: { wallet: attachedWallet, evm: attachedEvm },
      wallets: [...new Set([attachedWallet, own.wallet].filter((w): w is string => w !== null))],
      evms: [...new Set([attachedEvm, own.evm].filter((e): e is string => e !== null))],
    };
  });
}

export async function setProfileIx(authority: PublicKey, name: string, avatar: AvatarPick): Promise<TransactionInstruction> {
  const account = PublicKey.findProgramAddressSync([Buffer.from("account"), authority.toBuffer()], TESORO_CORE_PROGRAM_ID)[0];
  return getChain()
    .core.methods.setProfile(name, avatarArg(avatar))
    .accountsPartial({ authority, account, profile: profilePda(account), systemProgram: SystemProgram.programId })
    .instruction();
}

const accountOf = (authority: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("account"), authority.toBuffer()], TESORO_CORE_PROGRAM_ID)[0];

/** `set_name_wallet`: attaches `wallet` (which must co-sign the transaction) for its .sol name, or clears it. */
export async function setNameWalletIx(authority: PublicKey, wallet: PublicKey | null): Promise<TransactionInstruction> {
  const account = accountOf(authority);
  return getChain()
    .core.methods.setNameWallet()
    .accountsPartial({ authority, account, profile: profilePda(account), wallet, systemProgram: SystemProgram.programId })
    .instruction();
}

const ZERO_ADDRESS = Array<number>(20).fill(0);

/** `set_name_evm`: attaches an EVM address already linked to the Account in the bridge, or clears it (`evm` null). */
export async function setNameEvmIx(authority: PublicKey, evm: string | null): Promise<TransactionInstruction> {
  const account = accountOf(authority);
  return getChain()
    .core.methods.setNameEvm(evm ? Array.from(Buffer.from(evm.slice(2), "hex")) : ZERO_ADDRESS)
    .accountsPartial({ authority, account, profile: profilePda(account), evmLink: evm ? evmLinkPda(evm) : null, systemProgram: SystemProgram.programId })
    .instruction();
}

/**
 * What to do with the wallets whose names show: leave the field out to keep what is attached,
 * `null` to detach, a wallet to attach. Attaching asks that wallet to approve once.
 */
export interface WalletNames {
  solana?: ChainSigner | null;
  evm?: EvmSigner | null;
}

/** Sets the signed-in Account's Profile (and optionally the wallets whose names show) in one transaction; the Account is created in the same one when it does not exist yet. */
export async function saveProfile(
  signer: ChainSigner,
  getToken: GetToken,
  name: string,
  avatar: AvatarPick,
  wallets: WalletNames = {},
  onStep?: (s: string) => void,
): Promise<string> {
  await ensureSol(signer, getToken, MIN_SOL_LAMPORTS, () => onStep?.("Adding SOL for network fees"));
  onStep?.("Saving your profile");
  const ixs: TransactionInstruction[] = [];
  const base = getChain().base;
  if (!(await accountExists(accountOf(signer.publicKey)))) ixs.push(await createAccountIx(signer.publicKey));
  ixs.push(await setProfileIx(signer.publicKey, name, avatar));

  if (wallets.evm !== undefined) {
    if (wallets.evm === null) ixs.push(await setNameEvmIx(signer.publicKey, null));
    else {
      const evm = wallets.evm;
      // The bridge keeps the proof that this address belongs to the Account: one signature from that wallet, once.
      const state = await fetchLinkState(base, signer.publicKey, evm.address);
      if (!state.linked) {
        onStep?.("Approve in your Ethereum wallet");
        await evm.prepare();
        const signature = await evm.client.signMessage({ account: evm.account, message: linkMessage(coreAccountPda(signer.publicKey)) });
        ixs.push(linkEvmIx(signer.publicKey, evm.address, signature));
      }
      ixs.push(await setNameEvmIx(signer.publicKey, evm.address.toLowerCase()));
    }
  }
  if (wallets.solana !== undefined) ixs.push(await setNameWalletIx(signer.publicKey, wallets.solana?.publicKey ?? null));

  if (!wallets.solana) return getChain().sendBase(signer, ixs);

  // The attached Solana wallet co-signs, so nobody can show a name they do not own.
  onStep?.("Approve in your Solana wallet");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signer.publicKey;
  const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const cosigned = await wallets.solana.signTransaction(tx);
  return getChain().sendSigned(await signer.signTransaction(cosigned), lastValidBlockHeight);
}

/** Anchor's InstructionFallbackNotFound: the deployed program has no such instruction. */
const FALLBACK_NOT_FOUND = 101;
let liveSince = 0;

/**
 * Whether the deployed tesoro_core has `set_profile`. Simulates the instruction without signatures:
 * a program that knows it fails later for another reason, one that does not answers 101. Anything
 * else (no SOL yet, a flaky RPC) counts as available, since saving will say what went wrong.
 */
export async function profilesAvailable(payer: PublicKey): Promise<boolean> {
  if (liveSince > 0) return true;
  try {
    const ix = await setProfileIx(payer, "Probe", { kind: "default" });
    const { blockhash } = await getChain().base.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
    const sim = await getChain().base.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    const err = sim.value.err as { InstructionError?: [number, { Custom?: number }] } | string | null;
    if (err && typeof err === "object" && err.InstructionError?.[1]?.Custom === FALLBACK_NOT_FOUND) return false;
  } catch {
    // Unknown: assume it is there.
  }
  liveSince = Date.now();
  return true;
}
