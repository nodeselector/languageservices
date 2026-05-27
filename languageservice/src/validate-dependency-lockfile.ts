import {FeatureFlags} from "@actions/expressions";
import {DOC_URLS, releasesUrl} from "@actions/workflow-parser/lockfile/diagnostics/doc-urls";
import {
  DependencyLockfileError,
  DependencyPin,
  dependencyIndexKey,
  parsePin,
  parseDependencyLockfile
} from "@actions/workflow-parser/model/dependency-lockfile";
import {isActionStep, isJob, isReusableWorkflowJob} from "@actions/workflow-parser/model/type-guards";
import {WorkflowJob, WorkflowTemplate} from "@actions/workflow-parser/model/workflow-template";
import {StringToken} from "@actions/workflow-parser/templates/tokens/string-token";
import {File} from "@actions/workflow-parser/workflows/file";
import {TextDocument} from "vscode-languageserver-textdocument";
import {Diagnostic, URI} from "vscode-languageserver-types";
import type {LockfileDiagnosticData} from "./lockfile-diagnostic-data.js";
import {mapRange} from "./utils/range.js";

export type DependencyLockfileProvider = {
  getDependencyLockfile(workflowUri: URI): Promise<File | undefined>;
  /**
   * For lockfile-side coherence checks: list the `uses:` refs (e.g.
   * "actions/checkout@v4") for each workflow path the given lockfile
   * governs. Returning undefined disables those cross-doc checks; an
   * empty map means "no workflows found". Optional — hosts that don't
   * implement this just lose the orphan-dep diagnostics.
   */
  getWorkflowUses?(lockfileUri: URI): Promise<Map<string, string[]> | undefined>;
};

export async function validateDependencyLockfile(
  textDocument: TextDocument,
  dependencyLockfileProvider?: DependencyLockfileProvider,
  featureFlags?: FeatureFlags
): Promise<Diagnostic[]> {
  if (!featureFlags?.isEnabled("allowDependencies")) {
    return [];
  }

  const result = parseDependencyLockfile(textDocument.uri, textDocument.getText());
  const diagnostics: Diagnostic[] = result.errors.map((err: DependencyLockfileError) => ({
    message: err.rawMessage,
    range: mapRange(err.range)
  }));

  if (!result.value) return diagnostics;

  // Intra-lockfile coherence: drift between inner ref and key ref, and
  // actions-map entries no workflow declares as a dependency.
  const referencedKeys = new Set<string>();
  for (const wf of Object.values(result.value.workflows)) {
    for (const dep of wf.dependencies) referencedKeys.add(dep);
  }
  for (const [actionKey, action] of Object.entries(result.value.actions)) {
    const keyPin = parsePin(actionKey);
    if (keyPin && action.ref && keyPin.ref !== action.ref) {
      diagnostics.push({
        message: `lockfile action ${JSON.stringify(actionKey)} has ref ${JSON.stringify(
          action.ref
        )} but its key pins ref ${JSON.stringify(
          keyPin.ref
        )} — re-run \`gh actions-pin\` to reconcile, or remove the entry`,
        range: mapRange(action.keyRange)
      });
    }
    if (!referencedKeys.has(actionKey)) {
      diagnostics.push({
        message: `lockfile action ${JSON.stringify(
          actionKey
        )} is orphaned — no workflow's dependencies reference it; remove the entry or re-run \`gh actions-pin\``,
        range: mapRange(action.keyRange)
      });
    }
  }

  // Cross-doc coherence: the workflow source is the source of truth for
  // direct uses. For every `uses:` in the workflow, the lockfile must have
  // a matching dependency entry — otherwise the lockfile is incomplete.
  //
  // We deliberately do NOT report the reverse direction (lockfile dep with
  // no matching `uses:`) here: that fires false positives on composite-
  // action transitive dependencies. The lockfile correctly records the
  // transitive `actions/checkout@v6` pulled in by `org/composite@v1`, but
  // the workflow only `uses:` the composite. Without walking each
  // composite's `action.yml` (which the language service does not do) we
  // cannot tell a transitive from a genuinely stale entry, so we say
  // nothing rather than flag every transitive.
  const usesByWorkflow = dependencyLockfileProvider?.getWorkflowUses
    ? await dependencyLockfileProvider.getWorkflowUses(textDocument.uri)
    : undefined;
  if (usesByWorkflow) {
    for (const [workflowPath, wf] of Object.entries(result.value.workflows)) {
      const uses = usesByWorkflow.get(workflowPath);
      if (!uses) continue;
      const usedByKey = new Map<string, ParsedUses>();
      for (const u of uses) {
        const parsed = parseUsesRef(u);
        if (parsed) usedByKey.set(parsed.key, parsed);
      }
      const declaredKeys = new Set<string>();
      for (const dep of wf.dependencies) {
        const pin = parsePin(dep);
        if (!pin) continue;
        declaredKeys.add(dependencyIndexKey(pin));
      }
      for (const [key, used] of usedByKey) {
        if (declaredKeys.has(key)) continue;
        diagnostics.push(
          staleLockfileDiagnostic(
            `lockfile dependencies for ${JSON.stringify(workflowPath)} are stale — workflow \`uses:\` ${JSON.stringify(
              key
            )} but the lockfile doesn't track it; re-run \`gh actions-pin\``,
            mapRange(wf.keyRange),
            used,
            workflowPath
          )
        );
      }
    }
  }

  return diagnostics;
}

