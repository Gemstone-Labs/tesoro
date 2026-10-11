"use client";

/**
 * PROTOTYPE ONLY (proto/sign-in-sheet-11-10-2026). Four takes on the Sign in sheet, switched by
 * `?variant=now|A|B|C|D`. Throwaway: the winner gets rewritten into SignInSheet.tsx on main.
 *
 * A Poster: treasure-cave banner, display title, wallets as two tiles, email as one attached row.
 * B Email first: centred mark + welcome, email is the main path, wallets as a compact pair, code in 6 cells.
 * C Split: guide + what you get on the left, Email | Wallet rail on the right (stacks on phones).
 * D Account preview: the Account you get on top (avatar + SOL/ETH/HYPE), three equal method rows under it.
 */
import { useEffect, useRef, useState } from "react";
import { useLoginWithEmail } from "@privy-io/react-auth";
import { ChevronRight, Mail, Wallet } from "lucide-react";
import { AlertIcon, ArrowIcon, Bust, ChainGlyph, XIcon } from "@/components/ui";
import { TesoroLogo, TesoroMark } from "@/components/brand";
import { art } from "@/lib/art";
import "./sign-in.prototype.css";

export const SIGNIN_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Poster" },
  { key: "B", name: "Email first" },
  { key: "C", name: "Split" },
  { key: "D", name: "Account preview" },
] as const;
export type SignInVariant = (typeof SIGNIN_VARIANTS)[number]["key"];

type Props = {
  reason?: string;
  onClose: () => void;
  onSignedIn: () => void;
  onWallet: (family: "solana" | "evm") => void;
};

/* ——— shared email flow (same behaviour as the real sheet) ——— */
function useEmailFlow(onSignedIn: () => void) {
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const codeStep = !edit && (state.status === "awaiting-code-input" || state.status === "submitting-code" || (error !== null && code !== ""));
  const sending = state.status === "sending-code";
  const checking = state.status === "submitting-code";
  return {
    email, setEmail, code, setCode, error, codeStep, sending, checking,
    async send(e?: React.FormEvent) {
      e?.preventDefault();
      setError(null);
      setEdit(false);
      try {
        await sendCode({ email: email.trim() });
      } catch {
        setError("Could not send the code. Check the email address and try again.");
      }
    },
    async verify(e?: React.FormEvent, value = code) {
      e?.preventDefault();
      setError(null);
      try {
        await loginWithCode({ code: value.trim() });
        onSignedIn();
      } catch {
        setError("That code did not work. Check it, or send a new one.");
      }
    },
    resend() {
      setCode("");
      setError(null);
      void sendCode({ email: email.trim() });
    },
    back() {
      setCode("");
      setError(null);
      setEdit(true);
    },
  };
}
type Flow = ReturnType<typeof useEmailFlow>;

function ErrorLine({ flow }: { flow: Flow }) {
  if (!flow.error) return null;
  return (
    <div className="status err" role="alert">
      <AlertIcon /> {flow.error}
    </div>
  );
}

function Close({ onClose, className = "" }: { onClose: () => void; className?: string }) {
  return (
    <button type="button" className={`cut cut-chip icon-btn si-close ${className}`} onClick={onClose} aria-label="Close">
      <XIcon />
    </button>
  );
}

const title = (reason?: string) => (reason ? `Sign in to ${reason}` : "Sign in");

/** Both EVM chains share one address, so the Ethereum option carries both marks. */
function EvmGlyphs({ size }: { size: number }) {
  return (
    <span className="si-glyphs">
      <ChainGlyph asset={1} size={size} />
      <ChainGlyph asset={2} size={size} />
    </span>
  );
}

/** Six cells over one real input (paste and one-time-code autofill keep working). */
function CodeCells({ flow }: { flow: Flow }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <label className="si-cells" onClick={() => ref.current?.focus()}>
      <input
        ref={ref}
        className="si-cells-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        aria-label={`6-digit code sent to ${flow.email}`}
        value={flow.code}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 6);
          flow.setCode(v);
          if (v.length === 6) void flow.verify(undefined, v);
        }}
      />
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={`cut cut-chip si-cell${i === flow.code.length ? " at" : ""}${flow.code[i] ? " on" : ""}`} aria-hidden="true">
          {flow.code[i] ?? ""}
        </span>
      ))}
    </label>
  );
}

