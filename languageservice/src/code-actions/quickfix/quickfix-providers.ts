import {FeatureFlags} from "@actions/expressions";
import {CodeActionProvider} from "../types.js";
import {addMissingInputsProvider} from "./add-missing-inputs.js";
import {lockfileQuickfixProviders} from "./lockfile-quickfix.js";

export function getQuickfixProviders(featureFlags?: FeatureFlags): CodeActionProvider[] {
  const providers: CodeActionProvider[] = [];

  if (featureFlags?.isEnabled("missingInputsQuickfix")) {
    providers.push(addMissingInputsProvider);
  }

  if (featureFlags?.isEnabled("allowDependencies")) {
    providers.push(...lockfileQuickfixProviders);
  }

  return providers;
}
