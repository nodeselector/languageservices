import {FeatureFlags} from "@actions/expressions";
import {createDocument} from "./test-utils/document.js";
import {validate, ValidationConfig} from "./validate.js";

const config = {
  featureFlags: new FeatureFlags({allowDependencies: true})
};

describe("validate dependency lockfile", () => {
  it("validates .github/actions.lock.yml as a standalone lockfile", async () => {
    const result = await validate(
      createDocument(
        ".github/actions.lock.yml",
        `version: v0.0.1
actions:
  actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683:
    ref: v4
    sha: sha1-11bd71901bbe5b1630ceea73d27597364c9af683
    owner_id: 1
    repo_id: 2
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683
`
      ),
      config
    );

    expect(result).toEqual([]);
  });

  it("reports standalone lockfile errors", async () => {
    const result = await validate(
      createDocument(
        ".github/actions.lock.yml",
        `version: v2
actions: {}
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - actions/checkout@v4:sha1-abc123
`
      ),
      config
    );

    expect(result.map(diagnostic => diagnostic.message)).toEqual([
      'unsupported dependency lockfile version "v2"',
      'invalid dependency lock entry for workflow ".github/workflows/ci.yml": "actions/checkout@v4:sha1-abc123"'
    ]);
  });

  it("does not validate standalone lockfiles unless dependency validation is enabled", async () => {
    const result = await validate(
      createDocument(
        ".github/actions.lock.yml",
        `version: v2
workflows: nope
`
      )
    );

    expect(result).toEqual([]);
  });

  it("does not report workflow uses references that are present in the lockfile", async () => {
    const result = await validate(workflowDocument(), workflowConfig(lockfileContent()));

    expect(result).toEqual([]);
  });

  it("reports workflow uses references that are missing from the lockfile", async () => {
    const result = await validate(
      workflowDocument(),
      workflowConfig(`version: v0.0.1
actions: {}
workflows:
  .github/workflows/ci.yml:
    dependencies: []
`)
    );

    expect(result.map(diagnostic => diagnostic.message)).toEqual([
      "Action reference 'actions/checkout@v4' is not present in .github/actions.lock.yml"
    ]);
  });

  it("reports workflow uses references whose ref is not present in the lockfile", async () => {
    const result = await validate(
      workflowDocument(),
      workflowConfig(`version: v0.0.1
actions:
  actions/checkout@v3:sha1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:
    ref: v3
    sha: sha1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    owner_id: 1
    repo_id: 2
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - actions/checkout@v3:sha1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`)
    );

    expect(result.map(diagnostic => diagnostic.message)).toEqual([
      "Action reference 'actions/checkout@v4' is not present in .github/actions.lock.yml"
    ]);
  });

  it("ignores local and Docker uses references", async () => {
    const result = await validate(
      createDocument(
        ".github/workflows/local.yml",
        `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ./local-action
      - uses: docker://alpine:3.20
`
      ),
      workflowConfig(`version: v0.0.1
actions: {}
workflows:
  .github/workflows/local.yml:
    dependencies: []
`)
    );

    expect(result).toEqual([]);
  });
});

function workflowDocument() {
  return createDocument(
    ".github/workflows/ci.yml",
    `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
  );
}

function workflowConfig(lockfileContent: string | undefined): ValidationConfig {
  return {
    featureFlags: new FeatureFlags({allowDependencies: true}),
    dependencyLockfileProvider: {
      // eslint-disable-next-line @typescript-eslint/require-await
      getDependencyLockfile: async () => {
        if (!lockfileContent) {
          return undefined;
        }

        return {
          name: ".github/actions.lock.yml",
          content: lockfileContent
        };
      }
    }
  };
}

function lockfileContent() {
  return `version: v0.0.1
actions:
  actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683:
    ref: v4
    sha: sha1-11bd71901bbe5b1630ceea73d27597364c9af683
    owner_id: 1
    repo_id: 2
workflows:
  .github/workflows/ci.yml:
    dependencies:
      - actions/checkout@v4:sha1-11bd71901bbe5b1630ceea73d27597364c9af683
`;
}
