import { z } from "zod";
import type { JsonValue } from "../generated/codex/serde_json/JsonValue.js";
import type { AskForApproval } from "../generated/codex/v2/AskForApproval.js";
import type { Config } from "../generated/codex/v2/Config.js";
import type { ConfigBatchWriteParams } from "../generated/codex/v2/ConfigBatchWriteParams.js";
import type { ConfigEdit } from "../generated/codex/v2/ConfigEdit.js";
import type { ConfigLayer } from "../generated/codex/v2/ConfigLayer.js";
import type { ConfigReadResponse } from "../generated/codex/v2/ConfigReadResponse.js";
import type { ConfigRequirements } from "../generated/codex/v2/ConfigRequirements.js";
import type { ConfigRequirementsReadResponse } from "../generated/codex/v2/ConfigRequirementsReadResponse.js";
import type { ConfigWriteResponse } from "../generated/codex/v2/ConfigWriteResponse.js";
import type { ExperimentalFeature } from "../generated/codex/v2/ExperimentalFeature.js";
import type { ExperimentalFeatureListResponse } from "../generated/codex/v2/ExperimentalFeatureListResponse.js";
import type { ExperimentalFeatureStage } from "../generated/codex/v2/ExperimentalFeatureStage.js";
import type { Model } from "../generated/codex/v2/Model.js";
import type { ModelListResponse } from "../generated/codex/v2/ModelListResponse.js";
import type { PermissionProfileListResponse } from "../generated/codex/v2/PermissionProfileListResponse.js";
import type { PermissionProfileSummary } from "../generated/codex/v2/PermissionProfileSummary.js";
import { BridgeError } from "../shared/errors.js";
import type { CodexAppServer } from "./rpc.js";

const granularApprovalSchema = z.strictObject({
  sandbox_approval: z.boolean(),
  rules: z.boolean(),
  skill_approval: z.boolean(),
  request_permissions: z.boolean(),
  mcp_elicitations: z.boolean(),
});

const approvalPolicySchema = z.union([
  z.enum(["untrusted", "on-request", "never"]),
  z.strictObject({ granular: granularApprovalSchema }),
]);
const approvalsReviewerSchema = z.enum(["user", "auto_review"]);
const sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const webSearchSchema = z.enum(["disabled", "cached", "indexed", "live"]);
const reasoningSummarySchema = z.enum(["auto", "concise", "detailed", "none"]);
const verbositySchema = z.enum(["low", "medium", "high"]);
const personalitySchema = z.enum(["none", "friendly", "pragmatic"]);
const windowsSandboxSchema = z.enum(["unelevated", "elevated"]);

const nullableIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !containsControlCharacter(value), "Control characters are not allowed")
  .nullable();

const environmentPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !containsControlCharacter(value), "Control characters are not allowed");

const environmentPatternsSchema = z
  .array(environmentPatternSchema)
  .max(100)
  .superRefine(requireUniqueStrings)
  .nullable();

export const basicFeatureDefinitions = Object.freeze({
  apps: {
    label: "Apps",
    description: "Enable app and connector integrations.",
  },
  goals: {
    label: "Goals",
    description: "Enable persisted goals and automatic continuation.",
  },
  hooks: {
    label: "Hooks",
    description: "Enable lifecycle hooks from hooks.json or inline config.",
  },
  fast_mode: {
    label: "Fast mode",
    description: "Enable catalog service tiers and the fast path.",
  },
  memories: {
    label: "Memories",
    description: "Enable experimental Codex memories.",
  },
  multi_agent: {
    label: "Multi-agent",
    description: "Enable subagent collaboration tools.",
  },
  personality: {
    label: "Personality",
    description: "Enable personality selection for supported models.",
  },
  remote_plugin: {
    label: "Plugin catalog",
    description: "Enable the remote plugin catalog.",
  },
  shell_snapshot: {
    label: "Shell snapshot",
    description: "Snapshot the shell environment to speed up commands.",
  },
  shell_tool: {
    label: "Shell tool",
    description: "Enable the default shell tool.",
  },
  unified_exec: {
    label: "Unified exec",
    description: "Use the unified PTY-backed command executor.",
  },
} as const);

