import {FeatureFlags} from "@actions/expressions";
import {
  DependencyLockfileError,
  DependencyPin,
  dependencyIndexKey,
  dependencyLockfileDependencyToPin,
  parseDependencyLockfile
} from "@actions/workflow-parser/model/dependency-lockfile";
import {isActionStep, isJob, isReusableWorkflowJob} from "@actions/workflow-parser/model/type-guards";
import {WorkflowJob, WorkflowTemplate} from "@actions/workflow-parser/model/workflow-template";
import {StringToken} from "@actions/workflow-parser/templates/tokens/string-token";
import {File} from "@actions/workflow-parser/workflows/file";
import {TextDocument} from "vscode-languageserver-textdocument";
import {Diagnostic, URI} from "vscode-languageserver-types";
import {mapRange} from "./utils/range.js";

export type DependencyLockfileProvider = {
  getDependencyLockfile(workflowUri: URI): Promise<File | undefined>;
};

export function validateDependencyLockfile(textDocument: TextDocument, featureFlags?: FeatureFlags): Diagnostic[] {
  if (!featureFlags?.isEnabled("allowDependencies")) {
    return [];
  }

  const result = parseDependencyLockfile(textDocument.uri, textDocument.getText());
  return result.errors.map((err: DependencyLockfileError) => ({
    message: err.rawMessage,
    range: mapRange(err.range)
  }));
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
      diagnostics.push({
        message: `Action reference '${usesReference.token.value}' is not present in .github/actions.lock.yml`,
        range: mapRange(usesReference.token.range)
      });
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
  for (const dependency of workflowLock?.dependencies ?? []) {
    const pin = dependencyLockfileDependencyToPin(dependency);
    if (pin) {
      lockedDependencies.set(dependencyIndexKey(pin), pin);
    }
  }

  for (const usesReference of usesReferences) {
    const lockedPin = lockedDependencies.get(usesIndexKey(usesReference));
    if (!lockedPin) {
      diagnostics.push({
        message: `Action reference '${usesReference.token.value}' is not present in ${lockfile.name}`,
        range: mapRange(usesReference.token.range)
      });
    }
  }
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

  const sourcePath = uses.substring(0, atIdx).replace(/^github\.com\//, "");
  const ref = uses.substring(atIdx + 1);
  const parts = sourcePath.split(/[\\/]/);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return undefined;
  }

  const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;
  return {
    owner: parts[0],
    repo: parts[1],
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
