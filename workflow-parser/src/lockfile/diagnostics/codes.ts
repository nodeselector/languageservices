/**
 * @actions/workflow-parser lockfile diagnostics engine.
 *
 * Parity twin of the Go engine at actions-workflow-parser/go/lockfile/diagnostics.
 * Code strings, severity values, and validator semantics must stay
 * identical so every surface (CLI, language service, web editor) reports
 * the same findings.
 *
 * The package is deliberately decoupled from the workflow parser model —
 * it takes pre-extracted uses: references as input rather than parsed
 * templates, so it can travel with the lockfile types when they relocate
 * to their own package.
 */

/** Stable string identifier for a diagnostic class. Mirrors Go Code constants. */
export type DiagnosticCode =
  | "not_pinned"
  | "sha_as_ref"
  | "ref_changed"
  | "stale"
  | "transitive_unlocked"
  | "misleading_sha"
  | "ref_moved"
  | "lockfile_forgery"
  | "imposter_commit";

export const DiagnosticCodes = {
  NotPinned: "not_pinned",
  ShaAsRef: "sha_as_ref",
  RefChanged: "ref_changed",
  Stale: "stale",
  TransitiveUnlocked: "transitive_unlocked",
  MisleadingSha: "misleading_sha",
  RefMoved: "ref_moved",
  LockfileForgery: "lockfile_forgery",
  ImposterCommit: "imposter_commit"
} as const satisfies Record<string, DiagnosticCode>;

/** Default severity. Hosts may remap (LSP DiagnosticSeverity, CLI exit codes). */
export type DiagnosticSeverity = "info" | "warning" | "error";

/**
 * Optional source position in the workflow file. Hosts that derived
 * UsesRef from a parser can populate it; regex-based scanners may leave
 * it undefined.
 */
export type Position = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

/** A single diagnostic finding. */
export type Finding = {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  workflowPath: string;
  owner: string;
  repo: string;
  /** in-repo sub-path for monorepo actions; "" for root actions */
  path: string;
  ref: string;
  /** SHA recorded in the lockfile entry, if present */
  lockedSha?: string;
  /** Resolver-derived upstream SHA, if available */
  liveSha?: string;
  /** Direct parent action that pulls in a transitive finding */
  parentNwo?: string;
  position?: Position;
  message: string;
  remediation?: string;
};
