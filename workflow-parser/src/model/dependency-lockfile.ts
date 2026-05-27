import {LineCounter, isMap, isScalar, isSeq, parseDocument} from "yaml";
import type {Node, Pair, ParsedNode, Scalar, YAMLMap, YAMLSeq} from "yaml";
import {TokenRange} from "../templates/tokens/token-range.js";

export type DependencyPin = {
  nwo: string;
  owner: string;
  repo: string;
  path?: string;
  ref: string;
  algorithm: string;
  digest: string;
};

export type LockfileAction = {
  /** Discovered release/tag at the commit, if one exists. Optional. */
  tag?: string;
  /**
   * Branch containing the pinned commit. Writers MUST refuse to record an
   * Action without a branch — a commit not on any branch is an impostor /
   * fork-network signal. Absence in older lockfiles is tolerated for read
   * compatibility.
   */
  branch?: string;
  commit?: string;
  ownerId: number;
  repoId: number;
  /**
   * Source range of the action's map key in the lockfile YAML. Populated
   * by {@link parseDependencyLockfile} so coherence validators (e.g.
   * inner-ref-vs-key drift) can attach diagnostics to the entry.
   */
  keyRange?: TokenRange;
};

export type DependencyLockfileWorkflow = {
  dependencies: string[];
  /**
   * Source range of the workflow's path key in the lockfile YAML.
   * Populated by {@link parseDependencyLockfile} so cross-doc
   * coherence validators can attach diagnostics to the workflow entry.
   */
  keyRange?: TokenRange;
  /**
   * Source range of each dependency entry, parallel to
   * {@link DependencyLockfileWorkflow.dependencies}. Populated by
   * {@link parseDependencyLockfile} so coherence validators can attach
   * per-dep diagnostics (e.g. orphan deps).
   */
  dependencyRanges?: (TokenRange | undefined)[];
};

export type DependencyLockfile = {
  version: string;
  actions: Record<string, LockfileAction>;
  workflows: Record<string, DependencyLockfileWorkflow>;
};

export type DependencyLockfileError = {
  rawMessage: string;
  message: string;
  range?: TokenRange;
};

export type ParseDependencyLockfileResult = {
  value?: DependencyLockfile;
  errors: DependencyLockfileError[];
};

export const dependencyLockfileVersion = "v0.0.1";

export function parseDependencyLockfile(name: string, content: string): ParseDependencyLockfileResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(content, {
    lineCounter,
    keepSourceTokens: true,
    uniqueKeys: false
  });
  const errors: DependencyLockfileError[] = [];

  for (const err of doc.errors) {
    errors.push(createError(name, err.message, rangeFromLinePos(err.linePos)));
  }

  if (errors.length > 0) {
    return {errors};
  }

  const root = doc.contents;
  if (!isMap(root)) {
    return {errors: [createError(name, "Expected a mapping for dependency lockfile", getRange(root, lineCounter))]};
  }

  const result: DependencyLockfile = {
    version: "",
    actions: {},
    workflows: {}
  };

  const versionPair = findPair(root, "version");
  if (!versionPair?.value) {
    errors.push(createError(name, "dependency lockfile version is required", getRange(root, lineCounter)));
  } else {
    const version = readString(name, versionPair.value, "version", lineCounter, errors);
    if (version !== undefined) {
      result.version = version;
      if (version !== dependencyLockfileVersion) {
        errors.push(
          createError(
            name,
            `unsupported dependency lockfile version ${JSON.stringify(version)}`,
            getRange(versionPair.value, lineCounter)
          )
        );
      }
    }
  }

  const actionsPair = findPair(root, "actions");
  if (actionsPair?.value) {
    if (isMap(actionsPair.value)) {
      readActions(name, actionsPair.value, lineCounter, errors, result.actions);
    } else {
      errors.push(createError(name, "Expected a mapping for 'actions'", getRange(actionsPair.value, lineCounter)));
    }
  }

  const workflowsPair = findPair(root, "workflows");
  if (!workflowsPair?.value) {
    errors.push(createError(name, "dependency lockfile workflows are required", getRange(root, lineCounter)));
  } else if (isMap(workflowsPair.value)) {
    readWorkflows(name, workflowsPair.value, lineCounter, errors, result);
  } else {
    errors.push(createError(name, "Expected a mapping for 'workflows'", getRange(workflowsPair.value, lineCounter)));
  }

  return {value: result, errors};
}

