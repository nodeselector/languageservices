import {parsePin, parseDependencyLockfile, pinString} from "./dependency-lockfile.js";

describe("parsePin", () => {
  it("parses canonical pin strings", () => {
    expect(parsePin("actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683")).toEqual({
      nwo: "actions/checkout",
      owner: "actions",
      repo: "checkout",
      path: undefined,
      ref: "v4",
      algorithm: "sha1",
      digest: "11bd71901bbe5b1630ceea73d27597364c9af683"
    });
  });

  it("lowercases owner, repo, algorithm, digest but preserves ref/path casing", () => {
    expect(parsePin("Actions/Checkout/Sub-Action@Main:SHA1-11BD71901BBE5B1630CEEA73D27597364C9AF683")).toEqual({
      nwo: "actions/checkout",
      owner: "actions",
      repo: "checkout",
      path: "Sub-Action",
      ref: "Main",
      algorithm: "sha1",
      digest: "11bd71901bbe5b1630ceea73d27597364c9af683"
    });
  });

  it("rejects digest lengths that do not match the algorithm", () => {
    expect(parsePin("actions/checkout@v4:sha1-abc123")).toBeUndefined();
  });
});

describe("pinString", () => {
  it("round-trips canonical pin strings", () => {
    const pin = parsePin("actions/checkout/sub@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683")!;
    expect(pinString(pin)).toBe("actions/checkout/sub@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683");
  });
});

describe("parseDependencyLockfile", () => {
  const validLockfile = `version: v0.0.1
actions:
  actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683:
    ref: v4
    sha: sha1-11bd71901bbe5b1630ceea73d27597364c9af683
    owner_id: 1
    repo_id: 2
  actions/setup-go@v5:sha1-d35c59abb061a4a6fb18e82ac0862c26744d6ab5:
    ref: v5
    sha: sha1-d35c59abb061a4a6fb18e82ac0862c26744d6ab5
    owner_id: 1
    repo_id: 3
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683
      - actions/setup-go@v5:sha1-d35c59abb061a4a6fb18e82ac0862c26744d6ab5
`;

  it("parses standalone lockfile with actions map and string dependencies", () => {
    const result = parseDependencyLockfile(".github/workflows/actions.lock", validLockfile);

    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({
      version: "v0.0.1",
      actions: {
        "actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683": {
          ref: "v4",
          sha: "sha1-11bd71901bbe5b1630ceea73d27597364c9af683",
          ownerId: 1,
          repoId: 2,
          keyRange: expect.any(Object)
        },
        "actions/setup-go@v5:sha1-d35c59abb061a4a6fb18e82ac0862c26744d6ab5": {
          ref: "v5",
          sha: "sha1-d35c59abb061a4a6fb18e82ac0862c26744d6ab5",
          ownerId: 1,
          repoId: 3,
          keyRange: expect.any(Object)
        }
      },
      workflows: {
        ".github/workflows/ci.yml": {
          dependencies: [
            "actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683",
            "actions/setup-go@v5:sha1-d35c59abb061a4a6fb18e82ac0862c26744d6ab5"
          ]
        }
      }
    });
  });

  it("reports missing and unsupported versions", () => {
    expect(
      parseDependencyLockfile(
        ".github/workflows/actions.lock",
        `workflows:
  .github/workflows/ci.yml:
    dependencies: []
`
      ).errors[0].rawMessage
    ).toBe("dependency lockfile version is required");

    expect(
      parseDependencyLockfile(
        ".github/workflows/actions.lock",
        `version: v1
workflows:
  .github/workflows/ci.yml:
    dependencies: []
`
      ).errors[0].rawMessage
    ).toBe('unsupported dependency lockfile version "v1"');
  });

  it("reports dependency entries not present in actions map", () => {
    const result = parseDependencyLockfile(
      ".github/workflows/actions.lock",
      `version: v0.0.1
actions: {}
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683
`
    );

    expect(result.value).toBeUndefined();
    expect(result.errors[0].rawMessage).toBe(
      'workflow ".github/workflows/ci.yml" references action "actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683" not present in actions:'
    );
  });

  it("reports invalid pin strings in dependencies", () => {
    const result = parseDependencyLockfile(
      ".github/workflows/actions.lock",
      `version: v0.0.1
actions: {}
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - actions/checkout@v4:sha1-abc123
`
    );

    expect(result.value).toBeUndefined();
    expect(result.errors[0].rawMessage).toBe(
      'invalid dependency lock entry for workflow ".github/workflows/ci.yml": "actions/checkout@v4:sha1-abc123"'
    );
  });

  it("reports conflicting duplicate dependency pins", () => {
    const result = parseDependencyLockfile(
      ".github/workflows/actions.lock",
      `version: v0.0.1
actions:
  actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683:
    ref: v4
    sha: sha1-11bd71901bbe5b1630ceea73d27597364c9af683
    owner_id: 1
    repo_id: 2
  actions/checkout@v4:sha1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:
    ref: v4
    sha: sha1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    owner_id: 1
    repo_id: 2
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683
      - actions/checkout@v4:sha1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`
    );

    expect(result.value).toBeUndefined();
    expect(result.errors[0].rawMessage).toBe(
      'duplicate dependency key in lockfile with conflicting pin: "actions/checkout@v4"'
    );
  });
});
