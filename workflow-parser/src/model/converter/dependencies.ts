import {FeatureFlags} from "@actions/expressions/features";
import {TemplateContext} from "../../templates/template-context.js";
import {isSequence, isString} from "../../templates/tokens/type-guards.js";
import {TemplateToken} from "../../templates/tokens/template-token.js";

/**
 * Validates that a dependency entry matches the format:
 * OWNER/REPO[/PATH]@REF:ALGO-HEX
 *
 * Ported from Go parser (actions-workflow-parser).
 */
export function isValidDependencyEntry(s: string): boolean {
  // Split on "@" -- path is before, ref+hash is after
  const atIdx = s.indexOf("@");
  if (atIdx <= 0 || atIdx === s.length - 1) {
    return false;
  }
  const path = s.substring(0, atIdx);
  const refHash = s.substring(atIdx + 1);

  // Path must have at least owner/repo (two segments)
  const slashIdx = path.indexOf("/");
  if (slashIdx <= 0 || slashIdx === path.length - 1) {
    return false;
  }

  // After "@", expect "REF:ALGO-HEX"
  const colonIdx = refHash.lastIndexOf(":");
  if (colonIdx <= 0 || colonIdx === refHash.length - 1) {
    return false;
  }
  const hashSpec = refHash.substring(colonIdx + 1);

  // Hash spec must be "ALGO-HEX"
  const dashIdx = hashSpec.indexOf("-");
  if (dashIdx <= 0 || dashIdx === hashSpec.length - 1) {
    return false;
  }
  const hex = hashSpec.substring(dashIdx + 1);

  // Validate hex characters
  for (const c of hex) {
    if (!/[0-9a-fA-F]/.test(c)) {
      return false;
    }
  }

  return true;
}

/**
 * Converts and validates the `dependencies:` section of a workflow.
 * Returns the list of dependency strings, or undefined if disabled/invalid.
 */
export function convertDependencies(
  context: TemplateContext,
  token: TemplateToken,
  featureFlags?: FeatureFlags
): string[] | undefined {
  if (!featureFlags?.isEnabled("allowDependencies")) {
    context.error(
      token,
      new Error("The 'dependencies' key is experimental. Enable the 'allowDependencies' feature flag to use it.")
    );
    return undefined;
  }

  if (!isSequence(token)) {
    context.error(token, new Error("Expected a sequence for 'dependencies'"));
    return undefined;
  }

  const deps: string[] = [];
  for (const item of token) {
    if (!isString(item)) {
      context.error(item, new Error("Expected a string for dependency entry"));
      continue;
    }

    if (!isValidDependencyEntry(item.value)) {
      context.error(
        item,
        new Error(`Invalid dependency format '${item.value}'. Expected format: 'OWNER/REPO[/PATH]@REF:ALGO-HEX'`)
      );
      continue;
    }

    deps.push(item.value);
  }

  return deps;
}
