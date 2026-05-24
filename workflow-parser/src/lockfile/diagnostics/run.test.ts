import type {DependencyLockfile, DependencyLockfileWorkflow} from "../../model/dependency-lockfile.js";
import {dependencyLockfileVersion} from "../../model/dependency-lockfile.js";
import {DiagnosticCodes} from "./codes.js";
import type {ActionResolver, AncestryStatus, ReachabilityStatus, RefResult, ResolverContext} from "./resolver.js";
import {runDiagnostics} from "./run.js";
import type {WorkflowInput} from "./input.js";

const shaCheckoutV4 = "8e8c483db84b4bee98b60c0593521ed34d9990e8";
const shaCheckoutV3 = "11bd71901bbe5b1630ceea73d27597364c9af683";
const shaSetupGoV5 = "0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const shaImposter = "ffffffffffffffffffffffffffffffffffffffff";

function pinKey(owner: string, repo: string, ref: string, sha: string): string {
  return `${owner}/${repo}@${ref}:sha1-${sha}`;
}

function lockfile(workflows: Record<string, DependencyLockfileWorkflow>): DependencyLockfile {
  return {version: dependencyLockfileVersion, actions: {}, workflows};
}

class StubResolver implements ActionResolver {
  constructor(
    private refs: Record<string, RefResult> = {},
    private ancestry: Record<string, AncestryStatus> = {},
    private reach: Record<string, ReachabilityStatus> = {}
  ) {}
  async resolveRef(_ctx: ResolverContext, owner: string, repo: string, ref: string) {
    return this.refs[`${owner}/${repo}@${ref}`] ?? {status: "unknown" as const};
  }
  async checkAncestry(_ctx: ResolverContext, owner: string, repo: string, cand: string, head: string) {
    return this.ancestry[`${owner}/${repo}:${cand}:${head}`] ?? ("unknown" as const);
  }
  async checkReachability(_ctx: ResolverContext, owner: string, repo: string, sha: string, ref: string) {
    return this.reach[`${owner}/${repo}:${sha}:${ref}`] ?? ("unknown" as const);
  }
}

const ci = ".github/workflows/ci.yml";

