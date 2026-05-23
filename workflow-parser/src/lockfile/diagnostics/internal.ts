/**
 * Reports whether s is the hex shape of a fully-qualified git commit SHA
 * (40 chars for sha1, 64 chars for sha256). Pure string-shape check — does
 * not verify the commit exists upstream.
 *
 * Parity twin of lockfile.IsFullSha in the Go package.
 */
export function isFullSha(s: string): boolean {
  if (s.length !== 40 && s.length !== 64) {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isDigit = c >= 0x30 && c <= 0x39;
    const isLower = c >= 0x61 && c <= 0x66;
    const isUpper = c >= 0x41 && c <= 0x46;
    if (!isDigit && !isLower && !isUpper) {
      return false;
    }
  }
  return true;
}

/** Case-insensitive equality. Stdlib doesn't ship one; the engine uses it for SHA compare. */
export function equalSha(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

/** "owner/repo" lowercased. */
export function nwo(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** "owner/repo" or "owner/repo/path", lowercased owner/repo. */
export function nwoPath(owner: string, repo: string, path: string): string {
  const base = nwo(owner, repo);
  return path ? `${base}/${path}` : base;
}

/** Short SHA for human-readable messages. */
export function shortSha(s: string): string {
  return s.length <= 12 ? s : s.substring(0, 12);
}