export type BasicFeatureKey = keyof typeof basicFeatureDefinitions;

export const basicFeatureKeys = Object.freeze(
  Object.keys(basicFeatureDefinitions) as BasicFeatureKey[],
);

const featureValuesSchema = z.strictObject({
  apps: z.boolean().nullable(),
  goals: z.boolean().nullable(),
  hooks: z.boolean().nullable(),
  fast_mode: z.boolean().nullable(),
  memories: z.boolean().nullable(),
  multi_agent: z.boolean().nullable(),
  personality: z.boolean().nullable(),
  remote_plugin: z.boolean().nullable(),
  shell_snapshot: z.boolean().nullable(),
  shell_tool: z.boolean().nullable(),
  unified_exec: z.boolean().nullable(),
});

const featurePatchSchema = featureValuesSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one feature value is required");

export const editableCodexConfigSchema = z.strictObject({
  model: nullableIdentifierSchema,
  model_provider: nullableIdentifierSchema,
  approval_policy: approvalPolicySchema.nullable(),
  approvals_reviewer: approvalsReviewerSchema.nullable(),
  sandbox_mode: sandboxModeSchema.nullable(),
  default_permissions: nullableIdentifierSchema,
  web_search: webSearchSchema.nullable(),
  model_reasoning_effort: nullableIdentifierSchema,
  model_reasoning_summary: reasoningSummarySchema.nullable(),
  model_verbosity: verbositySchema.nullable(),
  service_tier: nullableIdentifierSchema,
  personality: personalitySchema.nullable(),
  windows_sandbox: windowsSandboxSchema.nullable(),
  shell_environment_include_only: environmentPatternsSchema,
  features: featureValuesSchema,
});

const configPatchSchema = editableCodexConfigSchema.partial().extend({
  features: featurePatchSchema.optional(),
});

export const configUpdateSchema = z.strictObject({
  expectedVersion: z.string().min(1).nullable(),
  values: configPatchSchema.refine((value) => Object.keys(value).length > 0, {
    message: "At least one config value is required",
  }),
});

export type EditableCodexConfig = z.infer<typeof editableCodexConfigSchema>;
export type ConfigUpdate = z.infer<typeof configUpdateSchema>;

type ProtocolEditableCodexConfig = Pick<
  Config,
  | "model"
  | "model_provider"
  | "approval_policy"
  | "approvals_reviewer"
  | "sandbox_mode"
  | "web_search"
  | "model_reasoning_effort"
  | "model_reasoning_summary"
  | "model_verbosity"
  | "service_tier"
> & { readonly personality: z.infer<typeof personalitySchema> | null };

type AssertTrue<Value extends true> = Value;

/** Fails the build if a generated Codex field becomes incompatible with the Mini App. */
export type EditableConfigProtocolCompatibility = AssertTrue<
  EditableCodexConfig extends ProtocolEditableCodexConfig ? true : false
>;

export interface ModelCapability {
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportedReasoningEfforts: Model["supportedReasoningEfforts"];
  readonly defaultReasoningEffort: Model["defaultReasoningEffort"];
  readonly serviceTiers: Model["serviceTiers"];
  readonly defaultServiceTier: string | null;
  readonly isDefault: boolean;
}

export interface ModelProviderCapability {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly allowed: boolean;
}

export interface FeatureCapability {
  readonly name: BasicFeatureKey;
  readonly displayName: string;
  readonly description: string;
  readonly stage: ExperimentalFeatureStage;
  readonly enabled: boolean;
  readonly defaultEnabled: boolean;
  readonly locked: boolean;
}

