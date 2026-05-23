/**
 * Resolver interfaces — the seam through which the engine asks "is this
 * pin still current?" / "is this commit an ancestor?" / "is this commit
 * reachable?". Implementations should fail open: return *Unknown for any
 * transport failure, rate-limit, or missing auth. The engine has no error
 * path; "unknown" means "skip this validator for this entry".
 */

export type RefStatus = "unknown" | "resolved" | "not_found";

export type RefResult = {
  status: RefStatus;
  /** populated when status === "resolved" */
  sha?: string;
  /** optional hint: "tag" | "branch" | "commit" */
  refType?: string;
};

export type AncestryStatus = "unknown" | "confirmed" | "not_ancestor";

export type ReachabilityStatus = "unknown" | "reachable" | "unreachable";

export type ResolverContext = {
  /** AbortSignal so hosts can apply timeouts / cancellation. */
  signal?: AbortSignal;
};

export interface ActionResolver {
  resolveRef(ctx: ResolverContext, owner: string, repo: string, ref: string): Promise<RefResult>;
  checkAncestry(
    ctx: ResolverContext,
    owner: string,
    repo: string,
    candidateSha: string,
    headSha: string
  ): Promise<AncestryStatus>;
  checkReachability(
    ctx: ResolverContext,
    owner: string,
    repo: string,
    sha: string,
    ref: string
  ): Promise<ReachabilityStatus>;
}

/**
 * Fetches action.yml (or action.yaml) contents for the transitive
 * validator. Return undefined for "no action file at this path"; throw
 * for transport failures (engine treats those as unknown and skips).
 */
export interface ActionFileProvider {
  getActionFile(
    ctx: ResolverContext,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<Uint8Array | undefined>;
}