describe("lockfile diagnostics engine", () => {
  it("flags not_pinned for a ref absent from the lockfile", async () => {
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: "v4"}]};
    const got = await runDiagnostics(lockfile({}), [wf]);
    expect(got).toHaveLength(1);
    expect(got[0]!.code).toBe(DiagnosticCodes.NotPinned);
    expect(got[0]!.severity).toBe("error");
  });

  it("flags sha_as_ref when the uses ref is a bare SHA", async () => {
    const lf = lockfile({[ci]: {dependencies: [pinKey("actions", "checkout", shaCheckoutV4, shaCheckoutV4)]}});
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: shaCheckoutV4}]};
    const got = await runDiagnostics(lf, [wf]);
    expect(got).toHaveLength(1);
    expect(got[0]!.code).toBe(DiagnosticCodes.ShaAsRef);
  });

  it("flags ref_changed + stale when uses ref differs from the lock entry", async () => {
    const lf = lockfile({[ci]: {dependencies: [pinKey("actions", "checkout", "v4", shaCheckoutV4)]}});
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: "v3"}]};
    const got = await runDiagnostics(lf, [wf]);
    const codes = got.map(f => f.code).sort();
    expect(codes).toEqual([DiagnosticCodes.RefChanged, DiagnosticCodes.Stale]);
    const refChanged = got.find(f => f.code === DiagnosticCodes.RefChanged)!;
    expect(refChanged.lockedSha).toBe(shaCheckoutV4);
  });

  it("flags stale entries the workflow no longer references", async () => {
    const lf = lockfile({[ci]: {dependencies: [pinKey("actions", "checkout", "v4", shaCheckoutV4)]}});
    const wf: WorkflowInput = {path: ci, uses: []};
    const got = await runDiagnostics(lf, [wf]);
    expect(got).toHaveLength(1);
    expect(got[0]!.code).toBe(DiagnosticCodes.Stale);
  });

  it("emits nothing for a fully pinned current workflow", async () => {
    const lf = lockfile({[ci]: {dependencies: [pinKey("actions", "checkout", "v4", shaCheckoutV4)]}});
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: "v4"}]};
    const resolver = new StubResolver(
      {"actions/checkout@v4": {status: "resolved", sha: shaCheckoutV4, refType: "tag"}},
      {},
      {[`actions/checkout:${shaCheckoutV4}:v4`]: "reachable"}
    );
    const got = await runDiagnostics(lf, [wf], {resolver});
    expect(got).toEqual([]);
  });

  it("flags ref_moved when upstream drifted but ancestry holds", async () => {
    const lf = lockfile({[ci]: {dependencies: [pinKey("actions", "checkout", "v4", shaCheckoutV3)]}});
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: "v4"}]};
    const resolver = new StubResolver(
      {"actions/checkout@v4": {status: "resolved", sha: shaCheckoutV4, refType: "tag"}},
      {[`actions/checkout:${shaCheckoutV3}:${shaCheckoutV4}`]: "confirmed"},
      {[`actions/checkout:${shaCheckoutV3}:v4`]: "reachable"}
    );
    const got = await runDiagnostics(lf, [wf], {resolver});
    expect(got).toHaveLength(1);
    expect(got[0]!.code).toBe(DiagnosticCodes.RefMoved);
    expect(got[0]!.lockedSha).toBe(shaCheckoutV3);
    expect(got[0]!.liveSha).toBe(shaCheckoutV4);
  });

  it("upgrades to lockfile_forgery when ancestry fails", async () => {
    const lf = lockfile({[ci]: {dependencies: [pinKey("actions", "checkout", "v4", shaImposter)]}});
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: "v4"}]};
    const resolver = new StubResolver(
      {"actions/checkout@v4": {status: "resolved", sha: shaCheckoutV4, refType: "tag"}},
      {[`actions/checkout:${shaImposter}:${shaCheckoutV4}`]: "not_ancestor"}
    );
    const got = await runDiagnostics(lf, [wf], {resolver});
    expect(got.map(f => f.code)).toContain(DiagnosticCodes.LockfileForgery);
    const forgery = got.find(f => f.code === DiagnosticCodes.LockfileForgery)!;
    expect(forgery.severity).toBe("error");
  });

  it("flags imposter_commit when locked SHA is unreachable and ancestry was inconclusive", async () => {
    const lf = lockfile({[ci]: {dependencies: [pinKey("actions", "checkout", "v4", shaImposter)]}});
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: "v4"}]};
    const resolver = new StubResolver(
      {"actions/checkout@v4": {status: "unknown"}},
      {},
      {[`actions/checkout:${shaImposter}:v4`]: "unreachable"}
    );
    const got = await runDiagnostics(lf, [wf], {resolver});
    expect(got).toHaveLength(1);
    expect(got[0]!.code).toBe(DiagnosticCodes.ImposterCommit);
  });

  it("flags misleading_sha when a SHA-shaped ref resolves to a different commit", async () => {
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: shaCheckoutV4}]};
    const resolver = new StubResolver({
      [`actions/checkout@${shaCheckoutV4}`]: {status: "resolved", sha: shaSetupGoV5}
    });
    const got = await runDiagnostics(lockfile({}), [wf], {resolver});
    expect(got.map(f => f.code)).toContain(DiagnosticCodes.MisleadingSha);
  });

  it("skips resolver-bound checks when no resolver is given", async () => {
    const lf = lockfile({[ci]: {dependencies: [pinKey("actions", "checkout", "v4", shaCheckoutV4)]}});
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: "v4"}]};
    const got = await runDiagnostics(lf, [wf]);
    expect(got).toEqual([]);
  });

  it("preserves workflow order in findings", async () => {
    const a = ".github/workflows/a.yml";
    const b = ".github/workflows/b.yml";
    const got = await runDiagnostics(lockfile({}), [
      {path: a, uses: [{owner: "actions", repo: "checkout", path: "", ref: "v4"}]},
      {path: b, uses: [{owner: "actions", repo: "setup-go", path: "", ref: "v5"}]}
    ]);
    expect(got).toHaveLength(2);
    expect(got[0]!.workflowPath).toBe(a);
    expect(got[1]!.workflowPath).toBe(b);
  });

  it("attaches a docUrl to every finding via the central enrichment pass", async () => {
    const wf: WorkflowInput = {path: ci, uses: [{owner: "actions", repo: "checkout", path: "", ref: "v4"}]};
    const got = await runDiagnostics(lockfile({}), [wf]);
    expect(got).toHaveLength(1);
    expect(got[0]!.docUrl).toMatch(/^https:\/\/docs\.github\.com\//);
  });
});