export interface ConfigCapabilities {
  readonly platform: NodeJS.Platform;
  readonly models: readonly ModelCapability[];
  readonly modelProviders: readonly ModelProviderCapability[];
  readonly permissionProfiles: readonly PermissionProfileSummary[];
  readonly features: readonly FeatureCapability[];
  readonly requirements: ConfigRequirements | null;
}

export type ConfigIssueSeverity = "error" | "warning";

export interface ConfigValidationIssue {
  readonly path: string;
  readonly severity: ConfigIssueSeverity;
  readonly message: string;
}

export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ConfigValidationIssue[];
}

export interface EditableConfigSnapshot {
  readonly version: string | null;
  readonly values: EditableCodexConfig;
  readonly capabilities: ConfigCapabilities;
  readonly validation: ConfigValidationResult;
}

export class ConfigValidationError extends BridgeError {
  public readonly issues: readonly ConfigValidationIssue[];

  public constructor(issues: readonly ConfigValidationIssue[]) {
    super("The config update is invalid", "INVALID_CONFIG");
    this.issues = issues;
    this.name = "ConfigValidationError";
  }
}

interface ConfigState {
  readonly response: ConfigReadResponse;
  readonly version: string | null;
  readonly values: EditableCodexConfig;
  readonly capabilities: ConfigCapabilities;
}

interface CapabilitiesCache {
  readonly expiresAt: number;
  readonly value: Promise<CachedConfigCapabilities>;
}

type CachedConfigCapabilities = Omit<ConfigCapabilities, "modelProviders">;

const CAPABILITIES_CACHE_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const scalarConfigPaths = Object.freeze([
  ["model", "model"],
  ["model_provider", "model_provider"],
  ["approval_policy", "approval_policy"],
  ["approvals_reviewer", "approvals_reviewer"],
  ["sandbox_mode", "sandbox_mode"],
  ["default_permissions", "default_permissions"],
  ["web_search", "web_search"],
  ["model_reasoning_effort", "model_reasoning_effort"],
  ["model_reasoning_summary", "model_reasoning_summary"],
  ["model_verbosity", "model_verbosity"],
  ["service_tier", "service_tier"],
  ["personality", "personality"],
  ["windows_sandbox", "windows.sandbox"],
  ["shell_environment_include_only", "shell_environment_policy.include_only"],
] as const satisfies readonly (readonly [
  Exclude<keyof EditableCodexConfig, "features">,
  string,
])[]);

export class CodexConfigService {
  readonly #rpc: CodexAppServer;
  readonly #cwd: string;
  #capabilitiesCache: CapabilitiesCache | undefined;

  public constructor(rpc: CodexAppServer, cwd = process.cwd()) {
    this.#rpc = rpc;
    this.#cwd = cwd;
  }

  public async read(): Promise<EditableConfigSnapshot> {
    const state = await this.readState();
    return {
      version: state.version,
      values: state.values,
      capabilities: state.capabilities,
      validation: validateConfig(state.values, state),
    };
  }

  public async validate(input: unknown): Promise<ConfigValidationResult> {
    const update = configUpdateSchema.parse(input);
    const state = await this.readState();
    const issues = [...validateVersion(update.expectedVersion, state.version)];
    const candidate = mergeConfig(state.values, update.values);
    issues.push(...validateConfig(candidate, state, update.values).issues);
    return validationResult(issues);
  }

  public async update(input: unknown): Promise<ConfigWriteResponse> {
    const update = configUpdateSchema.parse(input);
    const state = await this.readState();
    const issues = [...validateVersion(update.expectedVersion, state.version)];
    const candidate = mergeConfig(state.values, update.values);
    issues.push(...validateConfig(candidate, state, update.values).issues);
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) throw new ConfigValidationError(issues);

