import type {Position} from "./codes.js";

/**
 * A single uses: reference extracted from a workflow. How the caller
 * derived it (regex, parser walk, anything else) is its own business —
 * the engine sees only the resolved owner/repo/path/ref tuple plus an
 * optional source position.
 */
export type UsesRef = {
  owner: string;
  repo: string;
  /** "" for root actions */
  path: string;
  ref: string;
  position?: Position;
};

/** A workflow path paired with the uses: refs found in it. */
export type WorkflowInput = {
  path: string;
  uses: UsesRef[];
};

/**
 * Index key for a uses: ref. Matches the lockfile Pin index-key shape:
 * "owner/repo[/path]@ref" with owner+repo lowercased. Path and ref preserve
 * source casing (git refs and on-disk paths are case-sensitive).
 */
export function usesIndexKey(u: UsesRef): string {
  const owner = u.owner.toLowerCase();
  const repo = u.repo.toLowerCase();
  const path = u.path ? `/${u.path}` : "";
  return `${owner}/${repo}${path}@${u.ref}`;
}