/**
 * Parse a canonical pin string of the form OWNER/REPO[/PATH]@REF:ALGO-HEX.
 * No `github.com/` prefix is accepted. Owner, repo, algorithm and digest are
 * lowercased; ref and path preserve source casing.
 */
export function parsePin(entry: string): DependencyPin | undefined {
  const atIdx = entry.indexOf("@");
  if (atIdx <= 0 || atIdx === entry.length - 1) {
    return undefined;
  }

  const repoPath = entry.substring(0, atIdx);
  const refHash = entry.substring(atIdx + 1);

  const slashIdx = repoPath.indexOf("/");
  if (slashIdx <= 0 || slashIdx === repoPath.length - 1) {
    return undefined;
  }

  const owner = repoPath.substring(0, slashIdx);
  const repoAndPath = repoPath.substring(slashIdx + 1);
  if (hasEmptyDependencyPathSegment(repoAndPath)) {
    return undefined;
  }

  const colonIdx = refHash.lastIndexOf(":");
  if (colonIdx <= 0 || colonIdx === refHash.length - 1) {
    return undefined;
  }

  const ref = refHash.substring(0, colonIdx);
  if (ref.includes(":")) {
    return undefined;
  }

  const hashSpec = refHash.substring(colonIdx + 1);
  const dashIdx = hashSpec.indexOf("-");
  if (dashIdx <= 0 || dashIdx === hashSpec.length - 1) {
    return undefined;
  }

  const algorithm = hashSpec.substring(0, dashIdx).toLowerCase();
  const digest = hashSpec.substring(dashIdx + 1).toLowerCase();
  if (!isValidDependencyDigest(algorithm, digest)) {
    return undefined;
  }

  let repo = repoAndPath;
  let path: string | undefined;
  const pathIdx = repoAndPath.indexOf("/");
  if (pathIdx >= 0) {
    repo = repoAndPath.substring(0, pathIdx);
    path = repoAndPath.substring(pathIdx + 1);
  }

  const ownerLc = owner.toLowerCase();
  const repoLc = repo.toLowerCase();
  return {
    nwo: `${ownerLc}/${repoLc}`,
    owner: ownerLc,
    repo: repoLc,
    path,
    ref,
    algorithm,
    digest
  };
}

/** Stringifies a pin in canonical form: OWNER/REPO[/PATH]@REF:ALGO-HEX. */
export function pinString(pin: DependencyPin): string {
  const path = pin.path ? `/${pin.path}` : "";
  return `${pin.owner}/${pin.repo}${path}@${pin.ref}:${pin.algorithm}-${pin.digest}`;
}

/** Index key used for dedup / lookup: OWNER/REPO[/PATH]@REF (no algo/hex). */
export function dependencyIndexKey(pin: DependencyPin): string {
  const path = pin.path ? `/${pin.path}` : "";
  return `${pin.owner}/${pin.repo}${path}@${pin.ref}`;
}