    const params: ConfigBatchWriteParams = {
      edits: editsForPatch(update.values),
      expectedVersion: update.expectedVersion,
      reloadUserConfig: true,
    };
    const response = await this.#rpc.request<ConfigWriteResponse>({
      method: "config/batchWrite",
      params,
    });
    this.#capabilitiesCache = undefined;
    return response;
  }

  private async readState(): Promise<ConfigState> {
    const [response, cachedCapabilities] = await Promise.all([
      this.#rpc.request<ConfigReadResponse>({
        method: "config/read",
        params: { includeLayers: true, cwd: this.#cwd },
      }),
      this.capabilities(),
    ]);
    const userLayer = findUserLayer(response.layers);
    const capabilities: ConfigCapabilities = {
      ...cachedCapabilities,
      modelProviders: toModelProviderCapabilities(response),
    };
    return {
      response,
      version: userLayer?.version ?? null,
      values: parseUserValues(userLayer?.config),
      capabilities,
    };
  }

  private capabilities(): Promise<CachedConfigCapabilities> {
    const now = Date.now();
    const cached = this.#capabilitiesCache;
    if (cached !== undefined && cached.expiresAt > now) return cached.value;
    const value = this.loadCapabilities();
    this.#capabilitiesCache = { expiresAt: now + CAPABILITIES_CACHE_MS, value };
    void value.catch(() => {
      if (this.#capabilitiesCache?.value === value) this.#capabilitiesCache = undefined;
    });
    return value;
  }

  private async loadCapabilities(): Promise<CachedConfigCapabilities> {
    const [models, permissionProfiles, remoteFeatures, requirementsResponse] = await Promise.all([
      this.listModels(),
      this.listPermissionProfiles(),
      this.listFeatures(),
      this.#rpc.request<ConfigRequirementsReadResponse>({
        method: "configRequirements/read",
        params: undefined,
      }),
    ]);
    const requirements = requirementsResponse.requirements;
    return {
      platform: process.platform,
      models: models.filter((model) => !model.hidden).map(toModelCapability),
      permissionProfiles,
      features: toFeatureCapabilities(remoteFeatures, requirements),
      requirements,
    };
  }

  private async listModels(): Promise<Model[]> {
    const values: Model[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response: ModelListResponse = await this.#rpc.request<ModelListResponse>({
        method: "model/list",
        params: { cursor, limit: PAGE_SIZE, includeHidden: false },
      });
      values.push(...response.data);
      if (response.nextCursor === null) return values;
      cursor = response.nextCursor;
    }
    throw new BridgeError("Codex model list exceeded the pagination limit", "CODEX_PAGINATION");
  }

  private async listPermissionProfiles(): Promise<PermissionProfileSummary[]> {
    const values: PermissionProfileSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response: PermissionProfileListResponse =
        await this.#rpc.request<PermissionProfileListResponse>({
          method: "permissionProfile/list",
          params: { cursor, limit: PAGE_SIZE, cwd: this.#cwd },
        });
      values.push(...response.data);
      if (response.nextCursor === null) return values;
      cursor = response.nextCursor;
    }
    throw new BridgeError(
      "Codex permission profile list exceeded the pagination limit",
      "CODEX_PAGINATION",
    );
  }

  private async listFeatures(): Promise<ExperimentalFeature[]> {
    const values: ExperimentalFeature[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response: ExperimentalFeatureListResponse =
        await this.#rpc.request<ExperimentalFeatureListResponse>({
          method: "experimentalFeature/list",
          params: { cursor, limit: PAGE_SIZE },
        });
      values.push(...response.data);
      if (response.nextCursor === null) return values;
      cursor = response.nextCursor;
    }
    throw new BridgeError("Codex feature list exceeded the pagination limit", "CODEX_PAGINATION");
  }
}

