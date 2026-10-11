"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertIcon, Button, Sheet } from "@/components/ui";
import { art, avatarFor } from "@/lib/art";
import { useAuth } from "@/lib/auth/context";
import { accountKeyOf } from "@/lib/chain/account-key";
import { useChainData } from "@/lib/chain/ChainDataProvider";
import { plainError } from "@/lib/errors";
import { setEditProfileOpen, useEditProfileOpen } from "@/lib/identity/edit-profile";
import {
  PROFILE_NAME_MAX,
  animalAvatar,
  nameServiceAvatar,
  profileNameError,
  shownIdentity,
  type AvatarPick,
  type NameRecord,
  type NameSuffix,
} from "@/lib/identity/display";
import { fetchNames, refreshIdentity, setProfileLocal, useIdentity } from "@/lib/identity/store";
import type { WalletNames } from "@/lib/identity/chain";
import { VerifiedMark } from "./Player";
import "./account.css";

/** The signed-in Account's Account key, as every other screen keys this Player. */
export function useMyAccountKey(): string | null {
  const auth = useAuth();
  const { snapshot } = useChainData();
  return useMemo(() => snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null), [snapshot, auth.addresses.solana]);
}

/** Mounted once in the shell. */
export function EditProfileSheet() {
  const open = useEditProfileOpen();
  return (
    <Sheet open={open} onClose={() => setEditProfileOpen(false)} title="Edit profile">
      <EditProfileForm onDone={() => setEditProfileOpen(false)} />
    </Sheet>
  );
}

function pickEquals(a: AvatarPick, b: AvatarPick): boolean {
  return a.kind === b.kind && (a.kind !== "animal" || (b.kind === "animal" && a.index === b.index));
}

