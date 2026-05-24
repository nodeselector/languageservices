import type {DependencyLockfile} from "../../model/dependency-lockfile.js";
import type {Finding} from "./codes.js";
import {DiagnosticCodes} from "./codes.js";
import {DOC_URLS} from "./doc-urls.js";
import type {UsesRef, WorkflowInput} from "./input.js";
import {usesIndexKey} from "./input.js";
import type {ActionFileProvider, ActionResolver, ResolverContext} from "./resolver.js";
import {checkImposterCommit, checkMisleadingSha, checkRefMovedAndForgery} from "./resolver-checks.js";
import {checkNotPinned, checkRefChanged, checkShaAsRef, checkStale, parseWorkflowDeps} from "./structural.js";

/** Options bag for {@link runDiagnostics}. */
export type RunOptions = {
  /**
   * Enables resolver-bound validators (misleading_sha, ref_moved,
   * lockfile_forgery, imposter_commit). When omitted those validators are
   * skipped silently.
   */
  resolver?: ActionResolver;
  /**
   * Enables the transitive_unlocked validator. When omitted that
   * validator is skipped.
   */
  actionFileProvider?: ActionFileProvider;
  /** AbortSignal forwarded to every Resolver / ActionFileProvider call. */
  signal?: AbortSignal;
};

/**
 * Engine entrypoint. Evaluates every enabled validator against the given
 * lockfile and workflow inputs and returns a flat list of findings in
 * stable order: findings for earlier workflows come first, and within a
 * workflow the order follows the catalog order in codes.ts.
 *
 * Never throws: validators that cannot answer (no resolver, resolver
 * returned "unknown", action file fetch failed) skip silently. Hosts are
 * responsible for surfacing degraded-mode messaging.
 */
export async function runDiagnostics(
  lockfile: DependencyLockfile,
  workflows: readonly WorkflowInput[],
  opts: RunOptions = {}
): Promise<Finding[]> {
  const out: Finding[] = [];
  const ctx: ResolverContext = {signal: opts.signal};
  for (const wf of workflows) {
    out.push(...(await runOne(ctx, lockfile, wf, opts)));
  }
  // Single-pass enrichment so per-validator files stay focused on detection
  // and don't have to know about presentation concerns (doc URLs).
  for (const f of out) {
    if (!f.docUrl) {
      f.docUrl = DOC_URLS[f.code];
    }
  }
  return out;
}

async function runOne(
  ctx: ResolverContext,
  lf: DependencyLockfile,
  wf: WorkflowInput,
  opts: RunOptions
): Promise<Finding[]> {
  const out: Finding[] = [];
  const rawDeps = lf.workflows[wf.path]?.dependencies ?? [];
  const {pins, index} = parseWorkflowDeps(rawDeps);

  // 1. Structural.
  out.push(...checkNotPinned(wf, pins, index));
  out.push(...checkShaAsRef(wf, index));
  out.push(...checkRefChanged(wf, pins));
  out.push(...checkStale(wf, pins));

  // 2. Resolver-bound.
  if (opts.resolver) {
    out.push(...(await checkMisleadingSha(ctx, wf, opts.resolver)));
    const refMoved = await checkRefMovedAndForgery(ctx, wf, index, opts.resolver);
    out.push(...refMoved);
    const forgeryKeys = collectForgeryKeys(wf.uses, refMoved);
    out.push(...(await checkImposterCommit(ctx, wf, index, opts.resolver, forgeryKeys)));
  }

  // 3. transitive_unlocked is deferred until the ActionFileProvider walk
  //    is implemented; the seam is here for future wiring.

  return out;
}

function collectForgeryKeys(uses: readonly UsesRef[], findings: readonly Finding[]): Set<string> {
  const keys = new Set<string>();
  if (findings.length === 0) return keys;
  const byNwoRef = new Map<string, UsesRef>();
  for (const u of uses) {
    byNwoRef.set(usesIndexKey(u), u);
  }
  for (const f of findings) {
    if (f.code !== DiagnosticCodes.LockfileForgery) continue;
    const u = byNwoRef.get(`${f.owner.toLowerCase()}/${f.repo.toLowerCase()}${f.path ? `/${f.path}` : ""}@${f.ref}`);
    if (u) keys.add(usesIndexKey(u));
  }
  return keys;
}
