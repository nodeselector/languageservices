import type {DependencyLockfile, DependencyPin} from "../../model/dependency-lockfile.js";
import {parsePin} from "../../model/dependency-lockfile.js";
import type {Finding} from "./codes.js";
import {DiagnosticCodes} from "./codes.js";
import type {UsesRef, WorkflowInput} from "./input.js";
import {usesIndexKey} from "./input.js";
import {isFullSha, nwo, nwoPath} from "./internal.js";

/** Helper: build the common header fields of a Finding from a UsesRef. */
function findingFromUse(
  workflowPath: string,
  u: UsesRef
): Pick<Finding, "workflowPath" | "owner" | "repo" | "path" | "ref" | "position"> {
  return {
    workflowPath,
    owner: u.owner,
    repo: u.repo,
    path: u.path,
    ref: u.ref,
    position: u.position
  };
}

/** Helper: build common Finding fields from a lock-entry pin. */
function findingFromPin(
  workflowPath: string,
  p: DependencyPin
): Pick<Finding, "workflowPath" | "owner" | "repo" | "path" | "ref" | "lockedSha"> {
  return {
    workflowPath,
    owner: p.owner,
    repo: p.repo,
    path: p.path ?? "",
    ref: p.ref,
    lockedSha: p.digest
  };
}

/**
 * Decodes a workflow's `dependencies: string[]` into parsed pins plus an
 * index keyed by "owner/repo[/path]@ref". Unparseable entries are dropped
 * silently — they're surfaced separately by parseDependencyLockfile.
 */
export function parseWorkflowDeps(rawDeps: readonly string[]): {
  pins: DependencyPin[];
  index: Map<string, DependencyPin>;
} {
  const pins: DependencyPin[] = [];
  const index = new Map<string, DependencyPin>();
  for (const raw of rawDeps) {
    const pin = parsePin(raw);
    if (!pin) {
      continue;
    }
    pins.push(pin);
    const key = `${pin.owner}/${pin.repo}${pin.path ? `/${pin.path}` : ""}@${pin.ref}`;
    index.set(key, pin);
  }
  return {pins, index};
}

/**
 * NOT_PINNED: any uses: ref that has no matching lockfile entry.
 * SHA-shaped refs are reported under sha_as_ref instead; if the same
 * action is pinned under a different ref, ref_changed wins.
 */
export function checkNotPinned(
  wf: WorkflowInput,
  depPins: readonly DependencyPin[],
  depIndex: ReadonlyMap<string, DependencyPin>
): Finding[] {
  if (wf.uses.length === 0) return [];
  const knownAction = new Set<string>();
  for (const p of depPins) {
    knownAction.add(nwoPath(p.owner, p.repo, p.path ?? ""));
  }
  const out: Finding[] = [];
  for (const u of wf.uses) {
    if (isFullSha(u.ref)) continue;
    if (depIndex.has(usesIndexKey(u))) continue;
    if (knownAction.has(nwoPath(u.owner, u.repo, u.path))) continue;
    out.push({
      ...findingFromUse(wf.path, u),
      code: DiagnosticCodes.NotPinned,
      severity: "error",
      message: `used in workflow but not pinned in lockfile (${nwoPath(u.owner, u.repo, u.path)}@${u.ref})`,
      remediation: "pin with `gh actions-pin`"
    });
  }
  return out;
}

/**
 * SHA_AS_REF: a uses: ref that is itself a bare commit SHA. The lock
 * entry's existence doesn't change the verdict — the anti-pattern is the
 * ref-string shape.
 */
export function checkShaAsRef(wf: WorkflowInput, depIndex: ReadonlyMap<string, DependencyPin>): Finding[] {
  const out: Finding[] = [];
  for (const u of wf.uses) {
    if (!isFullSha(u.ref)) continue;
    const locked = depIndex.get(usesIndexKey(u));
    out.push({
      ...findingFromUse(wf.path, u),
      code: DiagnosticCodes.ShaAsRef,
      severity: "warning",
      lockedSha: locked?.digest ?? u.ref,
      message: "pinned to a bare SHA without a symbolic ref — weakens supply-chain traceability",
      remediation: `pin to a tag instead: https://github.com/${nwo(u.owner, u.repo)}/releases`
    });
  }
  return out;
}

/**
 * REF_CHANGED: workflow uses: ref differs from the lockfile entry's ref
 * for the same action (owner/repo[/path]). A single action may have
 * multiple pinned refs across files; the check only fires when no pin
 * matches the workflow's ref.
 */
export function checkRefChanged(wf: WorkflowInput, depPins: readonly DependencyPin[]): Finding[] {
  if (depPins.length === 0) return [];
  const pinsByAction = new Map<string, DependencyPin[]>();
  for (const p of depPins) {
    const k = nwoPath(p.owner, p.repo, p.path ?? "");
    const arr = pinsByAction.get(k);
    if (arr) arr.push(p);
    else pinsByAction.set(k, [p]);
  }
  const out: Finding[] = [];
  for (const u of wf.uses) {
    if (isFullSha(u.ref)) continue;
    const candidates = pinsByAction.get(nwoPath(u.owner, u.repo, u.path));
    if (!candidates) continue;
    if (candidates.some(p => p.ref === u.ref)) continue;
    const p = candidates[0]!;
    out.push({
      ...findingFromUse(wf.path, u),
      code: DiagnosticCodes.RefChanged,
      severity: "error",
      lockedSha: p.digest,
      message: `workflow uses ref ${JSON.stringify(u.ref)} but lockfile pins ${JSON.stringify(p.ref)}`,
      remediation: "re-run `gh actions-pin` to refresh the lockfile, or revert the uses: line"
    });
  }
  return out;
}

/**
 * STALE: lockfile dep entries that no uses: ref in this workflow
 * references.
 */
export function checkStale(wf: WorkflowInput, depPins: readonly DependencyPin[]): Finding[] {
  if (depPins.length === 0) return [];
  const used = new Set<string>();
  for (const u of wf.uses) used.add(usesIndexKey(u));
  const out: Finding[] = [];
  for (const p of depPins) {
    const key = `${p.owner}/${p.repo}${p.path ? `/${p.path}` : ""}@${p.ref}`;
    if (used.has(key)) continue;
    out.push({
      ...findingFromPin(wf.path, p),
      code: DiagnosticCodes.Stale,
      severity: "warning",
      message: `lockfile pins ${nwoPath(p.owner, p.repo, p.path ?? "")}@${
        p.ref
      } but no uses: in this workflow references it`,
      remediation: "remove the entry or re-run `gh actions-pin`"
    });
  }
  return out;
}

/** Re-export needed for resolver checks. */
export {findingFromUse, findingFromPin};
export type {DependencyLockfile};