function EditProfileForm({ onDone }: { onDone: () => void }) {
  const auth = useAuth();
  const me = useMyAccountKey();
  const id = useIdentity(me);
  const extSol = auth.externalSolana;
  const extEvm = auth.externalEvm;
  const solAddr = extSol?.publicKey.toBase58() ?? null;
  const evmAddr = extEvm?.address.toLowerCase() ?? null;
  const attachedSol = id.attached?.wallet != null && id.attached.wallet === solAddr;
  const attachedEvm = id.attached?.evm != null && id.attached.evm === evmAddr;
  const [walletNames, setWalletNames] = useState<{ sol: NameRecord | null; eth: NameRecord | null; hl: NameRecord | null } | null>(null);
  const [useSol, setUseSol] = useState<boolean | null>(null);
  const [useEvm, setUseEvm] = useState<boolean | null>(null);
  const showSol = useSol ?? attachedSol;
  const showEvm = useEvm ?? attachedEvm;

  // The connected wallets' own names, so the choice shows what it would put on the profile.
  useEffect(() => {
    if (!solAddr && !evmAddr) return;
    let live = true;
    fetchNames(solAddr ? [solAddr] : [], extEvm ? [extEvm.address] : [])
      .then((n) => live && setWalletNames({ sol: solAddr ? (n.solana[solAddr] ?? null) : null, eth: Object.values(n.evm)[0] ?? null, hl: Object.values(n.hl ?? {})[0] ?? null }))
      .catch(() => live && setWalletNames({ sol: null, eth: null, hl: null }));
    return () => {
      live = false;
    };
  }, [solAddr, evmAddr, extEvm]);

  const pendingId = {
    ...id,
    sol: extSol ? (showSol ? (walletNames?.sol ?? null) : attachedSol ? null : id.sol) : id.sol,
    eth: extEvm ? (showEvm ? (walletNames?.eth ?? null) : attachedEvm ? null : id.eth) : id.eth,
    hl: extEvm ? (showEvm ? (walletNames?.hl ?? null) : attachedEvm ? null : id.hl) : id.hl,
  };
  const evmNames = walletNames ? ([[".eth", walletNames.eth], [".hl", walletNames.hl]] as const).flatMap(([suffix, n]) => (n ? [{ suffix, name: n.name }] : [])) : [];
  const external = nameServiceAvatar(pendingId);
  const derived = useMemo(() => Math.max(0, art.avatars.indexOf(avatarFor(me ?? ""))), [me]);

  // Edits sit on top of what the chain says, which arrives a moment after the sheet opens.
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [pickEdit, setPickEdit] = useState<AvatarPick | null>(null);
  const name = nameEdit ?? id.profile?.name ?? "";
  const stored = id.profile?.avatar;
  const pick: AvatarPick = pickEdit ?? (stored && stored.kind !== "default" ? stored : { kind: "animal", index: derived });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void import("@/lib/identity/chain").then(({ profilesAvailable }) => profilesAvailable()).then((ok) => live && setAvailable(ok));
    return () => {
      live = false;
    };
  }, []);

  const trimmed = name.trim();
  const nameError = trimmed === "" ? null : profileNameError(trimmed);
  const valid = trimmed !== "" && nameError === null;
  const walletsChanged = (useSol !== null && useSol !== attachedSol) || (useEvm !== null && useEvm !== attachedEvm);
  const unchanged = id.profile !== null && id.profile.name === trimmed && pickEquals(id.profile.avatar, pick) && !walletsChanged;
  const preview = shownIdentity(me ?? "", { ...pendingId, profile: valid ? { name: trimmed, avatar: pick } : null });
  // The picture follows the pick right away, even before the name is valid.
  const previewAvatar = shownIdentity(me ?? "", { ...pendingId, profile: { name: trimmed, avatar: pick } }).avatar;

  async function save() {
    if (!auth.signer || !me || !valid) return;
    setError(null);
    setBusy("Saving your profile");
    try {
      const { saveProfile } = await import("@/lib/identity/chain");
      const wallets: WalletNames = {};
      if (extSol && useSol !== null && useSol !== attachedSol) wallets.solana = useSol ? extSol : null;
      if (extEvm && useEvm !== null && useEvm !== attachedEvm) wallets.evm = useEvm ? extEvm : null;
      await saveProfile(auth.signer, auth.getAccessToken, trimmed, pick, wallets, (s) => setBusy(s));
      setProfileLocal(me, { name: trimmed, avatar: pick });
      refreshIdentity(me);
      onDone();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="stack ep"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="cut cut-card ep-preview" aria-label="Preview">
        <span className="cut cut-btn avatar ep-preview-av">
          <PlayerPreview src={previewAvatar} />
        </span>
        <div>
          <b>{preview.label}</b>
          <small className="meta">How other Players see you</small>
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="ep-name">Name</label>
        <input
          id="ep-name"
          className="cut input"
          autoComplete="nickname"
          maxLength={PROFILE_NAME_MAX + 8}
          placeholder="3 to 20 characters"
          value={name}
          disabled={available === false}
          aria-invalid={nameError !== null}
          aria-describedby="ep-name-hint"
          onChange={(e) => {
            setNameEdit(e.target.value);
          }}
        />
        <small id="ep-name-hint" className={nameError ? "ep-err" : "meta"}>
          {nameError ?? "Letters, numbers, spaces, dots, dashes and underscores. Names are not unique."}
        </small>
      </div>

      <fieldset className="ep-pics">
        <legend className="label">Picture</legend>
        <div className="ep-grid">
          {art.avatars.map((_, i) => (
            <label key={i} className="ep-pic">
              <input
                type="radio"
                name="ep-avatar"
                checked={pick.kind === "animal" && pick.index === i}
                disabled={available === false}
                onChange={() => {
                  setPickEdit({ kind: "animal", index: i });
                }}
              />
              <span className="cut cut-btn avatar">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={animalAvatar(i)} alt={`Picture ${i + 1}`} width={64} height={64} />
              </span>
            </label>
          ))}
          {external && (
            <label className="ep-pic ep-pic-ns">
              <input
                type="radio"
                name="ep-avatar"
                checked={pick.kind === "name-service"}
                disabled={available === false}
                onChange={() => {
                  setPickEdit({ kind: "name-service" });
                }}
              />
              <span className="cut cut-btn avatar">
                <PlayerPreview src={external} />
              </span>
              <small>{id.sol?.avatar ? id.sol.name : id.eth?.avatar ? id.eth.name : (id.hl?.name ?? "")}</small>
            </label>
          )}
        </div>
      </fieldset>

      <fieldset className="ep-wallets">
        <legend className="label">Names from your wallets</legend>
        {extSol && (
          <WalletNameRow
            label="Solana wallet"
            address={solAddr as string}
            names={walletNames?.sol ? [{ suffix: ".sol", name: walletNames.sol.name }] : []}
            none="No .sol name"
            loading={walletNames === null}
            checked={showSol}
            disabled={available === false || (walletNames?.sol == null && !attachedSol)}
            onChange={setUseSol}
          />
        )}
        {extEvm && (
          <WalletNameRow
            label="Ethereum wallet"
            address={extEvm.address}
            names={evmNames}
            none="No .eth or .hl name"
            loading={walletNames === null}
            checked={showEvm}
            disabled={available === false || (evmNames.length === 0 && !attachedEvm)}
            onChange={setUseEvm}
          />
        )}
        {!extSol && !extEvm && (
          <div className="stack">
            <p className="meta">We support .sol, .eth and .hl names!</p>
            <div className="hstack wrap">
              <Button size="sm" type="button" onClick={() => auth.linkWallet("solana")}>Link Solana wallet</Button>
              <Button size="sm" type="button" onClick={() => auth.linkWallet("evm")}>Link ETH wallet</Button>
            </div>
          </div>
        )}
      </fieldset>

      {error && (
        <div className="status err" role="alert">
          <AlertIcon /> {error}
        </div>
      )}
      {available === false ? (
        <p className="meta" role="status">Profiles are coming soon.</p>
      ) : (
        <Button type="submit" block disabled={!valid || unchanged || busy !== null || !auth.signer || available === null}>
          {busy ?? "Save"}
        </Button>
      )}
    </form>
  );
}

function PlayerPreview({ src }: { src: string }) {
  // A picture from a name record: loaded as is, without a referrer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={64} height={64} referrerPolicy="no-referrer" loading="lazy" />;
}

function WalletNameRow({
  label,
  address,
  names,
  none,
  loading,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  address: string;
  names: { suffix: NameSuffix; name: string }[];
  none: string;
  loading: boolean;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
  return (
    <label className="ep-wallet">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>{label}</b>
        <small className="meta">
          {short} ·{" "}
          {loading
            ? "Looking up…"
            : names.length === 0
              ? none
              : names.map((n, i) => (
                  <span key={n.suffix}>
                    {i > 0 && " · "}
                    {n.name} <VerifiedMark suffix={n.suffix} />
                  </span>
                ))}
        </small>
      </span>
    </label>
  );
}
