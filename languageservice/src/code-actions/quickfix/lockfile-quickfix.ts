import {CodeAction, Command, Diagnostic} from "vscode-languageserver-types";
import type {LockfileDiagnosticData} from "../../lockfile-diagnostic-data.js";
import {CodeActionContext, CodeActionProvider} from "../types.js";

/**
 * Custom command the LSP emits for "repin" quick fixes. The VS Code
 * extension (or any other client) is responsible for wiring this command
 * to the actual `gh actions-pin` invocation — the LSP can't run commands
 * itself.
 *
 * Args:  [{ workflowPath: string, owner: string, repo: string,
 *            path: string, ref: string }]
 */
export const REPIN_COMMAND = "github-actions.lockfile.repin";

/**
 * VS Code's built-in command for opening a URL in the user's browser /
 * preview pane. Standard LSP clients honor it; non-VS Code clients can
 * implement an equivalent or ignore the action.
 */
const OPEN_URL_COMMAND = "vscode.open";

/**
 * All lockfile codes the upstream engine can produce, plus the
 * NOT_PINNED variant emitted by validate-dependency-lockfile.ts.
 */
const LOCKFILE_CODES: string[] = [
  "not_pinned",
  "sha_as_ref",
  "ref_changed",
  "stale",
  "transitive_unlocked",
  "misleading_sha",
  "ref_moved",
  "lockfile_forgery",
  "imposter_commit"
];

/**
 * Codes whose primary remediation is "rerun the pinner". Surfacing the
 * action behind a command keeps the LSP host-agnostic: the actual
 * `gh actions-pin` invocation belongs to the extension.
 */
const REPIN_CODES = new Set(["not_pinned", "ref_changed", "ref_moved", "stale", "transitive_unlocked"]);

function lockfileDataOf(diagnostic: Diagnostic): LockfileDiagnosticData | undefined {
  const data = diagnostic.data as LockfileDiagnosticData | undefined;
  if (!data || data.kind !== "lockfile") return undefined;
  return data;
}

/**
 * Quick fix: "Repin with `gh actions-pin`" — emits a Command the host
 * extension binds to its CLI runner. We don't construct a WorkspaceEdit
 * here because the edit lives in `actions.lock` (a sibling document) and
 * computing the new SHA requires a network call we deliberately keep on
 * the CLI's side of the line.
 */
const repinProvider: CodeActionProvider = {
  diagnosticCodes: [...REPIN_CODES],

  createCodeAction(_context: CodeActionContext, diagnostic: Diagnostic): CodeAction | undefined {
    const data = lockfileDataOf(diagnostic);
    if (!data || !REPIN_CODES.has(data.code)) return undefined;
    const target = `${data.owner}/${data.repo}${data.path ? "/" + data.path : ""}@${data.ref}`;
    return {
      title: `Repin ${target} with \`gh actions-pin\``,
      isPreferred: true,
      command: Command.create("Repin with gh actions-pin", REPIN_COMMAND, {
        workflowPath: data.workflowPath,
        owner: data.owner,
        repo: data.repo,
        path: data.path,
        ref: data.ref
      })
    };
  }
};

/**
 * Quick fix: "View releases for owner/repo" — opens GitHub releases so
 * the user can verify what they're about to pin, then pick a tagged
 * release. Offered for every lockfile code: validating the upstream is
 * always a sensible next step.
 */
const viewReleasesProvider: CodeActionProvider = {
  diagnosticCodes: LOCKFILE_CODES,

  createCodeAction(_context: CodeActionContext, diagnostic: Diagnostic): CodeAction | undefined {
    const data = lockfileDataOf(diagnostic);
    if (!data) return undefined;
    return {
      title: `View releases for ${data.owner}/${data.repo}`,
      command: Command.create("View releases", OPEN_URL_COMMAND, data.releaseUrl)
    };
  }
};

/**
 * Quick fix: "Open documentation for this finding" — links to the
 * canonical docs page for the diagnostic code. Same URL the editor
 * surfaces via `codeDescription`; offered here too so users can reach it
 * from the lightbulb menu, not just by hovering the diagnostic code.
 */
const openDocsProvider: CodeActionProvider = {
  diagnosticCodes: LOCKFILE_CODES,

  createCodeAction(_context: CodeActionContext, diagnostic: Diagnostic): CodeAction | undefined {
    const data = lockfileDataOf(diagnostic);
    if (!data || !data.docUrl) return undefined;
    return {
      title: "Open documentation for this finding",
      command: Command.create("Open documentation", OPEN_URL_COMMAND, data.docUrl)
    };
  }
};

export const lockfileQuickfixProviders: CodeActionProvider[] = [repinProvider, viewReleasesProvider, openDocsProvider];
