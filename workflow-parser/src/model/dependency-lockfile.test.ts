import {parseDependencyEntry, parseDependencyLockfile} from "./dependency-lockfile.js";

describe("parseDependencyEntry", () => {
  it("parses strict dependency entries", () => {
    expect(
      parseDependencyEntry("github.com/actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683")
    ).toEqual({
      nwo: "actions/checkout",
      owner: "actions",
      repo: "checkout",
      path: undefined,
      ref: "v4",
      algorithm: "sha1",
      digest: "11bd71901bbe5b1630ceea73d27597364c9af683"
    });
  });

  it("rejects digest lengths that do not match the algorithm", () => {
    expect(parseDependencyEntry("actions/checkout@v4:sha1-abc123")).toBeUndefined();
  });
});

describe("parseDependencyLockfile", () => {
  it("parses structured standalone lockfile dependencies", () => {
    const result = parseDependencyLockfile(
      ".github/actions.lock.yml",
      `version: v1
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - owner: actions
        repo: checkout
        ref: v4
        algorithm: sha1
        digest: 11bd71901bbe5b1630ceea73d27597364c9af683
      - nwo: actions/setup-go
        ref: v5
        algorithm: sha1
        digest: d35c59abb061a4a6fb18e82ac0862c26744d6ab5
`
    );

    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({
      version: "v1",
      workflows: {
        ".github/workflows/ci.yml": {
          dependencies: [
            {
              owner: "actions",
              repo: "checkout",
              ref: "v4",
              algorithm: "sha1",
              digest: "11bd71901bbe5b1630ceea73d27597364c9af683",
              workflow: ".github/workflows/ci.yml"
            },
            {
              nwo: "actions/setup-go",
              ref: "v5",
              algorithm: "sha1",
              digest: "d35c59abb061a4a6fb18e82ac0862c26744d6ab5",
              workflow: ".github/workflows/ci.yml"
            }
          ]
        }
      }
    });
  });

  it("parses entry-form standalone lockfile dependencies", () => {
    const result = parseDependencyLockfile(
      ".github/actions.lock.yml",
      `version: v1
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - entry: github.com/actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683
`
    );

    expect(result.errors).toEqual([]);
    expect(result.value?.workflows[".github/workflows/ci.yml"].dependencies).toEqual([
      {
        entry: "github.com/actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683",
        workflow: ".github/workflows/ci.yml"
      }
    ]);
  });

  it("reports missing and unsupported versions", () => {
    expect(
      parseDependencyLockfile(
        ".github/actions.lock.yml",
        `workflows:
  .github/workflows/ci.yml:
    dependencies: []
`
      ).errors[0].rawMessage
    ).toBe("dependency lockfile version is required");

    expect(
      parseDependencyLockfile(
        ".github/actions.lock.yml",
        `version: v2
workflows:
  .github/workflows/ci.yml:
    dependencies: []
`
      ).errors[0].rawMessage
    ).toBe('unsupported dependency lockfile version "v2"');
  });

  it("reports invalid structured dependencies", () => {
    const result = parseDependencyLockfile(
      ".github/actions.lock.yml",
      `version: v1
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - owner: actions
        repo: checkout
        ref: v4
        algorithm: sha1
        digest: abc123
`
    );

    expect(result.value).toBeUndefined();
    expect(result.errors[0].rawMessage).toBe('invalid dependency lock entry for workflow ".github/workflows/ci.yml"');
  });

  it("reports conflicting duplicate dependency pins", () => {
    const result = parseDependencyLockfile(
      ".github/actions.lock.yml",
      `version: v1
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - owner: actions
        repo: checkout
        ref: v4
        algorithm: sha1
        digest: 11bd71901bbe5b1630ceea73d27597364c9af683
      - owner: actions
        repo: checkout
        ref: v4
        algorithm: sha1
        digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`
    );

    expect(result.value).toBeUndefined();
    expect(result.errors[0].rawMessage).toBe(
      'duplicate dependency key in lockfile with conflicting pin: "actions/checkout@v4"'
    );
  });
});
