/**
 * Documentation URLs for each lockfile diagnostic code.
 *
 * Parity twin of the Go engine's doc URL table (CLI maintains its own copy
 * in `internal/doctor/doc_urls.go`). Strings here MUST stay in sync; both
 * surfaces present the same link to users so the experience is identical
 * across editor and CLI.
 *
 * Every finding gets a link. Codes that don't yet have a dedicated docs
 * anchor fall back to the canonical "using third-party actions" page so
 * users always land somewhere actionable.
 */

import type {DiagnosticCode} from "./codes.js";
import {DiagnosticCodes} from "./codes.js";

/** Canonical GitHub docs page covering third-party-action hardening. */
const SECURITY_HARDENING_BASE =
  "https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions";

/** Per-code documentation URLs. Anchors are kept as fragments so the table
 *  stays scannable and trivial to update when GH docs publishes per-code
 *  sections. */
export const DOC_URLS: Record<DiagnosticCode, string> = {
  [DiagnosticCodes.NotPinned]: `${SECURITY_HARDENING_BASE}#using-third-party-actions`,
  [DiagnosticCodes.ShaAsRef]: `${SECURITY_HARDENING_BASE}#using-third-party-actions`,
  [DiagnosticCodes.RefChanged]: `${SECURITY_HARDENING_BASE}#using-third-party-actions`,
  [DiagnosticCodes.Stale]: `${SECURITY_HARDENING_BASE}#using-third-party-actions`,
  [DiagnosticCodes.TransitiveUnlocked]: `${SECURITY_HARDENING_BASE}#using-third-party-actions`,
  [DiagnosticCodes.MisleadingSha]: `${SECURITY_HARDENING_BASE}#using-third-party-actions`,
  [DiagnosticCodes.RefMoved]: `${SECURITY_HARDENING_BASE}#using-third-party-actions`,
  [DiagnosticCodes.LockfileForgery]: `${SECURITY_HARDENING_BASE}#using-third-party-actions`,
  [DiagnosticCodes.ImposterCommit]: `${SECURITY_HARDENING_BASE}#using-third-party-actions`
};

/**
 * Build the GitHub releases URL for an action. When `ref` looks like a
 * tag, links to the specific release; otherwise links to the releases
 * index so users can pick one.
 *
 * Used by hosts (editors, CLI) to offer "View release" navigation
 * alongside the diagnostic — encourages users to validate what they're
 * pinning to.
 */
export function releasesUrl(owner: string, repo: string, ref?: string): string {
  const base = `https://github.com/${owner}/${repo}/releases`;
  if (ref && isLikelyTag(ref)) {
    return `${base}/tag/${ref}`;
  }
  return base;
}

/** Heuristic: a ref is "likely a tag" when it isn't a full SHA and isn't a
 *  branch-looking name like `main` / `master`. We're deliberately lenient
 *  — the worst case is a 404 page, and the releases index is a fine
 *  fallback. */
function isLikelyTag(ref: string): boolean {
  if (/^[0-9a-f]{40}$/i.test(ref)) return false;
  if (ref === "main" || ref === "master" || ref === "trunk") return false;
  return true;
}