function parseUserValues(config: JsonValue | undefined): EditableCodexConfig {
  const root = asRecord(config);
  return editableCodexConfigSchema.parse({
    model: readPath(root, ["model"], nullableIdentifierSchema),
    model_provider: readPath(root, ["model_provider"], nullableIdentifierSchema),
    approval_policy: readPath(root, ["approval_policy"], approvalPolicySchema.nullable()),
    approvals_reviewer: readPath(root, ["approvals_reviewer"], approvalsReviewerSchema.nullable()),
    sandbox_mode: readPath(root, ["sandbox_mode"], sandboxModeSchema.nullable()),
    default_permissions: readPath(root, ["default_permissions"], nullableIdentifierSchema),
    web_search: readPath(root, ["web_search"], webSearchSchema.nullable()),
    model_reasoning_effort: readPath(root, ["model_reasoning_effort"], nullableIdentifierSchema),
    model_reasoning_summary: readPath(
      root,
      ["model_reasoning_summary"],
      reasoningSummarySchema.nullable(),
    ),
    model_verbosity: readPath(root, ["model_verbosity"], verbositySchema.nullable()),
    service_tier: readPath(root, ["service_tier"], nullableIdentifierSchema),
    personality: readPath(root, ["personality"], personalitySchema.nullable()),
    windows_sandbox: readPath(root, ["windows", "sandbox"], windowsSandboxSchema.nullable()),
    shell_environment_include_only: readPath(
      root,
      ["shell_environment_policy", "include_only"],
      environmentPatternsSchema,
    ),
    features: Object.fromEntries(
      basicFeatureKeys.map((key) => [
        key,
        readPath(root, ["features", key], z.boolean().nullable()),
      ]),
    ),
  });
}

function readPath<Output>(
  root: Readonly<Record<string, JsonValue | undefined>>,
  path: readonly string[],
  schema: z.ZodType<Output>,
): Output {
  let value: JsonValue | undefined = root;
  for (const segment of path) {
    const record = asRecord(value);
    value = record[segment];
  }
  return schema.parse(value ?? null);
}

function mergeConfig(
  current: EditableCodexConfig,
  patch: ConfigUpdate["values"],
): EditableCodexConfig {
  return editableCodexConfigSchema.parse({
    ...current,
    ...patch,
    features: {
      ...current.features,
      ...patch.features,
    },
  });
}

function editsForPatch(patch: ConfigUpdate["values"]): ConfigEdit[] {
  const edits: ConfigEdit[] = [];
  for (const [key, keyPath] of scalarConfigPaths) {
    if (!Object.hasOwn(patch, key)) continue;
    edits.push({
      keyPath,
      value: patch[key] as JsonValue,
      mergeStrategy: "upsert",
    });
  }
  if (patch.features !== undefined) {
    for (const key of basicFeatureKeys) {
      if (!Object.hasOwn(patch.features, key)) continue;
      edits.push({
        keyPath: `features.${key}`,
        value: patch.features[key] ?? null,
        mergeStrategy: "upsert",
      });
    }
  }
  return edits;
}

