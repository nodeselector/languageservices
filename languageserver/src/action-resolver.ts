import {lockfileDiagnostics} from "@actions/workflow-parser";
import {Octokit} from "@octokit/rest";
import {TTLCache} from "./utils/cache.js";

/**
 * OctokitActionResolver answers the lockfile diagnostics engine's three
 * questions against github.com (or a GHES API URL) using the user's
 * configured Octokit client.
 *
 * Failure mode is "fail open": any non-2xx, network error, or unexpected
 * shape returns the *Unknown variant. The engine treats Unknown as "do
 * not emit a finding", so the worst case is a missed diagnostic — never a
 * false positive.
 */
export class OctokitActionResolver implements lockfileDiagnostics.ActionResolver {
  constructor(
    private readonly client: Octokit,
    private readonly cache: TTLCache = new TTLCache()
  ) {}

  async resolveRef(_ctx: unknown, owner: string, repo: string, ref: string): Promise<lockfileDiagnostics.RefResult> {
    const key = `resolveRef:${owner}/${repo}@${ref}`;
    return await this.cache.get(key, undefined, async () => {
      const tag = await this.fetchRef(owner, repo, `tags/${ref}`);
      if (tag) return tag;
      const head = await this.fetchRef(owner, repo, `heads/${ref}`);
      if (head) return head;
      return {status: "unknown"};
    });
  }

  async checkAncestry(
    _ctx: unknown,
    owner: string,
    repo: string,
    candidateSha: string,
    headSha: string
  ): Promise<lockfileDiagnostics.AncestryStatus> {
    const key = `ancestry:${owner}/${repo}:${candidateSha}...${headSha}`;
    return await this.cache.get(key, undefined, async () => {
      const status = await this.fetchCompareStatus(owner, repo, candidateSha, headSha);
      if (status === undefined) return "unknown";
      // candidate...head: "behind" means candidate is behind head (i.e. ancestor),
      // "identical" means same commit; both confirm ancestry.
      if (status === "behind" || status === "identical") return "confirmed";
      return "not_ancestor";
    });
  }

  async checkReachability(
    _ctx: unknown,
    owner: string,
    repo: string,
    sha: string,
    ref: string
  ): Promise<lockfileDiagnostics.ReachabilityStatus> {
    const key = `reachability:${owner}/${repo}:${sha}@${ref}`;
    return await this.cache.get(key, undefined, async () => {
      const status = await this.fetchCompareStatus(owner, repo, sha, ref);
      if (status === undefined) return "unknown";
      if (status === "behind" || status === "identical") return "reachable";
      return "unreachable";
    });
  }

  private async fetchRef(owner: string, repo: string, ref: string): Promise<lockfileDiagnostics.RefResult | undefined> {
    try {
      const res = await this.client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {owner, repo, ref});
      const obj = (res.data as {object?: {sha?: string; type?: string}}).object;
      if (!obj?.sha) return undefined;
      const refType = obj.type === "tag" ? "tag" : ref.startsWith("tags/") ? "tag" : "branch";
      return {status: "resolved", sha: obj.sha, refType};
    } catch {
      return undefined;
    }
  }

  private async fetchCompareStatus(
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<"ahead" | "behind" | "diverged" | "identical" | undefined> {
    try {
      const res = await this.client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner,
        repo,
        basehead: `${base}...${head}`
      });
      const status = (res.data as {status?: string}).status;
      if (status === "ahead" || status === "behind" || status === "diverged" || status === "identical") {
        return status;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