function readActions(
  name: string,
  actions: YAMLMap.Parsed,
  lineCounter: LineCounter,
  errors: DependencyLockfileError[],
  result: Record<string, LockfileAction>
) {
  for (const item of actions.items) {
    const actionKey = readKey(name, item, "action key", lineCounter, errors);
    if (!actionKey || !item.value) {
      continue;
    }

    if (parsePin(actionKey) === undefined) {
      errors.push(
        createError(
          name,
          `invalid action key in lockfile: ${JSON.stringify(actionKey)}`,
          getRange(item.key, lineCounter)
        )
      );
      continue;
    }

    if (!isMap(item.value)) {
      errors.push(
        createError(
          name,
          `Expected a mapping for action ${JSON.stringify(actionKey)}`,
          getRange(item.value, lineCounter)
        )
      );
      continue;
    }

    const action: LockfileAction = {ownerId: 0, repoId: 0, keyRange: getRange(item.key, lineCounter)};
    for (const pair of item.value.items) {
      const key = readKey(name, pair, "action field", lineCounter, errors);
      if (!key || !pair.value) {
        continue;
      }

      switch (key) {
        case "tag":
          action.tag = readString(name, pair.value, key, lineCounter, errors);
          break;
        case "branch":
          action.branch = readString(name, pair.value, key, lineCounter, errors);
          break;
        case "commit":
          action.commit = readString(name, pair.value, key, lineCounter, errors);
          break;
        case "owner_id": {
          const v = readNumber(name, pair.value, key, lineCounter, errors);
          if (v !== undefined) action.ownerId = v;
          break;
        }
        case "repo_id": {
          const v = readNumber(name, pair.value, key, lineCounter, errors);
          if (v !== undefined) action.repoId = v;
          break;
        }
      }
    }

    result[actionKey] = action;
  }
}

function readWorkflows(
  name: string,
  workflows: YAMLMap.Parsed,
  lineCounter: LineCounter,
  errors: DependencyLockfileError[],
  result: DependencyLockfile
) {
  for (const item of workflows.items) {
    const workflowPath = readKey(name, item, "workflow path", lineCounter, errors);
    if (!workflowPath || !item.value) {
      continue;
    }

    if (!isMap(item.value)) {
      errors.push(
        createError(
          name,
          `Expected a mapping for workflow ${JSON.stringify(workflowPath)}`,
          getRange(item.value, lineCounter)
        )
      );
      continue;
    }

    result.workflows[workflowPath] = readWorkflow(name, workflowPath, item.value, lineCounter, errors, result.actions);
    const wf = result.workflows[workflowPath];
    wf.keyRange = getRange(item.key, lineCounter);
  }
}

function readWorkflow(
  name: string,
  workflowPath: string,
  workflow: YAMLMap.Parsed,
  lineCounter: LineCounter,
  errors: DependencyLockfileError[],
  actions: Record<string, LockfileAction>
): DependencyLockfileWorkflow {
  const dependenciesPair = findPair(workflow, "dependencies");
  if (!dependenciesPair?.value) {
    return {dependencies: []};
  }

  if (!isSeq(dependenciesPair.value)) {
    errors.push(
      createError(name, "Expected a sequence for 'dependencies'", getRange(dependenciesPair.value, lineCounter))
    );
    return {dependencies: []};
  }

  const dependencies: string[] = [];
  const dependencyRanges: (TokenRange | undefined)[] = [];
  const seen = new Map<string, DependencyPin>();
  for (const item of dependenciesPair.value.items) {
    if (!isScalar(item) || typeof item.value !== "string") {
      errors.push(
        createError(
          name,
          `invalid dependency entry for workflow ${JSON.stringify(workflowPath)}: expected a pin string`,
          getRange(item, lineCounter)
        )
      );
      continue;
    }

    const dep = item.value;
    const pin = parsePin(dep);
    if (!pin) {
      errors.push(
        createError(
          name,
          `invalid dependency lock entry for workflow ${JSON.stringify(workflowPath)}: ${JSON.stringify(dep)}`,
          getRange(item, lineCounter)
        )
      );
      continue;
    }

    const actionKey = pinString(pin);
    if (!(actionKey in actions)) {
      errors.push(
        createError(
          name,
          `workflow ${JSON.stringify(workflowPath)} references action ${JSON.stringify(
            actionKey
          )} not present in actions:`,
          getRange(item, lineCounter)
        )
      );
      continue;
    }

    const key = dependencyIndexKey(pin);
    const previous = seen.get(key);
    if (previous) {
      if (previous.algorithm !== pin.algorithm || previous.digest !== pin.digest) {
        errors.push(
          createError(
            name,
            `duplicate dependency key in lockfile with conflicting pin: ${JSON.stringify(key)}`,
            getRange(item, lineCounter)
          )
        );
      }
      continue;
    }

    seen.set(key, pin);
    dependencies.push(actionKey);
    dependencyRanges.push(getRange(item, lineCounter));
  }

  return {dependencies, dependencyRanges};
}