function validateConfig(
  values: EditableCodexConfig,
  state: Pick<ConfigState, "response" | "capabilities" | "values">,
  patch?: ConfigUpdate["values"],
): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];
  const { capabilities } = state;
  const provider =
    values.model_provider === null
      ? undefined
      : capabilities.modelProviders.find((candidate) => candidate.id === values.model_provider);
  if (values.model_provider !== null && (provider === undefined || !provider.allowed)) {
    issues.push(
      errorIssue("model_provider", "Choose a model provider configured for this Codex workspace."),
    );
  }

  const providerChanged =
    patch !== undefined &&
    Object.hasOwn(patch, "model_provider") &&
    patch.model_provider !== state.values.model_provider;
  if (providerChanged) {
    for (const field of [
      "model",
      "model_reasoning_effort",
      "service_tier",
      "personality",
    ] as const) {
      if (values[field] !== null) {
        issues.push(
          errorIssue(field, "Reset this value when changing model provider, then choose it again."),
        );
      }
    }
  }

  const model = providerChanged ? undefined : selectedModel(values.model, capabilities.models);

  if (!providerChanged && values.model !== null && model === undefined) {
    issues.push(errorIssue("model", "Choose a model available to this Codex account."));
  }

  if (!providerChanged && values.model_reasoning_effort !== null) {
    if (model === undefined) {
      issues.push(
        errorIssue("model_reasoning_effort", "Choose an available model before setting effort."),
      );
    } else if (
      !model.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === values.model_reasoning_effort,
      )
    ) {
      issues.push(
        errorIssue(
          "model_reasoning_effort",
          `${model.displayName} does not support this reasoning effort.`,
        ),
      );
    }
  }

  if (!providerChanged && values.service_tier !== null) {
    if (model === undefined) {
      issues.push(errorIssue("service_tier", "Choose an available model before setting a tier."));
    } else if (!model.serviceTiers.some((tier) => tier.id === values.service_tier)) {
      issues.push(
        errorIssue("service_tier", `${model.displayName} does not offer this service tier.`),
      );
    }
  }

  const otherActiveLayers = activeLayers(state.response.layers).filter(
    (layer) => !(layer.name.type === "user" && layer.name.profile === null),
  );
  const hasOtherDefaultPermissions = otherActiveLayers.some(
    (layer) => readActiveValue(asRecord(layer.config).default_permissions) !== undefined,
  );
  const hasOtherSandboxMode = otherActiveLayers.some(
    (layer) => readActiveValue(asRecord(layer.config).sandbox_mode) !== undefined,
  );
  const hasOtherWorkspaceSandbox = otherActiveLayers.some(
    (layer) => readActiveValue(asRecord(layer.config).sandbox_workspace_write) !== undefined,
  );
  const userLayer = findUserLayer(state.response.layers);
  const hasUserWorkspaceSandbox =
    readActiveValue(asRecord(userLayer?.config).sandbox_workspace_write) !== undefined;
  const hasDefaultPermissions = values.default_permissions !== null || hasOtherDefaultPermissions;
  const hasSandboxMode = values.sandbox_mode !== null || hasOtherSandboxMode;
  const hasWorkspaceSandbox = hasUserWorkspaceSandbox || hasOtherWorkspaceSandbox;
  if (hasDefaultPermissions && (hasSandboxMode || hasWorkspaceSandbox)) {
    const message =
      "Permission profiles cannot be combined with sandbox_mode or sandbox_workspace_write in active config layers.";
    issues.push(errorIssue("default_permissions", message));
    if (hasSandboxMode) issues.push(errorIssue("sandbox_mode", message));
    if (hasWorkspaceSandbox) issues.push(errorIssue("sandbox_workspace_write", message));
  }

  if (values.default_permissions !== null) {
    const profile = capabilities.permissionProfiles.find(
      (candidate) => candidate.id === values.default_permissions,
    );
    if (profile === undefined) {
      issues.push(
        errorIssue("default_permissions", "Choose a permission profile known to this Codex."),
      );
    } else if (!profile.allowed) {
      issues.push(
        errorIssue("default_permissions", "Managed requirements disallow this permission profile."),
      );
    }
  }

  if (patch?.features !== undefined) {
    const availableFeatures = new Set(capabilities.features.map((feature) => feature.name));
    for (const key of basicFeatureKeys) {
      if (Object.hasOwn(patch.features, key) && !availableFeatures.has(key)) {
        issues.push(
          errorIssue(
            `features.${key}`,
            "This feature is absent, deprecated, or removed in the installed Codex version.",
          ),
        );
      }
    }
  }

  validateRequirements(values, capabilities.requirements, issues);

  const effectiveApprovalPolicy =
    values.approval_policy ?? state.response.config.approval_policy ?? null;
  if (
    values.approvals_reviewer === "auto_review" &&
    effectiveApprovalPolicy !== null &&
    !supportsInteractiveApproval(effectiveApprovalPolicy)
  ) {
    issues.push(
      errorIssue(
        "approvals_reviewer",
        "Auto-review requires on-request or an interactive granular approval policy.",
      ),
    );
  }

  if (values.approval_policy === "never" && values.sandbox_mode === "danger-full-access") {
    issues.push(
      warningIssue(
        "approval_policy",
        "Never ask plus full access gives Codex broad access without confirmation.",
      ),
    );
  }

  if (values.windows_sandbox !== null && capabilities.platform !== "win32") {
    issues.push(
      warningIssue("windows_sandbox", "This setting only takes effect on native Windows."),
    );
  }

  if (values.features.personality === false && values.personality !== null) {
    issues.push(
      warningIssue("personality", "The personality feature is disabled, so this value is ignored."),
    );
  }

  if (values.features.fast_mode === false && values.service_tier !== null) {
    issues.push(
      warningIssue("service_tier", "Fast mode is disabled, so tier selection may be unavailable."),
    );
  }

  if (values.shell_environment_include_only !== null) {
    const patterns = values.shell_environment_include_only;
    if (!matchesEnvironmentName(patterns, "PATH")) {
      issues.push(
        warningIssue(
          "shell_environment_include_only",
          "The allowlist does not appear to include PATH; shell commands may fail.",
        ),
      );
    }
    if (!matchesEnvironmentName(patterns, "HOME")) {
      issues.push(
        warningIssue(
          "shell_environment_include_only",
          "The allowlist does not appear to include HOME.",
        ),
      );
    }
  }

  return validationResult(issues);
}

