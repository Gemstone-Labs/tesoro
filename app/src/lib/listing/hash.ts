/**
 * The hash `list_game` checks on chain: SHA-256 of the executable bytes without trailing zeros (an ExtendProgram only appends
 * zeros), from a ProgramData account (45-byte header) or a loader v4 program (48-byte header).
 */
export async function codeHash(accountData: Uint8Array, header = 45): Promise<string> {
  let end = accountData.length;
  while (end > header && accountData[end - 1] === 0) end--;
  const digest = await crypto.subtle.digest("SHA-256", accountData.slice(header, end));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
