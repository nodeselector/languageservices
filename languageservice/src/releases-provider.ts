import {URI} from "vscode-languageserver-types";

/**
 * Metadata describing a single release of a published action.
 */
export interface ReleaseInfo {
  tagName: string;
  immutable: boolean;
}

/**
 * Host-side hook that returns the releases published for the action.yml
 * (or action.yaml) being edited. The host is responsible for mapping the
 * document URI to the upstream owner/repo (e.g. via the local git
 * remote) and fetching the release list.
 *
 * Return semantics:
 *   - undefined: unknown — skip the diagnostic (e.g. no remote, API
 *     error, or document isn't under a recognized repository)
 *   - empty array: repository publishes zero releases — skip
 *   - non-empty array: emit a warning if any release is non-immutable
 */
export type ReleasesProvider = {
  getReleasesForAction(actionUri: URI): Promise<ReleaseInfo[] | undefined>;
};