function validateRequirements(
  values: EditableCodexConfig,
  requirements: ConfigRequirements | null,
  issues: ConfigValidationIssue[],
): void {
  if (requirements === null) return;

  const approvalPolicy = values.approval_policy;
  if (
    approvalPolicy !== null &&
    requirements.allowedApprovalPolicies !== null &&
    !requirements.allowedApprovalPolicies.some((policy) =>
      approvalPoliciesEqual(policy, approvalPolicy),
    )
  ) {
    issues.push(errorIssue("approval_policy", "Managed requirements disallow this policy."));
  }

  if (
    values.sandbox_mode !== null &&
    requirements.allowedSandboxModes !== null &&
    !requirements.allowedSandboxModes.includes(values.sandbox_mode)
  ) {
    issues.push(errorIssue("sandbox_mode", "Managed requirements disallow this sandbox mode."));
  }

  if (
    values.web_search !== null &&
    requirements.allowedWebSearchModes !== null &&
    !requirements.allowedWebSearchModes.includes(values.web_search)
  ) {
    issues.push(errorIssue("web_search", "Managed requirements disallow this search mode."));
  }

  if (
    values.windows_sandbox !== null &&
    requirements.allowedWindowsSandboxImplementations !== null &&
    !requirements.allowedWindowsSandboxImplementations.includes(values.windows_sandbox)
  ) {
    issues.push(errorIssue("windows_sandbox", "Managed requirements disallow this Windows mode."));
  }

  for (const key of basicFeatureKeys) {
    const value = values.features[key];
    const required = requirements.featureRequirements?.[key];
    if (value !== null && required !== undefined && value !== required) {
      issues.push(errorIssue(`features.${key}`, "This feature is fixed by managed requirements."));
    }
  }
}

function validateVersion(expected: string | null, current: string | null): ConfigValidationIssue[] {
  if (expected === current) return [];
  return [
    errorIssue(
      "expectedVersion",
      "The config changed after this page loaded. Reload before saving.",
    ),
  ];
}

function selectedModel(
  configured: string | null,
  models: readonly ModelCapability[],
): ModelCapability | undefined {
  return configured === null
    ? (models.find((model) => model.isDefault) ?? models[0])
    : models.find((model) => model.model === configured);
}

function toModelCapability(model: Model): ModelCapability {
  return {
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    serviceTiers: model.serviceTiers,
    defaultServiceTier: model.defaultServiceTier,
    isDefault: model.isDefault,
  };
}

