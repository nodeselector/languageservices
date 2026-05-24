import {FeatureFlags} from "@actions/expressions";
import {Diagnostic, DiagnosticSeverity, Range} from "vscode-languageserver-types";
import {getCodeActions} from "../code-actions.js";
import type {LockfileDiagnosticData} from "../../lockfile-diagnostic-data.js";
import {REPIN_COMMAND} from "./lockfile-quickfix.js";

const range: Range = {start: {line: 5, character: 8}, end: {line: 5, character: 24}};

function flags(): FeatureFlags {
  return new FeatureFlags({allowDependencies: true});
}

function diag(code: string, extra: Partial<LockfileDiagnosticData> = {}): Diagnostic {
  const data: LockfileDiagnosticData = {
    kind: "lockfile",
    code: code as LockfileDiagnosticData["code"],
    owner: "actions",
    repo: "checkout",
    path: "",
    ref: "v4",
    workflowPath: ".github/workflows/ci.yml",
    docUrl: "https://docs.github.com/security-hardening",
    releaseUrl: "https://github.com/actions/checkout/releases/tag/v4",
    ...extra
  };
  return {
    range,
    severity: DiagnosticSeverity.Warning,
    code,
    source: "github-actions",
    message: "test",
    data
  };
}

function actions(diagnostic: Diagnostic, featureFlags: FeatureFlags = flags()) {
  return getCodeActions({
    uri: "file:///repo/.github/workflows/ci.yml",
    documentContent: "",
    diagnostics: [diagnostic],
    featureFlags
  });
}

describe("lockfile quick-fix providers", () => {
  it("returns no actions when the allowDependencies flag is off", () => {
    const result = actions(diag("not_pinned"), new FeatureFlags({}));
    expect(result).toEqual([]);
  });

  it("ignores diagnostics without lockfile data", () => {
    const d = diag("not_pinned");
    delete d.data;
    expect(actions(d)).toEqual([]);
  });

  it("offers Repin + View releases + Open docs for not_pinned", () => {
    const result = actions(diag("not_pinned"));
    const titles = result.map(a => a.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Repin actions\/checkout@v4/),
        "View releases for actions/checkout",
        "Open documentation for this finding"
      ])
    );
    const repin = result.find(a => a.title.startsWith("Repin"))!;
    expect(repin.command?.command).toBe(REPIN_COMMAND);
    expect(repin.isPreferred).toBe(true);
    expect(repin.command?.arguments?.[0]).toMatchObject({
      workflowPath: ".github/workflows/ci.yml",
      owner: "actions",
      repo: "checkout",
      ref: "v4"
    });
  });

  it("offers Repin for ref_changed / ref_moved / stale / transitive_unlocked", () => {
    for (const code of ["ref_changed", "ref_moved", "stale", "transitive_unlocked"]) {
      const titles = actions(diag(code)).map(a => a.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringMatching(/^Repin /)]));
    }
  });

  it("skips Repin for sha_as_ref but offers View releases", () => {
    const result = actions(diag("sha_as_ref"));
    const titles = result.map(a => a.title);
    expect(titles).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Repin /)]));
    expect(titles).toEqual(expect.arrayContaining(["View releases for actions/checkout"]));
  });

  it("skips Repin for investigation-only codes", () => {
    for (const code of ["misleading_sha", "lockfile_forgery", "imposter_commit"]) {
      const titles = actions(diag(code)).map(a => a.title);
      expect(titles).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Repin /)]));
      expect(titles).toEqual(expect.arrayContaining(["Open documentation for this finding"]));
    }
  });

  it("omits the docs action when docUrl is missing", () => {
    const result = actions(diag("not_pinned", {docUrl: undefined}));
    expect(result.map(a => a.title)).not.toEqual(expect.arrayContaining(["Open documentation for this finding"]));
  });

  it("View releases action wraps the releaseUrl in vscode.open", () => {
    const result = actions(diag("not_pinned"));
    const view = result.find(a => a.title.startsWith("View releases"))!;
    expect(view.command?.command).toBe("vscode.open");
    expect(view.command?.arguments).toEqual(["https://github.com/actions/checkout/releases/tag/v4"]);
  });

  it("includes the action path in the Repin title for monorepo actions", () => {
    const result = actions(diag("not_pinned", {path: "sub/action"}));
    const repin = result.find(a => a.title.startsWith("Repin"))!;
    expect(repin.title).toContain("actions/checkout/sub/action@v4");
  });
});