function CodeStep({ flow, cells }: { flow: Flow; cells?: boolean }) {
  return (
    <form className="stack" onSubmit={flow.verify}>
      <p className="si-sent">
        We sent a 6-digit code to <b>{flow.email}</b>.{" "}
        <button type="button" className="si-link" onClick={flow.back}>Change</button>
      </p>
      {cells ? (
        <CodeCells flow={flow} />
      ) : (
        <input
          className="cut input mono si-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          aria-label={`6-digit code sent to ${flow.email}`}
          autoFocus
          value={flow.code}
          onChange={(e) => flow.setCode(e.target.value.replace(/\D/g, ""))}
        />
      )}
      <button type="submit" className="cut cut-btn btn block si-primary" disabled={flow.checking || flow.code.length < 6}>
        {flow.checking ? "Checking…" : "Sign in"}
      </button>
      <p className="si-resend">
        No email? Check spam, or <button type="button" className="si-link" onClick={flow.resend}>send a new code</button>.
      </p>
    </form>
  );
}

/** Email + button in one attached row. */
function EmailRow({ flow, cta = "Send code" }: { flow: Flow; cta?: string }) {
  return (
    <form className="si-row" onSubmit={flow.send}>
      <input
        className="cut input"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@example.com"
        aria-label="Email"
        required
        value={flow.email}
        onChange={(e) => flow.setEmail(e.target.value)}
      />
      <button type="submit" className="cut cut-btn btn si-primary" disabled={flow.sending || flow.email.trim() === ""}>
        {flow.sending ? "Sending…" : cta}
      </button>
    </form>
  );
}

/* ——— A Poster ——— */
function VariantA({ reason, onClose, onSignedIn, onWallet }: Props) {
  const flow = useEmailFlow(onSignedIn);
  return (
    <div className="si-a">
      <div className="si-a-art">
        {/* eslint-disable-next-line @next/next/no-img-element -- prototype */}
        <img src={art.profileBanner} alt="" />
        <TesoroLogo height={26} className="si-a-logo" />
        <Close onClose={onClose} className="on-art" />
      </div>
      <div className="si-a-body">
        <h2 className="display si-a-title">{title(reason)}</h2>
        <p className="si-lede">One Tesoro Account for Solana, Ethereum and HYPE, set up for you.</p>
        {flow.codeStep ? (
          <CodeStep flow={flow} />
        ) : (
          <>
            <div className="si-a-wallets">
              <button type="button" className="cut cut-card si-a-tile" onClick={() => onWallet("solana")}>
                <ChainGlyph asset={0} size={30} />
                <b>Solana wallet</b>
                <small>Phantom · Solflare · Backpack</small>
              </button>
              <button type="button" className="cut cut-card si-a-tile" onClick={() => onWallet("evm")}>
                <EvmGlyphs size={30} />
                <b>Ethereum wallet</b>
                <small>MetaMask · Rabby · WalletConnect</small>
              </button>
            </div>
            <p className="si-or"><span>or with email</span></p>
            <EmailRow flow={flow} />
          </>
        )}
        <ErrorLine flow={flow} />
        <p className="si-foot">Browsing needs no sign-in · Test mode, nothing has real value</p>
      </div>
    </div>
  );
}