function toModelProviderCapabilities(response: ConfigReadResponse): ModelProviderCapability[] {
  const providers = new Map<string, Omit<ModelProviderCapability, "id">>();
  const addProvider = (id: string, description: string): void => {
    const parsed = nullableIdentifierSchema.safeParse(id);
    if (!parsed.success || parsed.data === null || providers.has(parsed.data)) return;
    providers.set(parsed.data, {
      displayName: parsed.data === "openai" ? "OpenAI" : parsed.data,
      description,
      allowed: true,
    });
  };

  addProvider("openai", "Built-in OpenAI model provider.");
  if (response.config.model_provider !== null) {
    addProvider(response.config.model_provider, "Current model provider reported by Codex.");
  }
  for (const layer of activeLayers(response.layers)) {
    const config = asRecord(layer.config);
    if (typeof config.model_provider === "string") {
      addProvider(config.model_provider, "Model provider selected in an active config layer.");
    }
    for (const id of Object.keys(asRecord(config.model_providers))) {
      addProvider(id, "Model provider configured in an active config layer.");
    }
  }

  return [...providers].map(([id, capability]) => ({ id, ...capability }));
}

function toFeatureCapabilities(
  remote: readonly ExperimentalFeature[],
  requirements: ConfigRequirements | null,
): FeatureCapability[] {
  const byName = new Map(remote.map((feature) => [feature.name, feature]));
  const values: FeatureCapability[] = [];
  for (const name of basicFeatureKeys) {
    const feature = byName.get(name);
    if (feature === undefined || feature.stage === "deprecated" || feature.stage === "removed") {
      continue;
    }
    const definition = basicFeatureDefinitions[name];
    values.push({
      name,
      displayName: feature.displayName ?? definition.label,
      description: feature.description ?? definition.description,
      stage: feature.stage,
      enabled: feature.enabled,
      defaultEnabled: feature.defaultEnabled,
      locked: requirements?.featureRequirements?.[name] !== undefined,
    });
  }
  return values;
}

function activeLayers(layers: readonly ConfigLayer[] | null): readonly ConfigLayer[] {
  return layers?.filter((layer) => layer.disabledReason === null) ?? [];
}

function findUserLayer(layers: readonly ConfigLayer[] | null): ConfigLayer | undefined {
  return layers?.find((layer) => layer.name.type === "user" && layer.name.profile === null);
}

function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue | undefined>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function readActiveValue(value: JsonValue | undefined): JsonValue | undefined {
  return value === null ? undefined : value;
}

function supportsInteractiveApproval(policy: AskForApproval | null): boolean {
  if (policy === "on-request") return true;
  if (policy === null || typeof policy === "string") return false;
  const granular = policy.granular;
  return (
    granular.sandbox_approval ||
    granular.rules ||
    granular.skill_approval ||
    granular.request_permissions ||
    granular.mcp_elicitations
  );
}

function approvalPoliciesEqual(left: AskForApproval, right: AskForApproval): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return (
    left.granular.sandbox_approval === right.granular.sandbox_approval &&
    left.granular.rules === right.granular.rules &&
    left.granular.skill_approval === right.granular.skill_approval &&
    left.granular.request_permissions === right.granular.request_permissions &&
    left.granular.mcp_elicitations === right.granular.mcp_elicitations
  );
}

function validationResult(issues: readonly ConfigValidationIssue[]): ConfigValidationResult {
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

function errorIssue(path: string, message: string): ConfigValidationIssue {
  return { path, severity: "error", message };
}

function warningIssue(path: string, message: string): ConfigValidationIssue {
  return { path, severity: "warning", message };
}

function matchesEnvironmentName(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => pattern === "*" || pattern.toUpperCase() === name);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

function requireUniqueStrings(
  values: readonly string[],
  context: z.core.$RefinementCtx<readonly string[]>,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "Duplicate values are not allowed",
      });
    }
    seen.add(value);
  }
}
