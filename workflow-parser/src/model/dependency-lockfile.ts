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

export type ActionDependency = {
  nwo?: string;
  source?: string;
  owner?: string;
  repo?: string;
  path?: string;
  ref?: string;
  algorithm?: string;
  digest?: string;
  workflow?: string;
};

export type DependencyLockfileDependency = ActionDependency & {
  entry?: string;
};

export type DependencyLockfileWorkflow = {
  dependencies: DependencyLockfileDependency[];
};

export type DependencyLockfile = {
  version: string;
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

const dependencyLockfileVersion = "v1";

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

  const workflowsPair = findPair(root, "workflows");
  if (!workflowsPair?.value) {
    errors.push(createError(name, "dependency lockfile workflows are required", getRange(root, lineCounter)));
  } else if (isMap(workflowsPair.value)) {
    readWorkflows(name, workflowsPair.value, lineCounter, errors, result.workflows);
  } else {
    errors.push(createError(name, "Expected a mapping for 'workflows'", getRange(workflowsPair.value, lineCounter)));
  }

  return errors.length > 0 ? {errors} : {value: result, errors};
}

export function parseDependencyEntry(entry: string): DependencyPin | undefined {
  const atIdx = entry.indexOf("@");
  if (atIdx <= 0 || atIdx === entry.length - 1) {
    return undefined;
  }

  let repoPath = entry.substring(0, atIdx);
  const refHash = entry.substring(atIdx + 1);
  repoPath = repoPath.replace(/^github\.com\//, "");

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

  const algorithm = hashSpec.substring(0, dashIdx);
  const digest = hashSpec.substring(dashIdx + 1);
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

  return {
    nwo: `${owner}/${repo}`,
    owner,
    repo,
    path,
    ref,
    algorithm,
    digest
  };
}

function readWorkflows(
  name: string,
  workflows: YAMLMap.Parsed,
  lineCounter: LineCounter,
  errors: DependencyLockfileError[],
  result: Record<string, DependencyLockfileWorkflow>
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

    result[workflowPath] = readWorkflow(name, workflowPath, item.value, lineCounter, errors);
  }
}

function readWorkflow(
  name: string,
  workflowPath: string,
  workflow: YAMLMap.Parsed,
  lineCounter: LineCounter,
  errors: DependencyLockfileError[]
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

  const dependencies: DependencyLockfileDependency[] = [];
  const seen = new Map<string, DependencyPin>();
  for (const item of dependenciesPair.value.items) {
    const dependency = readDependency(name, workflowPath, item, lineCounter, errors);
    if (!dependency) {
      continue;
    }

    const pin = dependencyLockfileDependencyToPin(dependency);
    if (!pin) {
      errors.push(
        createError(
          name,
          `invalid dependency lock entry for workflow ${JSON.stringify(workflowPath)}`,
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
    dependencies.push({...dependency, workflow: workflowLockKey(workflowPath)});
  }

  return {dependencies};
}

function readDependency(
  name: string,
  workflowPath: string,
  item: ParsedNode | null,
  lineCounter: LineCounter,
  errors: DependencyLockfileError[]
): DependencyLockfileDependency | undefined {
  if (!isMap(item)) {
    errors.push(
      createError(
        name,
        `invalid dependency lock entry for workflow ${JSON.stringify(workflowPath)}`,
        getRange(item, lineCounter)
      )
    );
    return undefined;
  }

  const dependency: DependencyLockfileDependency = {};
  for (const pair of item.items) {
    const key = readKey(name, pair, "dependency key", lineCounter, errors);
    if (!key || !pair.value) {
      continue;
    }

    switch (key) {
      case "entry":
      case "nwo":
      case "source":
      case "owner":
      case "repo":
      case "path":
      case "ref":
      case "algorithm":
      case "digest":
        dependency[key] = readString(name, pair.value, key, lineCounter, errors);
        break;
    }
  }

  return dependency;
}

export function dependencyLockfileDependencyToPin(dependency: DependencyLockfileDependency): DependencyPin | undefined {
  if (dependency.entry) {
    return parseDependencyEntry(dependency.entry);
  }

  let owner = dependency.owner;
  let repo = dependency.repo;
  let path = dependency.path;
  const source = dependency.nwo || dependency.source;

  if ((!owner || !repo) && source) {
    const sourcePath = source.replace(/^github\.com\//, "");
    const parts = sourcePath.split("/");
    if (parts.length >= 2) {
      owner = parts[0];
      repo = parts[1];
      if (!path && parts.length > 2) {
        path = parts.slice(2).join("/");
      }
    }
  }

  const algorithm = dependency.algorithm?.toLowerCase();
  const digest = dependency.digest?.toLowerCase();
  if (!owner || !repo || !dependency.ref || !algorithm || !digest) {
    return undefined;
  }

  if (hasEmptyDependencyPathSegment(repo) || (path && hasEmptyDependencyPathSegment(path))) {
    return undefined;
  }

  if (!isValidDependencyDigest(algorithm, digest)) {
    return undefined;
  }

  return {
    nwo: `${owner}/${repo}`,
    owner,
    repo,
    path,
    ref: dependency.ref,
    algorithm,
    digest
  };
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

export function dependencyIndexKey(pin: DependencyPin): string {
  const path = pin.path ? `/${pin.path}` : "";
  return `${pin.owner}/${pin.repo}${path}@${pin.ref}`;
}

function workflowLockKey(workflowPath: string): string {
  const withoutRef = workflowPath.includes("@")
    ? workflowPath.substring(0, workflowPath.lastIndexOf("@"))
    : workflowPath;
  const parts = withoutRef.split("/");
  if (parts.length > 2 && parts[2] === ".github") {
    return parts.slice(2).join("/");
  }
  return withoutRef;
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