type ParsedUses = {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  key: string;
};

/** Parse an unpinned `uses:` ref like "actions/checkout@v4". */
function parseUsesRef(uses: string): ParsedUses | undefined {
  if (uses.startsWith("./") || uses.startsWith(".\\") || uses.startsWith("docker://")) return undefined;
  const at = uses.indexOf("@");
  if (at <= 0 || at === uses.length - 1) return undefined;
  const source = uses.substring(0, at);
  const ref = uses.substring(at + 1);
  const parts = source.split(/[\\/]/);
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  const owner = parts[0].toLowerCase();
  const repo = parts[1].toLowerCase();
  const path = parts.length > 2 ? parts.slice(2).join("/") : "";
  const keyPath = path ? "/" + path : "";
  return {owner, repo, path, ref, key: `${owner}/${repo}${keyPath}@${ref}`};
}

function staleLockfileDiagnostic(
  message: string,
  range: Diagnostic["range"],
  target: {owner: string; repo: string; path: string; ref: string},
  workflowPath: string
): Diagnostic {
  const data: LockfileDiagnosticData = {
    kind: "lockfile",
    code: "stale",
    owner: target.owner,
    repo: target.repo,
    path: target.path,
    ref: target.ref,
    workflowPath,
    docUrl: DOC_URLS.stale,
    releaseUrl: releasesUrl(target.owner, target.repo, target.ref)
  };
  return {
    message,
    range,
    code: "stale",
    codeDescription: {href: DOC_URLS.stale},
    source: "github-actions",
    data
  };
}

export async function validateWorkflowUsesAgainstLockfile(
  diagnostics: Diagnostic[],
  workflowUri: URI,
  template: WorkflowTemplate,
  dependencyLockfileProvider: DependencyLockfileProvider | undefined,
  featureFlags?: FeatureFlags
): Promise<void> {
  if (!featureFlags?.isEnabled("allowDependencies") || !dependencyLockfileProvider) {
    return;
  }

  const usesReferences = getWorkflowUsesReferences(template);
  if (usesReferences.length === 0) {
    return;
  }

  const lockfile = await dependencyLockfileProvider.getDependencyLockfile(workflowUri);
  if (!lockfile) {
    for (const usesReference of usesReferences) {
      diagnostics.push(
        notPinnedDiagnostic(
          usesReference,
          `Action reference '${usesReference.token.value}' is not present in .github/workflows/actions.lock`,
          workflowPathFromUri(workflowUri)
        )
      );
    }
    return;
  }

  const lockfileResult = parseDependencyLockfile(lockfile.name, lockfile.content);
  if (!lockfileResult.value) {
    const message = lockfileResult.errors[0]?.rawMessage ?? "dependency lockfile is invalid";
    diagnostics.push({
      message: `Unable to validate dependency lockfile: ${message}`,
      range: mapRange(usesReferences[0].token.range)
    });
    return;
  }

  const workflowPath = workflowPathFromUri(workflowUri);
  const workflowLock = workflowPath ? lockfileResult.value.workflows[workflowPath] : undefined;
  const lockedDependencies = new Map<string, DependencyPin>();
  for (const dep of workflowLock?.dependencies ?? []) {
    const pin = parsePin(dep);
    if (pin) {
      lockedDependencies.set(dependencyIndexKey(pin), pin);
    }
  }

  for (const usesReference of usesReferences) {
    const lockedPin = lockedDependencies.get(usesIndexKey(usesReference));
    if (!lockedPin) {
      diagnostics.push(
        notPinnedDiagnostic(
          usesReference,
          `Action reference '${usesReference.token.value}' is not present in ${lockfile.name}`,
          workflowPath
        )
      );
    }
  }
}

