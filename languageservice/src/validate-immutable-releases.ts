import {isMapping, isString} from "@actions/workflow-parser";
import {MappingToken} from "@actions/workflow-parser/templates/tokens/mapping-token";
import {TemplateToken} from "@actions/workflow-parser/templates/tokens/template-token";
import {TextDocument} from "vscode-languageserver-textdocument";
import {Diagnostic, DiagnosticSeverity, Range} from "vscode-languageserver-types";
import {ReleaseInfo, ReleasesProvider} from "./releases-provider.js";
import {mapRange} from "./utils/range.js";

/**
 * Documentation URL for non-immutable release warnings.
 *
 * Kept in sync with the CLI's value in
 * `gh-actions-pin/internal/doctor/doc_urls.go` and (eventually) the
 * lockfile diagnostics table — both surfaces deep-link the same docs
 * page so users see one consistent story.
 */
const IMMUTABLE_RELEASES_DOC_URL =
  "https://docs.github.com/en/actions/sharing-automations/creating-actions/about-immutable-releases-for-actions";

/** Diagnostic code emitted when an action's repo publishes mutable releases. */
export const NON_IMMUTABLE_RELEASES_CODE = "non-immutable-releases";

/**
 * Warn when the action.yml being edited is published from a repo whose
 * releases aren't marked immutable. Encourages maintainers to enable
 * immutable releases so consumers can pin to verifiable tags.
 *
 * Silent (no diagnostic) when:
 *   - no provider is configured
 *   - provider returns undefined (unknown / API error / no remote)
 *   - the repo has zero published releases
 *   - every published release is immutable
 */
export async function validateImmutableReleases(
  diagnostics: Diagnostic[],
  textDocument: TextDocument,
  root: TemplateToken,
  releasesProvider?: ReleasesProvider
): Promise<void> {
  if (!releasesProvider) return;

  const releases = await releasesProvider.getReleasesForAction(textDocument.uri);
  if (!releases || releases.length === 0) return;

  const mutable = releases.filter(r => !r.immutable);
  if (mutable.length === 0) return;

  diagnostics.push({
    message: buildMessage(mutable, releases.length),
    range: findNameRange(root) ?? firstLineRange(textDocument),
    severity: DiagnosticSeverity.Warning,
    source: "github-actions",
    code: NON_IMMUTABLE_RELEASES_CODE,
    codeDescription: {href: IMMUTABLE_RELEASES_DOC_URL}
  });
}

function buildMessage(mutable: ReleaseInfo[], total: number): string {
  const preview = mutable.slice(0, 5).map(r => r.tagName);
  const examples = preview.length ? ` (e.g. ${preview.join(", ")})` : "";
  return (
    `This action publishes ${mutable.length} of ${total} release(s) without immutable tags${examples}. ` +
    `Enable immutable releases so consumers can pin to verifiable tags.`
  );
}

/** Locate the `name:` value token in the root mapping so the diagnostic
 *  anchors on a stable, visible piece of the document. */
function findNameRange(root: TemplateToken): Range | undefined {
  if (!isMapping(root)) return undefined;
  const mapping = root as MappingToken;
  for (let i = 0; i < mapping.count; i++) {
    const {key, value} = mapping.get(i);
    if (isString(key) && key.value.toLowerCase() === "name" && value.range) {
      return mapRange(value.range);
    }
  }
  return undefined;
}

function firstLineRange(textDocument: TextDocument): Range {
  const text = textDocument.getText();
  const lineEnd = text.indexOf("\n");
  const end = lineEnd === -1 ? text.length : lineEnd;
  return {
    start: textDocument.positionAt(0),
    end: textDocument.positionAt(end)
  };
}
