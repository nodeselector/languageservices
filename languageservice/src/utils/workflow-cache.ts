import {convertWorkflowTemplate, parseWorkflow, TemplateParseResult, WorkflowTemplate} from "@actions/workflow-parser";
import {parseAction} from "@actions/workflow-parser/actions/action-parser";
import {
  ActionTemplate,
  ActionTemplateConverterOptions,
  convertActionTemplate
} from "@actions/workflow-parser/actions/action-template";
import {WorkflowTemplateConverterOptions} from "@actions/workflow-parser/model/convert";
import {TemplateContext} from "@actions/workflow-parser/templates/template-context";
import {TemplateToken} from "@actions/workflow-parser/templates/tokens/template-token";
import {File} from "@actions/workflow-parser/workflows/file";

import {CompletionConfig} from "../complete.js";
import {nullTrace} from "../nulltrace.js";

const parsedWorkflowCache = new Map<string, TemplateParseResult>();
const parsedActionCache = new Map<string, TemplateParseResult>();
const workflowTemplateCache = new Map<string, WorkflowTemplate>();
const actionTemplateCache = new Map<string, ActionTemplate>();

export function clearCacheEntry(uri: string) {
  const baseKey = cacheKey(uri, false);
  const transformedKey = cacheKey(uri, true);

  parsedWorkflowCache.delete(baseKey);
  parsedWorkflowCache.delete(transformedKey);
  parsedActionCache.delete(uri);
  parsedActionCache.delete(transformedKey);

  for (const key of workflowTemplateCache.keys()) {
    if (
      key === baseKey ||
      key === transformedKey ||
      key.startsWith(`${baseKey}|`) ||
      key.startsWith(`${transformedKey}|`)
    ) {
      workflowTemplateCache.delete(key);
    }
  }

  actionTemplateCache.delete(uri);
  actionTemplateCache.delete(transformedKey);
}

export function clearCache() {
  parsedWorkflowCache.clear();
  parsedActionCache.clear();
  workflowTemplateCache.clear();
  actionTemplateCache.clear();
}

/**
 * Parses a workflow file, returning cached result if available
 * @param transformed Indicates whether the workflow has been transformed before parsing
 * @returns the {@link TemplateParseResult}
 */
export function getOrParseWorkflow(file: File, uri: string, transformed = false): TemplateParseResult {
  const key = cacheKey(uri, transformed);
  const cachedResult = parsedWorkflowCache.get(key);
  if (cachedResult) {
    return cachedResult;
  }
  const result = parseWorkflow(file, nullTrace);
  parsedWorkflowCache.set(key, result);
  return result;
}

/**
 * Parses an action file, returning cached result if available
 * @param transformed Indicates whether the action has been transformed before parsing
 * @returns the {@link TemplateParseResult}
 */
export function getOrParseAction(file: File, uri: string, transformed = false): TemplateParseResult {
  const key = cacheKey(uri, transformed);
  const cachedResult = parsedActionCache.get(key);
  if (cachedResult) {
    return cachedResult;
  }
  const result = parseAction(file, nullTrace);
  parsedActionCache.set(key, result);
  return result;
}

/**
 * Converts a workflow template, returning cached result if available
 * @param transformed Indicates whether the workflow has been transformed before parsing
 * @returns the converted {@link WorkflowTemplate}
 */
export async function getOrConvertWorkflowTemplate(
  context: TemplateContext,
  template: TemplateToken,
  uri: string,
  config?: CompletionConfig,
  options?: WorkflowTemplateConverterOptions,
  transformed = false
): Promise<WorkflowTemplate> {
  const key = workflowTemplateCacheKey(uri, transformed, options);
  const cachedTemplate = workflowTemplateCache.get(key);
  if (cachedTemplate) {
    return cachedTemplate;
  }
  const workflowTemplate = await convertWorkflowTemplate(context, template, config?.fileProvider, options);
  workflowTemplateCache.set(key, workflowTemplate);
  return workflowTemplate;
}

/**
 * Converts an action template, returning cached result if available
 * @param transformed Indicates whether the action has been transformed before parsing
 * @returns the converted {@link ActionTemplate}
 */
export function getOrConvertActionTemplate(
  context: TemplateContext,
  template: TemplateToken,
  uri: string,
  options?: ActionTemplateConverterOptions,
  transformed = false
): ActionTemplate {
  const key = cacheKey(uri, transformed);
  const cachedTemplate = actionTemplateCache.get(key);
  if (cachedTemplate) {
    return cachedTemplate;
  }
  const actionTemplate = convertActionTemplate(context, template, options);
  actionTemplateCache.set(key, actionTemplate);
  return actionTemplate;
}

/**
 * Use a separate cache namespace for transformed documents so callers can
 * safely cache both the original workflow text and a derived/transformed copy.
 */
function cacheKey(uri: string, transformed: boolean): string {
  if (transformed) {
    return `transformed-${uri}`;
  }
  return uri;
}

/**
 * The converted workflow template depends on more than the document URI.
 *
 * Feature flags and conversion options can materially change the resulting
 * template shape and emitted diagnostics for the same file. Include those
 * inputs in the cache key so callers do not accidentally reuse a template
 * produced under different parsing rules.
 */
function workflowTemplateCacheKey(
  uri: string,
  transformed: boolean,
  options?: WorkflowTemplateConverterOptions
): string {
  const baseKey = cacheKey(uri, transformed);
  if (!options) {
    return baseKey;
  }

  const enabledFeatures = options.featureFlags?.getEnabledFeatures().slice().sort().join(",") ?? "";
  return `${baseKey}|depth:${options.fetchReusableWorkflowDepth ?? "default"}|maxDepth:${
    options.maxReusableWorkflowDepth ?? "default"
  }|policy:${options.errorPolicy ?? "default"}|features:${enabledFeatures}`;
}