/**
 * Build a NOT_PINNED diagnostic with the same enrichment shape
 * (code, codeDescription, data) used by validate-pin-integrity, so the
 * lockfile quick-fix provider can handle both surfaces uniformly.
 */
function notPinnedDiagnostic(ref: UsesReference, message: string, workflowPath: string | undefined): Diagnostic {
  const data: LockfileDiagnosticData = {
    kind: "lockfile",
    code: "not_pinned",
    owner: ref.owner,
    repo: ref.repo,
    path: ref.path ?? "",
    ref: ref.ref,
    workflowPath: workflowPath ?? "",
    docUrl: DOC_URLS.not_pinned,
    releaseUrl: releasesUrl(ref.owner, ref.repo, ref.ref)
  };
  return {
    message,
    range: mapRange(ref.token.range),
    code: "not_pinned",
    codeDescription: {href: DOC_URLS.not_pinned},
    source: "github-actions",
    data
  };
}

type UsesReference = {
  owner: string;
  repo: string;
  path?: string;
  ref: string;
  token: StringToken;
};

function getWorkflowUsesReferences(template: WorkflowTemplate): UsesReference[] {
  const references: UsesReference[] = [];
  for (const job of template.jobs ?? []) {
    collectJobUsesReferences(references, job);
  }
  return references;
}

function collectJobUsesReferences(references: UsesReference[], job: WorkflowJob) {
  if (isReusableWorkflowJob(job)) {
    const reusableWorkflowRef = parseUsesReference(job.ref);
    if (reusableWorkflowRef) {
      references.push(reusableWorkflowRef);
    }

    for (const calledJob of job.jobs ?? []) {
      collectJobUsesReferences(references, calledJob);
    }
    return;
  }

  if (isJob(job)) {
    for (const step of job.steps) {
      if (isActionStep(step)) {
        const actionRef = parseUsesReference(step.uses);
        if (actionRef) {
          references.push(actionRef);
        }
      }
    }
  }
}

function parseUsesReference(token: StringToken): UsesReference | undefined {
  const uses = token.value;
  if (uses.startsWith("./") || uses.startsWith(".\\") || uses.startsWith("docker://")) {
    return undefined;
  }

  const atIdx = uses.indexOf("@");
  if (atIdx <= 0 || atIdx === uses.length - 1) {
    return undefined;
  }

  const sourcePath = uses.substring(0, atIdx);
  const ref = uses.substring(atIdx + 1);
  const parts = sourcePath.split(/[\\/]/);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return undefined;
  }

  const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;
  return {
    owner: parts[0].toLowerCase(),
    repo: parts[1].toLowerCase(),
    path,
    ref,
    token
  };
}

function usesIndexKey(usesReference: UsesReference): string {
  const path = usesReference.path ? `/${usesReference.path}` : "";
  return `${usesReference.owner}/${usesReference.repo}${path}@${usesReference.ref}`;
}

function workflowPathFromUri(uri: URI): string | undefined {
  const normalizedUri = uri.replace(/\\/g, "/");
  const workflowsIndex = normalizedUri.toLowerCase().lastIndexOf(".github/workflows/");
  if (workflowsIndex < 0) {
    return undefined;
  }

  return normalizedUri.substring(workflowsIndex);
}