/* ——— B Email first ——— */
function VariantB({ reason, onClose, onSignedIn, onWallet }: Props) {
  const flow = useEmailFlow(onSignedIn);
  return (
    <div className="si-b">
      <Close onClose={onClose} className="corner" />
      <div className="si-b-head">
        <TesoroMark size={52} />
        <h2>{reason ? title(reason) : "Welcome to Tesoro"}</h2>
        <p className="si-lede">{flow.codeStep ? "Check your inbox." : "Sign in or create your Account. It takes a minute."}</p>
      </div>
      {flow.codeStep ? (
        <CodeStep flow={flow} cells />
      ) : (
        <>
          <form className="stack" onSubmit={flow.send}>
            <input
              className="cut input si-b-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="Your email"
              aria-label="Email"
              required
              value={flow.email}
              onChange={(e) => flow.setEmail(e.target.value)}
            />
            <button type="submit" className="cut cut-btn btn block si-primary lgish" disabled={flow.sending || flow.email.trim() === ""}>
              {flow.sending ? "Sending code…" : "Continue with email"}
            </button>
          </form>
          <p className="si-or"><span>or use a wallet</span></p>
          <div className="si-b-pair">
            <button type="button" className="cut cut-btn btn neutral" onClick={() => onWallet("solana")}>
              <ChainGlyph asset={0} size={18} /> Solana
            </button>
            <button type="button" className="cut cut-btn btn neutral" onClick={() => onWallet("evm")}>
              <EvmGlyphs size={18} /> Ethereum
            </button>
          </div>
        </>
      )}
      <ErrorLine flow={flow} />
      <p className="si-foot center">One Account works on Solana, Ethereum and HYPE.<br />Browsing needs no sign-in · Test mode</p>
    </div>
  );
}

/* ——— C Split ——— */
function VariantC({ reason, onClose, onSignedIn, onWallet }: Props) {
  const flow = useEmailFlow(onSignedIn);
  const [tab, setTab] = useState<"email" | "wallet">("email");
  return (
    <div className="si-c">
      <aside className="si-c-side">
        {/* eslint-disable-next-line @next/next/no-img-element -- prototype */}
        <img className="si-c-cave" src={art.profileBanner} alt="" />
        <div className="si-c-copy">
          <span className="label">Your Tesoro Account</span>
          <ul>
            <li><span className="si-c-glyphs"><ChainGlyph asset={0} size={16} /><ChainGlyph asset={1} size={16} /><ChainGlyph asset={2} size={16} /></span> Works on Solana, Ethereum and HYPE</li>
            <li><Wallet aria-hidden /> Set up for you, nothing to install</li>
            <li><ArrowIcon /> Browse freely, sign in to play</li>
          </ul>
        </div>
        <Bust name="himWelcome" width={190} className="si-c-bust" />
      </aside>
      <div className="si-c-main">
        <div className="si-c-head">
          <h2>{title(reason)}</h2>
          <Close onClose={onClose} />
        </div>
        {flow.codeStep ? (
          <CodeStep flow={flow} cells />
        ) : (
          <>
            <fieldset className="cut pick-rail si-c-rail" style={{ ["--i" as string]: tab === "email" ? 0 : 1, ["--n" as string]: 2 }}>
              <legend className="sr-only">Sign in with</legend>
              <span className="pick-thumb" aria-hidden="true" />
              {(["email", "wallet"] as const).map((t) => (
                <label key={t}>
                  <input type="radio" name="si-c-tab" checked={tab === t} onChange={() => setTab(t)} />
                  <span className="cut">{t === "email" ? <><Mail aria-hidden /> Email</> : <><Wallet aria-hidden /> Wallet</>}</span>
                </label>
              ))}
            </fieldset>
            {tab === "email" ? (
              <form className="stack" onSubmit={flow.send}>
                <div className="field">
                  <label className="label" htmlFor="si-c-email">Email</label>
                  <input
                    id="si-c-email"
                    className="cut input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    required
                    value={flow.email}
                    onChange={(e) => flow.setEmail(e.target.value)}
                  />
                </div>
                <button type="submit" className="cut cut-btn btn block si-primary" disabled={flow.sending || flow.email.trim() === ""}>
                  {flow.sending ? "Sending code…" : "Email me a code"}
                </button>
                <p className="note">We email you a 6-digit code. No password.</p>
              </form>
            ) : (
              <div className="stack">
                <button type="button" className="cut cut-card si-c-wallet" onClick={() => onWallet("solana")}>
                  <ChainGlyph asset={0} size={26} />
                  <span><b>Solana wallet</b><small>Phantom, Solflare, Backpack</small></span>
                  <ChevronRight aria-hidden />
                </button>
                <button type="button" className="cut cut-card si-c-wallet" onClick={() => onWallet("evm")}>
                  <EvmGlyphs size={26} />
                  <span><b>Ethereum wallet</b><small>MetaMask, Rabby, WalletConnect</small></span>
                  <ChevronRight aria-hidden />
                </button>
                <p className="note">Your wallet links to the same Account; moves are signed for you.</p>
              </div>
            )}
          </>
        )}
        <ErrorLine flow={flow} />
        <p className="si-foot">Test mode: nothing here has real value.</p>
      </div>
    </div>
  );
}

