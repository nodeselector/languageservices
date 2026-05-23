import type {DependencyPin} from "../../model/dependency-lockfile.js";
import type {Finding} from "./codes.js";
import {DiagnosticCodes} from "./codes.js";
import type {UsesRef, WorkflowInput} from "./input.js";
import {usesIndexKey} from "./input.js";
import {equalSha, isFullSha, shortSha} from "./internal.js";
import type {ActionResolver, ResolverContext} from "./resolver.js";
import {findingFromUse} from "./structural.js";

/**
 * MISLEADING_SHA: a uses: ref that looks like a SHA but the resolver
 * maps it to a different commit. Lock-entry-independent.
 */
export async function checkMisleadingSha(
  ctx: ResolverContext,
  wf: WorkflowInput,
  r: ActionResolver
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const u of wf.uses) {
    if (!isFullSha(u.ref)) continue;
    const res = await r.resolveRef(ctx, u.owner, u.repo, u.ref);
    if (res.status !== "resolved" || !res.sha) continue;
    if (equalSha(res.sha, u.ref)) continue;
    out.push({
      ...findingFromUse(wf.path, u),
      code: DiagnosticCodes.MisleadingSha,
      severity: "error",
      liveSha: res.sha,
      lockedSha: u.ref,
      message: `ref ${shortSha(u.ref)} resolves to ${shortSha(
        res.sha
      )} — the ref string looks like a SHA but isn't this commit`,
      remediation: "investigate — the ref may be a tag named after a SHA, not the SHA itself"
    });
  }
  return out;
}

/**
 * REF_MOVED + LOCKFILE_FORGERY: upstream ref now resolves to a different
 * SHA than the lockfile. If CheckAncestry says the locked SHA is NOT an
 * ancestor of the live SHA, the finding is upgraded to LOCKFILE_FORGERY
 * (mutually exclusive — forgery is the stronger signal).
 */
export async function checkRefMovedAndForgery(
  ctx: ResolverContext,
  wf: WorkflowInput,
  depIndex: ReadonlyMap<string, DependencyPin>,
  r: ActionResolver
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const u of wf.uses) {
    if (isFullSha(u.ref)) continue; // misleading_sha territory
    const pin = depIndex.get(usesIndexKey(u));
    if (!pin) continue;
    const res = await r.resolveRef(ctx, u.owner, u.repo, u.ref);
    if (res.status !== "resolved" || !res.sha) continue;
    if (equalSha(res.sha, pin.digest)) continue;

    const ancestry = await r.checkAncestry(ctx, u.owner, u.repo, pin.digest, res.sha);
    const base = {
      ...findingFromUse(wf.path, u),
      lockedSha: pin.digest,
      liveSha: res.sha
    };
    if (ancestry === "not_ancestor") {
      out.push({
        ...base,
        code: DiagnosticCodes.LockfileForgery,
        severity: "error",
        message: `pinned ${shortSha(pin.digest)} is not an ancestor of ${shortSha(
          res.sha
        )} — lockfile may have been tampered with`,
        remediation: "investigate immediately — verify the lockfile entry against upstream history"
      });
    } else {
      out.push({
        ...base,
        code: DiagnosticCodes.RefMoved,
        severity: "warning",
        message: `ref ${u.ref} now resolves to ${shortSha(res.sha)}, lockfile pins ${shortSha(pin.digest)}`,
        remediation: "re-run `gh actions-pin` to refresh the lock entry"
      });
    }
  }
  return out;
}

/**
 * IMPOSTER_COMMIT: locked SHA not reachable from the ref's history.
 * Mutually exclusive with LOCKFILE_FORGERY: the latter is emitted in the
 * same pass when both signals fire, so this validator only flags entries
 * where ancestry was inconclusive or never checked.
 */
export async function checkImposterCommit(
  ctx: ResolverContext,
  wf: WorkflowInput,
  depIndex: ReadonlyMap<string, DependencyPin>,
  r: ActionResolver,
  forgeryKeys: ReadonlySet<string>
): Promise<Finding[]> {
  if (depIndex.size === 0) return [];
  const out: Finding[] = [];
  for (const u of wf.uses) {
    if (isFullSha(u.ref)) continue;
    const pin = depIndex.get(usesIndexKey(u));
    if (!pin) continue;
    if (forgeryKeys.has(usesIndexKey(u))) continue;
    const status = await r.checkReachability(ctx, u.owner, u.repo, pin.digest, u.ref);
    if (status !== "unreachable") continue;
    out.push({
      ...findingFromUse(wf.path, u),
      code: DiagnosticCodes.ImposterCommit,
      severity: "error",
      lockedSha: pin.digest,
      message: `locked ${shortSha(pin.digest)} is not reachable from ${
        u.ref
      } — classic fork-network imposter-commit shape`,
      remediation: "investigate immediately — the lockfile entry may have been injected"
    });
  }
  return out;
}
