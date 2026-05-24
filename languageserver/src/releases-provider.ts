import {ReleaseInfo, ReleasesProvider} from "@actions/languageservice/releases-provider";
import {Octokit} from "@octokit/rest";
import {RepositoryContext} from "./initializationOptions.js";
import {TTLCache} from "./utils/cache.js";

/**
 * OctokitReleasesProvider answers "what releases has this action's repo
 * published, and are any of them non-immutable?" for the language
 * service's `validateImmutableReleases` check.
 *
 * Owner/repo are resolved from the document URI by matching the longest
 * `RepositoryContext.workspaceUri` prefix the host registered at init.
 * If the URI isn't under any known repo we return undefined and the
 * diagnostic is skipped.
 *
 * Fails open: any network / API error also returns undefined so the
 * worst case is a missed warning, never a false positive.
 */
export class OctokitReleasesProvider implements ReleasesProvider {
  constructor(
    private readonly client: Octokit,
    private readonly repos: RepositoryContext[],
    private readonly cache: TTLCache = new TTLCache()
  ) {}

  async getReleasesForAction(actionUri: string): Promise<ReleaseInfo[] | undefined> {
    const repo = this.repoFor(actionUri);
    if (!repo) return undefined;
    const key = `releases:${repo.owner}/${repo.name}`;
    return await this.cache.get(key, undefined, async () => {
      try {
        const res = await this.client.request("GET /repos/{owner}/{repo}/releases", {
          owner: repo.owner,
          repo: repo.name,
          per_page: 30
        });
        const data = res.data as Array<{tag_name?: string; immutable?: boolean}>;
        return data
          .filter(r => typeof r.tag_name === "string")
          .map(r => ({tagName: r.tag_name as string, immutable: r.immutable === true}));
      } catch {
        return undefined;
      }
    });
  }

  private repoFor(uri: string): RepositoryContext | undefined {
    let best: RepositoryContext | undefined;
    for (const repo of this.repos) {
      if (uri.startsWith(repo.workspaceUri) && (!best || repo.workspaceUri.length > best.workspaceUri.length)) {
        best = repo;
      }
    }
    return best;
  }
}
