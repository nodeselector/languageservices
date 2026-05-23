import {FeatureFlags} from "@actions/expressions";
import {lockfileDiagnostics} from "@actions/workflow-parser";
import {parseDependencyLockfile} from "@actions/workflow-parser/model/dependency-lockfile";
import {isActionStep, isJob, isReusableWorkflowJob} from "@actions/workflow-parser/model/type-guards";
import {WorkflowJob, WorkflowTemplate} from "@actions/workflow-parser/model/workflow-template";
import {StringToken} from "@actions/workflow-parser/templates/tokens/string-token";
import {Diagnostic, DiagnosticSeverity, URI} from "vscode-languageserver-types";
import {mapRange} from "./utils/range.js";
import {DependencyLockfileProvider} from "./validate-dependency-lockfile.js";

/**
 * Optional adapter to the workflow-parser lockfile diagnostics engine.
 * Hosts that can answer "is this ref still current?" / "is this commit an
 * ancestor / reachable?" supply an {@link lockfileDiagnostics.ActionResolver};
 * when absent or when individual calls return "unknown", the corresponding
 * validators silently skip — there is no degraded-mode diagnostic.
 */
export type PinIntegrityConfig = {
  actionResolver?: lockfileDiagnostics.ActionResolver;
  actionFileProvider?: lockfileDiagnostics.ActionFileProvider;
};

/**
 * Runs the lockfile diagnostics engine against the workflow + its lockfile
 * and emits LSP diagnostics for findings beyond the basic NOT_PINNED case
 * already covered by {@link validateWorkflowUsesAgainstLockfile}.
 *
 * Skipped when:
 *  - the allowDependencies feature flag is off,
 *  - no lockfile provider is configured,
 *  - no resolver and no file provider is supplied (engine would be a no-op),
 *  - the workflow has no uses: references.
 */
export async function validateWorkflowPinIntegrity(
  diagnostics: Diagnostic[],
  workflowUri: URI,
  template: WorkflowTemplate,
  dependencyLockfileProvider: DependencyLockfileProvider | undefined,
  pinIntegrity: PinIntegrityConfig | undefined,
  featureFlags?: FeatureFlags,
  signal?: AbortSignal
): Promise<void> {
  if (!featureFlags?.isEnabled("allowDependencies") || !dependencyLockfileProvider) {
    return;
  }
  if (!pinIntegrity || (!pinIntegrity.actionResolver && !pinIntegrity.actionFileProvider)) {
    return;
  }

  const refs = collectUsesReferences(template);
  if (refs.length === 0) {
    return;
  }

  const lockfile = await dependencyLockfileProvider.getDependencyLockfile(workflowUri);
  if (!lockfile) {
    // Missing lockfile → NOT_PINNED already covered upstream.
    return;
  }

  const parsed = parseDependencyLockfile(lockfile.name, lockfile.content);
  if (!parsed.value) {
    // Parser errors surface through validateDependencyLockfile.
    return;
  }

  const workflowPath = workflowPathFromUri(workflowUri);
  if (!workflowPath) {
    return;
  }

  const input: lockfileDiagnostics.WorkflowInput = {
    path: workflowPath,
    uses: refs.map(r => ({owner: r.owner, repo: r.repo, path: r.path, ref: r.ref}))
  };

  const findings = await lockfileDiagnostics.runDiagnostics(parsed.value, [input], {
    resolver: pinIntegrity.actionResolver,
    actionFileProvider: pinIntegrity.actionFileProvider,
    signal
  });

  const tokenByKey = new Map<string, StringToken>();
  for (const r of refs) {
    tokenByKey.set(usesKey(r.owner, r.repo, r.path, r.ref), r.token);
  }

  for (const f of findings) {
    // NOT_PINNED is already emitted (with editor-tuned message) by
    // validateWorkflowUsesAgainstLockfile — skip the engine's twin to avoid
    // duplicates.
    if (f.code === lockfileDiagnostics.DiagnosticCodes.NotPinned) continue;

    const token = tokenByKey.get(usesKey(f.owner, f.repo, f.path, f.ref));
    if (!token) continue;

    const message = f.remediation ? `${f.message} — ${f.remediation}` : f.message;
    diagnostics.push({
      message,
      range: mapRange(token.range),
      severity: mapSeverity(f.severity),
      code: f.code,
      source: "github-actions"
    });
  }
}

type UsesReference = {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  token: StringToken;
};

function collectUsesReferences(template: WorkflowTemplate): UsesReference[] {
  const out: UsesReference[] = [];
  for (const job of template.jobs ?? []) {
    collectJobUsesReferences(out, job);
  }
  return out;
}

function collectJobUsesReferences(out: UsesReference[], job: WorkflowJob): void {
  if (isReusableWorkflowJob(job)) {
    for (const calledJob of job.jobs ?? []) {
      collectJobUsesReferences(out, calledJob);
    }
    return;
  }
  if (!isJob(job)) return;
  for (const step of job.steps) {
    if (!isActionStep(step)) continue;
    const parsed = parseUsesReference(step.uses);
    if (parsed) out.push(parsed);
  }
}

function parseUsesReference(token: StringToken): UsesReference | undefined {
  const uses = token.value;
  if (uses.startsWith("./") || uses.startsWith(".\\") || uses.startsWith("docker://")) {
    return undefined;
  }
  const atIdx = uses.indexOf("@");
  if (atIdx <= 0 || atIdx === uses.length - 1) return undefined;
  const sourcePath = uses.substring(0, atIdx);
  const ref = uses.substring(atIdx + 1);
  const parts = sourcePath.split(/[\\/]/);
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  return {
    owner: parts[0].toLowerCase(),
    repo: parts[1].toLowerCase(),
    path: parts.length > 2 ? parts.slice(2).join("/") : "",
    ref,
    token
  };
}

function usesKey(owner: string, repo: string, path: string, ref: string): string {
  const suffix = path ? `/${path}` : "";
  return `${owner.toLowerCase()}/${repo.toLowerCase()}${suffix}@${ref}`;
}

function workflowPathFromUri(uri: URI): string | undefined {
  const normalized = uri.replace(/\\/g, "/");
  const idx = normalized.toLowerCase().lastIndexOf(".github/workflows/");
  if (idx < 0) return undefined;
  return normalized.substring(idx);
}

function mapSeverity(s: lockfileDiagnostics.DiagnosticSeverity): DiagnosticSeverity {
  switch (s) {
    case "error":
      return DiagnosticSeverity.Error;
    case "warning":
      return DiagnosticSeverity.Warning;
    default:
      return DiagnosticSeverity.Information;
  }
}
