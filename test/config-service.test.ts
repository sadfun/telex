import { describe, expect, it } from "vitest";
import { CodexConfigService, ConfigValidationError } from "../src/codex/config-service.js";
import type { CodexAppServer } from "../src/codex/rpc.js";
import type { ClientRequest } from "../src/generated/codex/ClientRequest.js";
import type { JsonValue } from "../src/generated/codex/serde_json/JsonValue.js";
import type { AskForApproval } from "../src/generated/codex/v2/AskForApproval.js";
import type { Config } from "../src/generated/codex/v2/Config.js";
import type { ConfigLayer } from "../src/generated/codex/v2/ConfigLayer.js";
import type { ConfigReadResponse } from "../src/generated/codex/v2/ConfigReadResponse.js";
import type { ConfigRequirements } from "../src/generated/codex/v2/ConfigRequirements.js";
import type { ConfigWriteResponse } from "../src/generated/codex/v2/ConfigWriteResponse.js";
import type { ExperimentalFeature } from "../src/generated/codex/v2/ExperimentalFeature.js";
import type { Model } from "../src/generated/codex/v2/Model.js";

describe("CodexConfigService", () => {
  it("reads explicit user values and account-specific capabilities", async () => {
    const rpc = new FakeConfigRpc({
      approval_policy: "on-request",
    });
    const snapshot = await service(rpc).read();

    expect(snapshot.values.approval_policy).toBe("on-request");
    expect(snapshot.values.model).toBeNull();
    expect(snapshot.values.model_provider).toBeNull();
    expect(snapshot.capabilities.models[0]).toMatchObject({
      model: "gpt-test",
      defaultReasoningEffort: "medium",
    });
    expect(snapshot.capabilities.features.map((feature) => feature.name)).toEqual(["apps"]);
    expect(snapshot.capabilities.modelProviders).toEqual([
      expect.objectContaining({ id: "openai", displayName: "OpenAI", allowed: true }),
    ]);
    expect(snapshot.validation.valid).toBe(true);
  });

  it("preserves granular approvals and derives a safe provider selector from active config", async () => {
    const approvalPolicy = granularApproval({ sandbox_approval: true });
    const rpc = new FakeConfigRpc(
      {
        model_provider: "workspace-provider",
        model_providers: { "workspace-provider": { name: "Workspace" } },
        approval_policy: approvalPolicy,
        approvals_reviewer: "auto_review",
      },
      {
        effectiveConfig: { model_provider: "workspace-provider", approval_policy: approvalPolicy },
      },
    );

    const snapshot = await service(rpc).read();

    expect(snapshot.values.approval_policy).toEqual(approvalPolicy);
    expect(snapshot.values.model_provider).toBe("workspace-provider");
    expect(snapshot.capabilities.modelProviders.map((provider) => provider.id)).toEqual([
      "openai",
      "workspace-provider",
    ]);
    expect(snapshot.validation.valid).toBe(true);
  });

  it("rejects a reasoning effort unavailable for the selected model", async () => {
    const rpc = new FakeConfigRpc({});
    const result = await service(rpc).validate({
      expectedVersion: "revision-1",
      values: { model: "gpt-test", model_reasoning_effort: "ultra" },
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "model_reasoning_effort", severity: "error" }),
    );
  });

  it("lets Codex validate personality instead of trusting stale model catalog metadata", async () => {
    const rpc = new FakeConfigRpc({ model: "gpt-test" });
    const result = await service(rpc).validate({
      expectedVersion: "revision-1",
      values: { personality: "friendly" },
    });

    expect(result.valid).toBe(true);
  });

  it("requires provider-dependent selections to reset during a provider switch", async () => {
    const rpc = new FakeConfigRpc({
      model_provider: "openai",
      model_providers: { custom: { name: "Custom" } },
      model: "gpt-test",
      model_reasoning_effort: "medium",
      service_tier: "priority",
      personality: "friendly",
    });
    const config = service(rpc);

    const invalid = await config.validate({
      expectedVersion: "revision-1",
      values: { model_provider: "custom" },
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["model", "model_reasoning_effort", "service_tier", "personality"]),
    );

    await config.update({
      expectedVersion: "revision-1",
      values: {
        model: null,
        model_provider: "custom",
        model_reasoning_effort: null,
        service_tier: null,
        personality: null,
      },
    });
    const write = rpc.requests.find((request) => request.method === "config/batchWrite");
    expect(write?.params).toMatchObject({
      edits: expect.arrayContaining([
        { keyPath: "model_provider", value: "custom", mergeStrategy: "upsert" },
      ]),
    });
  });

  it("rejects a provider that is neither built in, current, nor actively configured", async () => {
    const result = await service(new FakeConfigRpc({})).validate({
      expectedVersion: "revision-1",
      values: { model_provider: "invented-provider" },
    });

    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "model_provider", severity: "error" }),
    );
  });

  it("accepts interactive granular auto-review and rejects a noninteractive granular policy", async () => {
    const rpc = new FakeConfigRpc({ approvals_reviewer: "auto_review" });
    const config = service(rpc);

    const interactive = await config.validate({
      expectedVersion: "revision-1",
      values: { approval_policy: granularApproval({ request_permissions: true }) },
    });
    expect(interactive.valid).toBe(true);

    const noninteractive = await config.validate({
      expectedVersion: "revision-1",
      values: { approval_policy: granularApproval({}) },
    });
    expect(noninteractive.issues).toContainEqual(
      expect.objectContaining({ path: "approvals_reviewer", severity: "error" }),
    );
  });

  it("uses the effective inherited approval policy when validating auto-review", async () => {
    const snapshot = await service(
      new FakeConfigRpc(
        { approvals_reviewer: "auto_review" },
        { effectiveConfig: { approval_policy: "on-request" } },
      ),
    ).read();

    expect(snapshot.values.approval_policy).toBeNull();
    expect(snapshot.validation.valid).toBe(true);
  });

  it("compares granular managed approval policies structurally", async () => {
    const allowed = granularApproval({ sandbox_approval: true, rules: true });
    const rpc = new FakeConfigRpc({}, { requirements: requirementsWithPolicies([allowed]) });
    const config = service(rpc);

    expect(
      await config.validate({
        expectedVersion: "revision-1",
        values: { approval_policy: allowed },
      }),
    ).toMatchObject({ valid: true });

    const rejected = await config.validate({
      expectedVersion: "revision-1",
      values: { approval_policy: granularApproval({ sandbox_approval: true }) },
    });
    expect(rejected.issues).toContainEqual(
      expect.objectContaining({ path: "approval_policy", severity: "error" }),
    );
  });

  it("rejects stale revisions and conflicting sandbox systems", async () => {
    const rpc = new FakeConfigRpc({ sandbox_mode: "workspace-write" });
    const result = await service(rpc).validate({
      expectedVersion: "stale",
      values: { default_permissions: ":workspace" },
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["expectedVersion", "default_permissions", "sandbox_mode"]),
    );
  });

  it("detects the reverse conflict when an active layer supplies default_permissions", async () => {
    const rpc = new FakeConfigRpc(
      {},
      {
        additionalLayers: [
          configLayer(
            { type: "project", dotCodexFolder: "/workspace/.codex" },
            { default_permissions: ":workspace" },
          ),
        ],
      },
    );
    const result = await service(rpc).validate({
      expectedVersion: "revision-1",
      values: { sandbox_mode: "read-only" },
    });

    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["default_permissions", "sandbox_mode"]),
    );
  });

  it("rejects patches for features absent, deprecated, or removed from capabilities", async () => {
    const rpc = new FakeConfigRpc(
      {},
      {
        features: [
          appsFeature,
          testFeature("hooks", "deprecated"),
          testFeature("goals", "removed"),
        ],
      },
    );
    const config = service(rpc);

    for (const key of ["memories", "hooks", "goals"] as const) {
      const result = await config.validate({
        expectedVersion: "revision-1",
        values: { features: { [key]: false } },
      });
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: `features.${key}`, severity: "error" }),
      );
    }
  });

  it("writes one generated atomic batch after validating the merged candidate", async () => {
    const rpc = new FakeConfigRpc({ sandbox_mode: "workspace-write" });
    const config = service(rpc);
    await config.update({
      expectedVersion: "revision-1",
      values: {
        sandbox_mode: null,
        default_permissions: ":workspace",
        features: { apps: false },
      },
    });

    const write = rpc.requests.find((request) => request.method === "config/batchWrite");
    expect(write?.params).toMatchObject({
      expectedVersion: "revision-1",
      reloadUserConfig: true,
      edits: [
        { keyPath: "sandbox_mode", value: null, mergeStrategy: "upsert" },
        { keyPath: "default_permissions", value: ":workspace", mergeStrategy: "upsert" },
        { keyPath: "features.apps", value: false, mergeStrategy: "upsert" },
      ],
    });
  });

  it("does not call Codex batchWrite when preflight validation fails", async () => {
    const rpc = new FakeConfigRpc({});
    await expect(
      service(rpc).update({
        expectedVersion: "revision-1",
        values: { model: "not-on-this-account" },
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(rpc.requests.some((request) => request.method === "config/batchWrite")).toBe(false);
  });
});

interface RecordedRequest {
  readonly method: string;
  readonly params: unknown;
}

class FakeConfigRpc {
  public readonly requests: RecordedRequest[] = [];
  readonly #config: ConfigReadResponse;
  readonly #features: readonly ExperimentalFeature[];
  readonly #requirements: ConfigRequirements | null;

  public constructor(userConfig: Record<string, unknown>, options: FakeConfigRpcOptions = {}) {
    this.#features = options.features ?? [appsFeature];
    this.#requirements = options.requirements ?? null;
    this.#config = {
      config: (options.effectiveConfig ?? {}) as Config,
      origins: {},
      layers: [
        {
          name: { type: "user", file: "/tmp/codex/config.toml", profile: null },
          version: "revision-1",
          config: userConfig as JsonValue,
          disabledReason: null,
        },
        ...(options.additionalLayers ?? []),
      ],
    };
  }

  public async request<Result>(request: RequestWithoutId): Promise<Result> {
    this.requests.push({ method: request.method, params: request.params });
    switch (request.method) {
      case "config/read":
        return this.#config as Result;
      case "model/list":
        return { data: [testModel], nextCursor: null } as Result;
      case "permissionProfile/list":
        return {
          data: [{ id: ":workspace", description: "Workspace access", allowed: true }],
          nextCursor: null,
        } as Result;
      case "experimentalFeature/list":
        return { data: this.#features, nextCursor: null } as Result;
      case "configRequirements/read":
        return { requirements: this.#requirements } as Result;
      case "config/batchWrite":
        return {
          status: "ok",
          version: "revision-2",
          filePath: "/tmp/codex/config.toml",
          overriddenMetadata: null,
        } satisfies ConfigWriteResponse as Result;
      default:
        throw new Error(`Unexpected request: ${request.method}`);
    }
  }
}

interface FakeConfigRpcOptions {
  readonly effectiveConfig?: Partial<Config>;
  readonly additionalLayers?: readonly ConfigLayer[];
  readonly features?: readonly ExperimentalFeature[];
  readonly requirements?: ConfigRequirements | null;
}

type RequestWithoutId = ClientRequest extends infer Request
  ? Request extends { id: unknown }
    ? Omit<Request, "id">
    : never
  : never;

const testModel = {
  id: "gpt-test",
  model: "gpt-test",
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: "GPT Test",
  description: "A model used by the config service tests.",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Low" },
    { reasoningEffort: "medium", description: "Medium" },
    { reasoningEffort: "high", description: "High" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
  supportsPersonality: false,
  additionalSpeedTiers: [],
  serviceTiers: [{ id: "priority", name: "Fast", description: "Faster responses" }],
  defaultServiceTier: null,
  isDefault: true,
} satisfies Model;

const appsFeature = {
  name: "apps",
  stage: "stable",
  displayName: null,
  description: null,
  announcement: null,
  enabled: true,
  defaultEnabled: true,
} satisfies ExperimentalFeature;

type GranularApproval = Extract<AskForApproval, { granular: unknown }>["granular"];

function granularApproval(overrides: Partial<GranularApproval>): AskForApproval {
  return {
    granular: {
      sandbox_approval: false,
      rules: false,
      skill_approval: false,
      request_permissions: false,
      mcp_elicitations: false,
      ...overrides,
    },
  };
}

function requirementsWithPolicies(
  allowedApprovalPolicies: readonly AskForApproval[],
): ConfigRequirements {
  return {
    allowedApprovalPolicies: [...allowedApprovalPolicies],
    allowedSandboxModes: null,
    allowedWindowsSandboxImplementations: null,
    allowedPermissionProfiles: null,
    defaultPermissions: null,
    allowedWebSearchModes: null,
    allowManagedHooksOnly: null,
    allowAppshots: null,
    allowRemoteControl: null,
    computerUse: null,
    featureRequirements: null,
    enforceResidency: null,
    models: null,
  };
}

function testFeature(name: string, stage: ExperimentalFeature["stage"]): ExperimentalFeature {
  return {
    name,
    stage,
    displayName: null,
    description: null,
    announcement: null,
    enabled: false,
    defaultEnabled: false,
  };
}

function configLayer(name: ConfigLayer["name"], config: Record<string, unknown>): ConfigLayer {
  return {
    name,
    version: "layer-revision-1",
    config: config as JsonValue,
    disabledReason: null,
  };
}

function service(rpc: FakeConfigRpc): CodexConfigService {
  return new CodexConfigService(rpc as unknown as CodexAppServer, "/workspace");
}
