import type {DiagnosticCode} from "@actions/workflow-parser/lockfile/diagnostics/codes";

/**
 * Payload attached to `Diagnostic.data` for every lockfile finding the
 * language service emits. Lets the quick-fix provider build remediation
 * actions without re-parsing the workflow or re-running the engine.
 *
 * Stable across diagnostic sources (NOT_PINNED from
 * validate-dependency-lockfile and every other code from
 * validate-pin-integrity) so a single CodeActionProvider can serve both.
 */
export type LockfileDiagnosticData = {
  /** Stable marker so quick-fix providers can recognize our payload
   *  without trusting `Diagnostic.code` alone (clients may strip it). */
  kind: "lockfile";
  /** Engine code, e.g. "ref_moved", "not_pinned". */
  code: DiagnosticCode | "not_pinned";
  /** Action coordinates. `path` is "" for root actions. */
  owner: string;
  repo: string;
  path: string;
  ref: string;
  /** Workflow path (repo-relative), the same key used in actions.lock. */
  workflowPath: string;
  /** SHA in the lockfile, when known. */
  lockedSha?: string;
  /** Upstream SHA the resolver returned, when known. */
  liveSha?: string;
  /** Documentation URL for the finding (mirrors codeDescription.href). */
  docUrl?: string;
  /** GitHub releases URL for the action — drives "View release" quick fix. */
  releaseUrl: string;
};