/* ——— D Account preview ——— */
function VariantD({ reason, onClose, onSignedIn, onWallet }: Props) {
  const flow = useEmailFlow(onSignedIn);
  const [emailOpen, setEmailOpen] = useState(false);
  return (
    <div className="si-d">
      <div className="si-d-head">
        <h2>{title(reason)}</h2>
        <Close onClose={onClose} />
      </div>
      <div className="cut cut-card si-d-account">
        {/* eslint-disable-next-line @next/next/no-img-element -- prototype */}
        <img className="cut si-d-avatar" src={art.avatars[4]} alt="" />
        <div className="si-d-acc-body">
          <span className="label">You get one Account</span>
          <b>Made for you on first sign-in</b>
          <span className="si-d-chains">
            <span className="cut cut-chip"><ChainGlyph asset={0} size={14} /> Solana</span>
            <span className="cut cut-chip"><ChainGlyph asset={1} size={14} /> Ethereum</span>
            <span className="cut cut-chip"><ChainGlyph asset={2} size={14} /> HYPE</span>
          </span>
        </div>
      </div>
      <span className="label">Sign in with</span>
      {flow.codeStep ? (
        <CodeStep flow={flow} />
      ) : (
        <div className="si-d-list">
          <div className={`cut cut-card si-d-item${emailOpen ? " open" : ""}`}>
            <button type="button" className="si-d-row" aria-expanded={emailOpen} onClick={() => setEmailOpen((v) => !v)}>
              <span className="cut cut-chip si-d-ico"><Mail aria-hidden /></span>
              <span className="si-d-txt"><b>Email</b><small>We send you a 6-digit code</small></span>
              <ChevronRight aria-hidden className="si-d-chev" />
            </button>
            {emailOpen && (
              <div className="si-d-drop">
                <EmailRow flow={flow} />
              </div>
            )}
          </div>
          <div className="cut cut-card si-d-item">
            <button type="button" className="si-d-row" onClick={() => onWallet("solana")}>
              <span className="cut cut-chip si-d-ico"><ChainGlyph asset={0} size={20} /></span>
              <span className="si-d-txt"><b>Solana wallet</b><small>Phantom, Solflare, Backpack</small></span>
              <ChevronRight aria-hidden className="si-d-chev" />
            </button>
          </div>
          <div className="cut cut-card si-d-item">
            <button type="button" className="si-d-row" onClick={() => onWallet("evm")}>
              <span className="cut cut-chip si-d-ico"><EvmGlyphs size={18} /></span>
              <span className="si-d-txt"><b>Ethereum wallet</b><small>MetaMask, Rabby, WalletConnect</small></span>
              <ChevronRight aria-hidden className="si-d-chev" />
            </button>
          </div>
        </div>
      )}
      <ErrorLine flow={flow} />
      <p className="si-foot">Browsing needs no sign-in · Test mode, nothing has real value</p>
    </div>
  );
}

export function SignInSheetPrototype({ variant, ...props }: Props & { variant: Exclude<SignInVariant, "now"> }) {
  // key: each variant starts its own email flow
  if (variant === "A") return <VariantA key="A" {...props} />;
  if (variant === "B") return <VariantB key="B" {...props} />;
  if (variant === "C") return <VariantC key="C" {...props} />;
  return <VariantD key="D" {...props} />;
}