function findPair(map: YAMLMap.Parsed, key: string): Pair<ParsedNode, ParsedNode | null> | undefined {
  return map.items.find(item => isScalar(item.key) && item.key.value === key);
}

function readKey(
  name: string,
  pair: Pair<ParsedNode, ParsedNode | null>,
  label: string,
  lineCounter: LineCounter,
  errors: DependencyLockfileError[]
): string | undefined {
  return readString(name, pair.key, label, lineCounter, errors);
}

function readString(
  name: string,
  node: ParsedNode,
  label: string,
  lineCounter: LineCounter,
  errors: DependencyLockfileError[]
): string | undefined {
  if (isScalar(node) && typeof node.value === "string") {
    return node.value;
  }

  errors.push(createError(name, `Expected a string for '${label}'`, getRange(node, lineCounter)));
  return undefined;
}

function readNumber(
  name: string,
  node: ParsedNode,
  label: string,
  lineCounter: LineCounter,
  errors: DependencyLockfileError[]
): number | undefined {
  if (isScalar(node) && typeof node.value === "number" && Number.isFinite(node.value)) {
    return node.value;
  }

  errors.push(createError(name, `Expected a number for '${label}'`, getRange(node, lineCounter)));
  return undefined;
}

function hasEmptyDependencyPathSegment(repoAndPath: string): boolean {
  return repoAndPath.startsWith("/") || repoAndPath.endsWith("/") || repoAndPath.includes("//");
}

function isValidDependencyDigest(algorithm: string, digest: string): boolean {
  const expectedLength = dependencyDigestLength(algorithm);
  return expectedLength !== undefined && digest.length === expectedLength && /^[0-9a-fA-F]+$/.test(digest);
}

function dependencyDigestLength(algorithm: string): number | undefined {
  switch (algorithm) {
    case "sha1":
      return 40;
    case "sha256":
      return 64;
  }

  return undefined;
}

function createError(name: string, rawMessage: string, range?: TokenRange): DependencyLockfileError {
  return {
    rawMessage,
    message: errorMessage(name, rawMessage, range),
    range
  };
}

function errorMessage(name: string, rawMessage: string, range?: TokenRange): string {
  if (range) {
    return `${name} (Line: ${range.start.line}, Col: ${range.start.column}): ${rawMessage}`;
  }

  return `${name}: ${rawMessage}`;
}

function getRange(
  node: Node | Scalar | YAMLMap | YAMLSeq | ParsedNode | null | undefined,
  lineCounter: LineCounter
): TokenRange | undefined {
  const range = node?.range ?? [];
  const startPos = range[0];
  const endPos = range[1];

  if (startPos !== undefined && endPos !== undefined) {
    const start = lineCounter.linePos(startPos);
    const end = lineCounter.linePos(endPos);
    return {
      start: {line: start.line, column: start.col},
      end: {line: end.line, column: end.col}
    };
  }

  return undefined;
}

function rangeFromLinePos(
  linePos: [{line: number; col: number}] | [{line: number; col: number}, {line: number; col: number}] | undefined
): TokenRange | undefined {
  if (!linePos) {
    return undefined;
  }

  return {
    start: {line: linePos[0].line, column: linePos[0].col},
    end:
      linePos.length === 2
        ? {line: linePos[1].line, column: linePos[1].col}
        : {line: linePos[0].line, column: linePos[0].col}
  };
}
