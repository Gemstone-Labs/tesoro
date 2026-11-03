import { keeperCluster } from "./cluster.ts";
import type { FlagSpec } from "./cli-args.ts";

export const ADMIN_COMMANDS = ["tables", "fees", "fill", "refill", "batches"] as const;
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

/** The flags of `admin-cli`: the keeper's settings flags that apply to a one-off run, plus the script's own. */
export const ADMIN_FLAGS: FlagSpec = {
  bare: ["dry-run"],
  valued: ["cluster", "rpc", "gpa-rpc", "hoodi-rpc", "hyperevm-rpc", "max-sol-per-hour", "max-lz-fee-sol", "max-lz-sol-per-hour", "game", "size", "max-gemas", "passes", "history"],
};

/** The command (first argument) and the flags after it. */
export function parseAdminArgv(argv: string[]): { command: AdminCommand; rest: string[] } {
  const [command, ...rest] = argv;
  if (!command || command.startsWith("--")) throw new Error(`a command is required: ${ADMIN_COMMANDS.join(" | ")}`);
  if (!(ADMIN_COMMANDS as readonly string[]).includes(command)) throw new Error(`unknown command ${command}: ${ADMIN_COMMANDS.join(" | ")}`);
  return { command: command as AdminCommand, rest };
}

/**
 * The script runs on the cluster the environment selects (TESORO_CLUSTER, default test) and `--cluster` must say so, so a
 * command typed for one cluster never runs on the other. The RPC's genesis hash is checked against it when the key loads.
 */
export function assertExpectedCluster(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!flag) throw new Error("--cluster test|mainnet is required");
  if (flag !== "test" && flag !== "mainnet") throw new Error(`--cluster must be test or mainnet, not ${flag}`);
  const selected = keeperCluster(env).id;
  if (selected !== flag) throw new Error(`--cluster ${flag} was given but TESORO_CLUSTER selects ${selected}, not ${flag}; refusing`);
}

/** What each command does once, built from the keeper's own step code (see admin-cli.ts). `redeem` is the Treasury step before `fill`. */
export type AdminSteps = Record<AdminCommand, () => Promise<number>> & { redeem?: () => Promise<number> };

export interface AdminOptions {
  dryRun: boolean;
  /** Most passes of `tables`, which makes a table in steps (create, delegate, seat) and stops at the first pass that does nothing. */
  passes: number;
  pause(): Promise<void>;
  /** The fill budget in Gemas; `fill` needs one. */
  maxGemas: bigint;
}

/** Runs one command: returns the actions of the last pass. */
export async function runAdmin(command: AdminCommand, o: AdminOptions, steps: AdminSteps): Promise<number> {
  if (command === "fill") {
    if (o.maxGemas <= 0n) throw new Error("fill needs --max-gemas <Gemas>: the most it may fill in this run");
    await steps.redeem?.();
    return steps.fill();
  }
  if (command !== "tables") return steps[command]();
  let actions = 0;
  for (let pass = 1; pass <= (o.dryRun ? 1 : o.passes); pass++) {
    actions = await steps.tables();
    if (actions === 0) break;
    await o.pause();
  }
  return actions;
}
