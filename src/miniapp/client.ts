import {
  Banner,
  Button,
  Placeholder,
  Section,
} from "@telegram-apps/telegram-ui/dist/components/Blocks/index.js";
import { Spinner } from "@telegram-apps/telegram-ui/dist/components/Feedback/index.js";
import { Slider } from "@telegram-apps/telegram-ui/dist/components/Form/Slider/Slider.js";
import { Switch } from "@telegram-apps/telegram-ui/dist/components/Form/Switch/Switch.js";
import { AppRoot } from "@telegram-apps/telegram-ui/dist/components/Service/index.js";
import { Caption, Headline } from "@telegram-apps/telegram-ui/dist/components/Typography/index.js";
import {
  type ChangeEvent,
  type FormEvent,
  createElement as h,
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { EditableCodexConfig } from "../codex/config-service.js";
import type { AskForApproval } from "../generated/codex/v2/AskForApproval.js";

interface TelegramWebApp {
  readonly initData: string;
  readonly colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  onEvent(event: "themeChanged", listener: () => void): void;
  offEvent(event: "themeChanged", listener: () => void): void;
  readonly HapticFeedback?: {
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
}

declare global {
  interface Window {
    readonly Telegram?: { readonly WebApp: TelegramWebApp };
  }
}

const featureNames = [
  "apps",
  "goals",
  "hooks",
  "fast_mode",
  "memories",
  "multi_agent",
  "personality",
  "remote_plugin",
  "shell_snapshot",
  "shell_tool",
  "unified_exec",
] as const;

type FeatureName = (typeof featureNames)[number];
type TriState = "" | "false" | "true";
type GranularApprovalPolicy = Extract<AskForApproval, { readonly granular: unknown }>;
type GranularApproval = GranularApprovalPolicy["granular"];
type ClientEditableCodexConfig = Omit<EditableCodexConfig, "approval_policy"> & {
  readonly model_provider: string | null;
  readonly approval_policy: AskForApproval | null;
};

interface ConfigDraft {
  readonly model_provider: string;
  readonly model: string;
  readonly model_reasoning_effort: string;
  readonly model_reasoning_summary: string;
  readonly model_verbosity: string;
  readonly service_tier: string;
  readonly personality: string;
  readonly approval_policy: string;
  readonly approval_granular: GranularApproval;
  readonly approvals_reviewer: string;
  readonly sandbox_mode: string;
  readonly default_permissions: string;
  readonly web_search: string;
  readonly windows_sandbox: string;
  readonly shell_environment_include_only: string;
  readonly features: Readonly<Record<FeatureName, TriState>>;
}

type ScalarDraftKey = Exclude<keyof ConfigDraft, "approval_granular" | "features">;

interface ReasoningEffortCapability {
  readonly reasoningEffort: string;
  readonly description: string;
}

interface ServiceTierCapability {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

interface ModelCapability {
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportedReasoningEfforts: readonly ReasoningEffortCapability[];
  readonly defaultReasoningEffort: string;
  readonly serviceTiers: readonly ServiceTierCapability[];
  readonly defaultServiceTier: string | null;
  readonly isDefault: boolean;
}

interface PermissionProfileCapability {
  readonly id: string;
  readonly description: string | null;
  readonly allowed: boolean;
}

interface ModelProviderCapability {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly allowed: boolean;
}

interface FeatureCapability {
  readonly name: string;
  readonly stage: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly defaultEnabled: boolean;
  readonly locked: boolean;
}

interface ConfigCapabilities {
  readonly platform: string;
  readonly modelProviders: readonly ModelProviderCapability[];
  readonly models: readonly ModelCapability[];
  readonly permissionProfiles: readonly PermissionProfileCapability[];
  readonly features: readonly FeatureCapability[];
  readonly requirements: Readonly<Record<string, unknown>> | null;
}

interface LoadedSnapshot {
  readonly version: string | null;
  readonly values: ClientEditableCodexConfig;
  readonly capabilities: ConfigCapabilities;
  readonly validation: ValidationResult;
  readonly telex: TelexSettings;
  readonly runtime: RuntimeStatus;
  readonly writeOutcome: WriteOutcome | undefined;
}

interface RuntimeComponentStatus {
  readonly state: string;
  readonly message: string | null;
}

interface RuntimeStatus {
  readonly state: string;
  readonly lastAppliedAt: string | null;
  readonly configPath: string | null;
  readonly restartRequired: boolean;
  readonly lastError: string | null;
  readonly config: RuntimeComponentStatus | undefined;
  readonly mcp: RuntimeComponentStatus | undefined;
  readonly skills: RuntimeComponentStatus | undefined;
}

interface TelexSettings {
  readonly remoteClientContext: boolean;
}

interface WriteOutcome {
  readonly status: "ok" | "okOverridden";
  readonly overriddenMetadata: OverrideMetadata | null;
}

interface OverrideMetadata {
  readonly message: string;
  readonly effectiveValue: unknown;
}

interface ValidationIssue {
  readonly path: string;
  readonly severity: "error" | "info" | "warning";
  readonly message: string;
}

interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

interface UiOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

interface FieldProps {
  readonly draftKey: string;
  readonly configPath: string;
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly onChange: (value: string) => void;
}

const emptyCapabilities: ConfigCapabilities = {
  platform: "unknown",
  modelProviders: [],
  models: [],
  permissionProfiles: [],
  features: [],
  requirements: null,
};

const approvalOptions = [
  { value: "untrusted", label: "Only untrusted commands" },
  { value: "on-request", label: "When Codex requests it" },
  { value: "granular", label: "Choose by category" },
  { value: "never", label: "Never ask" },
] as const;

const reviewerOptions = [
  { value: "user", label: "Me" },
  { value: "auto_review", label: "Automatic reviewer" },
] as const;

const sandboxOptions = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Full access" },
] as const;

const searchOptions = [
  { value: "disabled", label: "Disabled" },
  { value: "cached", label: "Cached" },
  { value: "indexed", label: "Indexed" },
  { value: "live", label: "Live" },
] as const;

const summaryOptions = [
  { value: "auto", label: "Automatic" },
  { value: "concise", label: "Concise" },
  { value: "detailed", label: "Detailed" },
  { value: "none", label: "None" },
] as const;

const verbosityOptions = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

const personalityOptions = [
  { value: "none", label: "None" },
  { value: "friendly", label: "Friendly" },
  { value: "pragmatic", label: "Pragmatic" },
] as const;

const windowsSandboxOptions = [
  { value: "elevated", label: "Elevated" },
  { value: "unelevated", label: "Unelevated" },
] as const;

const granularApprovalKeys = [
  "sandbox_approval",
  "rules",
  "skill_approval",
  "request_permissions",
  "mcp_elicitations",
] as const satisfies readonly (keyof GranularApproval)[];

const defaultGranularApproval: GranularApproval = {
  sandbox_approval: true,
  rules: true,
  skill_approval: true,
  request_permissions: true,
  mcp_elicitations: true,
};

const editableKeys = [
  "model_provider",
  "model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "service_tier",
  "personality",
  "approval_policy",
  "approvals_reviewer",
  "sandbox_mode",
  "default_permissions",
  "web_search",
  "windows_sandbox",
  "shell_environment_include_only",
  "features",
] as const satisfies readonly (keyof ClientEditableCodexConfig)[];

const webApp = window.Telegram?.WebApp;

function SettingsApp(): ReactElement {
  const [appearance, setAppearance] = useState<"dark" | "light">(webApp?.colorScheme ?? "light");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<LoadedSnapshot>();
  const [draft, setDraft] = useState<ConfigDraft>();
  const [remoteClientContext, setRemoteClientContext] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [runtimeAction, setRuntimeAction] = useState<"reload" | "restart">();
  const [validation, setValidation] = useState<ValidationResult>({ valid: true, issues: [] });
  const [validating, setValidating] = useState(false);
  const [notice, setNotice] = useState("Settings are up to date.");

  useEffect(() => {
    if (webApp === undefined) return;
    const handleThemeChanged = (): void => setAppearance(webApp.colorScheme);
    webApp.ready();
    webApp.expand();
    webApp.onEvent("themeChanged", handleThemeChanged);
    return () => webApp.offEvent("themeChanged", handleThemeChanged);
  }, []);

  useEffect(() => {
    const requestedAttempt = loadAttempt;
    if (webApp === undefined || webApp.initData.length === 0) {
      setLoadError("Open this settings page from the bot in Telegram.");
      return;
    }
    let active = true;
    setLoadError(undefined);
    void requestSnapshot("GET")
      .then((loaded) => {
        if (!active || requestedAttempt !== loadAttempt) return;
        setSnapshot(loaded);
        setDraft(draftFromConfig(loaded.values));
        setRemoteClientContext(loaded.telex.remoteClientContext);
        setValidation(loaded.validation);
        setNotice("Settings are up to date.");
      })
      .catch((error: unknown) => {
        if (active) setLoadError(messageOf(error));
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const normalizedValues = useMemo(
    () => (draft === undefined ? undefined : configFromDraft(draft)),
    [draft],
  );
  const changes = useMemo(
    () =>
      snapshot === undefined || normalizedValues === undefined
        ? {}
        : changedConfig(snapshot.values, normalizedValues),
    [normalizedValues, snapshot],
  );
  const configDirty = Object.keys(changes).length > 0;
  const remoteClientContextDirty =
    snapshot !== undefined && remoteClientContext !== snapshot.telex.remoteClientContext;
  const dirty = configDirty || remoteClientContextDirty;

  useEffect(() => {
    if (!configDirty || snapshot === undefined) {
      setValidating(false);
      setValidation(snapshot?.validation ?? { valid: true, issues: [] });
      setNotice(dirty ? "Ready to save." : "Settings are up to date.");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setValidating(true);
      void requestValidation(
        { expectedVersion: snapshot.version, values: changes },
        controller.signal,
      )
        .then((result) => {
          setValidation(result);
          setNotice(result.valid ? "Ready to save." : "Fix the highlighted settings.");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof ConfigApiError && error.issues !== undefined) {
            setValidation({ valid: false, issues: error.issues });
            setNotice("Fix the highlighted settings.");
            return;
          }
          setNotice(`Validation unavailable: ${messageOf(error)}`);
        })
        .finally(() => {
          if (!controller.signal.aborted) setValidating(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [changes, configDirty, dirty, snapshot]);

  const updateScalar = (key: ScalarDraftKey, value: string): void => {
    setDraft((current) => (current === undefined ? current : { ...current, [key]: value }));
  };
  const updateModel = (value: string): void => {
    const models = snapshot?.capabilities.models ?? [];
    setDraft((current) => {
      if (current === undefined) return current;
      const model = resolveSelectedModel(value, models);
      const effortSupported =
        current.model_reasoning_effort.length === 0 ||
        model?.supportedReasoningEfforts.some(
          (effort) => effort.reasoningEffort === current.model_reasoning_effort,
        ) === true;
      const tierSupported =
        current.service_tier.length === 0 ||
        model?.serviceTiers.some((tier) => tier.id === current.service_tier) === true;
      return {
        ...current,
        model: value,
        model_reasoning_effort: effortSupported ? current.model_reasoning_effort : "",
        service_tier: tierSupported ? current.service_tier : "",
      };
    });
  };
  const updateGranularApproval = (key: keyof GranularApproval, value: boolean): void => {
    setDraft((current) =>
      current === undefined
        ? current
        : {
            ...current,
            approval_granular: { ...current.approval_granular, [key]: value },
          },
    );
  };
  const updateFeature = (name: FeatureName, value: boolean): void => {
    setDraft((current) =>
      current === undefined
        ? current
        : { ...current, features: { ...current.features, [name]: String(value) as TriState } },
    );
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!dirty || snapshot === undefined || saving || runtimeAction !== undefined) return;
    setSaving(true);
    setNotice("Checking and saving…");
    try {
      const body = {
        expectedVersion: snapshot.version,
        values: changes,
        ...(remoteClientContextDirty ? { telex: { remoteClientContext } } : {}),
      };
      const result = configDirty
        ? await requestValidation({ expectedVersion: snapshot.version, values: changes })
        : { valid: true, issues: [] };
      setValidation(result);
      if (!result.valid) {
        setNotice("Fix the highlighted settings before saving.");
        webApp?.HapticFeedback?.notificationOccurred("warning");
        return;
      }
      const loaded = await requestSnapshot("PUT", body);
      setSnapshot(loaded);
      setDraft(draftFromConfig(loaded.values));
      setRemoteClientContext(loaded.telex.remoteClientContext);
      setValidation(loaded.validation);
      const overridden = loaded.writeOutcome?.status === "okOverridden";
      setNotice(
        overridden
          ? (loaded.writeOutcome?.overriddenMetadata?.message ??
              "Saved, but a higher-priority layer overrides this value.")
          : configDirty
            ? runtimeSaveNotice(loaded.runtime)
            : "Saved.",
      );
      webApp?.HapticFeedback?.notificationOccurred(
        overridden || loaded.runtime.state === "degraded" || loaded.runtime.restartRequired
          ? "warning"
          : "success",
      );
    } catch (error) {
      if (error instanceof ConfigApiError && error.issues !== undefined) {
        setValidation({ valid: false, issues: error.issues });
      }
      setNotice(messageOf(error));
      webApp?.HapticFeedback?.notificationOccurred("error");
    } finally {
      setSaving(false);
    }
  };

  const runRuntimeAction = async (action: "reload" | "restart"): Promise<void> => {
    if (runtimeAction !== undefined || dirty) return;
    setRuntimeAction(action);
    setNotice(action === "reload" ? "Applying Codex changes…" : "Restarting Codex…");
    try {
      const runtime = await requestRuntime(action);
      setSnapshot((current) =>
        current === undefined ? current : { ...current, runtime, writeOutcome: undefined },
      );
      setNotice(runtimeActionNotice(runtime, action));
      webApp?.HapticFeedback?.notificationOccurred(
        runtime.state === "degraded" || runtime.restartRequired ? "warning" : "success",
      );
    } catch (error) {
      setNotice(messageOf(error));
      webApp?.HapticFeedback?.notificationOccurred("error");
    } finally {
      setRuntimeAction(undefined);
    }
  };

  const retry = (): void => setLoadAttempt((attempt) => attempt + 1);
  const content =
    snapshot === undefined || draft === undefined
      ? renderLoading(loadError, retry)
      : renderForm({
          snapshot,
          draft,
          remoteClientContext,
          issues: validation.issues,
          dirty,
          saving,
          validating,
          runtimeAction,
          notice,
          onSave: save,
          onRuntimeAction: runRuntimeAction,
          updateScalar,
          updateModel,
          updateGranularApproval,
          updateFeature,
          updateRemoteClientContext: setRemoteClientContext,
        });

  return h(AppRoot, { appearance, className: "appRoot" }, content);
}

interface FormRenderOptions {
  readonly snapshot: LoadedSnapshot;
  readonly draft: ConfigDraft;
  readonly remoteClientContext: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly validating: boolean;
  readonly runtimeAction: "reload" | "restart" | undefined;
  readonly notice: string;
  readonly onSave: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onRuntimeAction: (action: "reload" | "restart") => Promise<void>;
  readonly updateScalar: (key: ScalarDraftKey, value: string) => void;
  readonly updateModel: (value: string) => void;
  readonly updateGranularApproval: (key: keyof GranularApproval, value: boolean) => void;
  readonly updateFeature: (name: FeatureName, value: boolean) => void;
  readonly updateRemoteClientContext: (value: boolean) => void;
}

function renderForm(options: FormRenderOptions): ReactElement {
  const { snapshot, draft, issues, updateScalar } = options;
  const capabilities = snapshot.capabilities;
  const requirements = capabilities.requirements;
  const selectedModel = resolveSelectedModel(draft.model, capabilities.models);
  const models = capabilities.models.map((model) => ({
    value: model.model,
    label: model.displayName,
  }));
  const serviceTiers =
    selectedModel?.serviceTiers.map((tier) => ({ value: tier.id, label: tier.name })) ?? [];
  const serviceTierOptions = [{ value: "", label: "Standard" }, ...serviceTiers];
  const allowedApprovalPolicies = approvalModeSet(requirements?.allowedApprovalPolicies);
  const allowedSandboxModes = stringSet(requirements?.allowedSandboxModes);
  const allowedSearchModes = stringSet(requirements?.allowedWebSearchModes);
  const allowedWindowsSandboxes = stringSet(requirements?.allowedWindowsSandboxImplementations);
  const issueSummary = renderIssueSummary(issues);

  const runtime = snapshot.runtime;
  const runtimeComponents = [
    ["Config", runtime.config],
    ["MCP", runtime.mcp],
    ["Skills", runtime.skills],
  ] as const;
  const runtimeDetail =
    runtime.lastError ??
    runtimeComponents
      .map(([label, component]) =>
        component?.message === null || component?.message === undefined
          ? undefined
          : `${label}: ${component.message}`,
      )
      .filter(isDefined)
      .join(" · ");
  const runtimeControlsDisabled = options.dirty || options.runtimeAction !== undefined;
  const runtimeSection = h(
    Section,
    {
      header: "Codex runtime",
      footer: options.dirty
        ? "Save the draft before applying it to Codex."
        : "Reload uses Codex's native config, MCP, and skill refresh APIs. MCP changes become active on the next turn.",
    },
    h(
      "div",
      { className: "runtimePanel" },
      h(
        "div",
        { className: "runtimeSummary" },
        h("span", {
          className: `runtimeDot runtimeDot-${runtime.restartRequired ? "degraded" : runtime.state}`,
          "aria-hidden": "true",
        }),
        h(
          "div",
          { className: "runtimeCopy" },
          h("strong", null, runtimeStateLabel(runtime)),
          h(
            Caption,
            { className: "runtimeDetail" },
            runtimeDetail.length > 0
              ? runtimeDetail
              : runtime.configPath === null
                ? "Runtime configuration is loaded."
                : `Watching ${runtime.configPath}`,
          ),
        ),
      ),
      h(
        "div",
        { className: "runtimeActions" },
        h(
          Button,
          {
            type: "button",
            mode: "bezeled",
            size: "s",
            loading: options.runtimeAction === "reload",
            disabled: runtimeControlsDisabled,
            onClick: () => void options.onRuntimeAction("reload"),
          },
          "Apply changes",
        ),
        h(
          Button,
          {
            type: "button",
            mode: "bezeled",
            size: "s",
            loading: options.runtimeAction === "restart",
            disabled: runtimeControlsDisabled,
            onClick: () => void options.onRuntimeAction("restart"),
          },
          "Restart Codex",
        ),
      ),
    ),
  );

  const telexSection = h(
    Section,
    {
      header: "Remote connection",
      footer: "Enabled by default; Telex detects the current connector for each turn.",
    },
    toggleField({
      draftKey: "telex.remoteClientContext",
      configPath: "telex.remoteClientContext",
      label: "Remote session context",
      description:
        "Tell Codex that you are connected remotely, so it avoids host-local UI and localhost handoffs.",
      checked: options.remoteClientContext,
      disabled: false,
      issues: [],
      fieldId: "telex-remote-client-context",
      onChange: options.updateRemoteClientContext,
    }),
  );

  const modelField = selectField({
    draftKey: "model",
    configPath: "model",
    label: "Model",
    description: selectedModel?.description ?? "The model Codex uses for new conversations.",
    value: selectedModel?.model ?? draft.model,
    disabled: models.length === 0,
    issues,
    options: withCurrent(models, draft.model),
    onChange: options.updateModel,
  });

  const effortField = reasoningSliderField(
    selectedModel,
    draft.model_reasoning_effort,
    issues,
    (value) => updateScalar("model_reasoning_effort", value),
  );

  const modelSection = h(
    Section,
    { header: "Model", footer: "Options follow the selected model's live capabilities." },
    modelField,
    effortField,
    ...(serviceTiers.length === 0
      ? []
      : [
          selectField({
            draftKey: "service_tier",
            configPath: "service_tier",
            label: "Service tier",
            description: serviceTierDescription(selectedModel, draft.service_tier),
            value: draft.service_tier || selectedModel?.defaultServiceTier || "",
            disabled: false,
            issues,
            options: withCurrent(serviceTierOptions, draft.service_tier),
            onChange: (value) => updateScalar("service_tier", value),
          }),
        ]),
    selectField({
      draftKey: "personality",
      configPath: "personality",
      label: "Personality",
      description: "The conversational style Codex should use.",
      value: draft.personality || "pragmatic",
      disabled: false,
      issues,
      options: [...personalityOptions],
      onChange: (value) => updateScalar("personality", value),
    }),
    selectField({
      draftKey: "model_reasoning_summary",
      configPath: "model_reasoning_summary",
      label: "Reasoning summary",
      description: "How Codex summarizes its reasoning progress.",
      value: draft.model_reasoning_summary || "auto",
      disabled: false,
      issues,
      options: [...summaryOptions],
      onChange: (value) => updateScalar("model_reasoning_summary", value),
    }),
    selectField({
      draftKey: "model_verbosity",
      configPath: "model_verbosity",
      label: "Verbosity",
      description: "The preferred level of detail in answers.",
      value: draft.model_verbosity || "medium",
      disabled: false,
      issues,
      options: [...verbosityOptions],
      onChange: (value) => updateScalar("model_verbosity", value),
    }),
  );

  const permissionOptions = capabilities.permissionProfiles.map((profile) => ({
    value: profile.id,
    label: sentenceCase(profile.id),
    disabled: !profile.allowed,
  }));
  const accessSection = h(
    Section,
    { header: "Access & approvals", footer: "Managed requirements appear disabled." },
    selectField({
      draftKey: "default_permissions",
      configPath: "default_permissions",
      label: "Permission profile",
      description: permissionDescription(
        capabilities.permissionProfiles,
        draft.default_permissions,
      ),
      value: draft.default_permissions,
      disabled: permissionOptions.length === 0,
      issues,
      options: [
        { value: "", label: "Direct sandbox settings" },
        ...withCurrent(permissionOptions, draft.default_permissions),
      ],
      onChange: (value) => {
        updateScalar("default_permissions", value);
        if (value.length > 0) updateScalar("sandbox_mode", "");
      },
    }),
    selectField({
      draftKey: "approval_policy",
      configPath: "approval_policy",
      label: "Approval policy",
      description: "When Codex pauses and asks before taking an action.",
      value: draft.approval_policy || "on-request",
      disabled: false,
      issues,
      options: constrainOptions(approvalOptions, allowedApprovalPolicies),
      onChange: (value) => updateScalar("approval_policy", value),
    }),
    ...(draft.approval_policy === "granular"
      ? granularApprovalFields(draft.approval_granular, issues, options.updateGranularApproval)
      : []),
    selectField({
      draftKey: "approvals_reviewer",
      configPath: "approvals_reviewer",
      label: "Approval reviewer",
      description: "Choose who reviews approval requests.",
      value: draft.approvals_reviewer || "user",
      disabled: false,
      issues,
      options: [...reviewerOptions],
      onChange: (value) => updateScalar("approvals_reviewer", value),
    }),
    selectField({
      draftKey: "sandbox_mode",
      configPath: "sandbox_mode",
      label: "Sandbox",
      description: "Filesystem access granted to Codex commands.",
      value: draft.sandbox_mode || "workspace-write",
      disabled: false,
      issues,
      options: constrainOptions(sandboxOptions, allowedSandboxModes),
      onChange: (value) => {
        updateScalar("sandbox_mode", value);
        if (value.length > 0) updateScalar("default_permissions", "");
      },
    }),
    selectField({
      draftKey: "web_search",
      configPath: "web_search",
      label: "Web search",
      description: "How Codex retrieves information from the internet.",
      value: draft.web_search || "live",
      disabled: false,
      issues,
      options: constrainOptions(searchOptions, allowedSearchModes),
      onChange: (value) => updateScalar("web_search", value),
    }),
    ...(isWindows(capabilities.platform)
      ? [
          selectField({
            draftKey: "windows_sandbox",
            configPath: "windows.sandbox",
            label: "Windows sandbox",
            description: "How Windows sandbox setup is launched.",
            value: draft.windows_sandbox,
            disabled: false,
            issues,
            options: constrainOptions(windowsSandboxOptions, allowedWindowsSandboxes),
            onChange: (value) => updateScalar("windows_sandbox", value),
          }),
        ]
      : []),
  );

  const environmentSection = h(
    Section,
    { header: "Environment", footer: "One environment variable pattern per line." },
    listField({
      draftKey: "shell_environment_include_only",
      configPath: "shell_environment_policy.include_only",
      label: "Shell environment allowlist",
      description: "Only these environment variables are passed to commands.",
      value: draft.shell_environment_include_only,
      disabled: false,
      issues,
      onChange: (value) => updateScalar("shell_environment_include_only", value),
    }),
  );

  const featureRequirements = recordValue(requirements?.featureRequirements);
  const visibleFeatures = capabilities.features.filter(
    (feature): feature is FeatureCapability & { readonly name: FeatureName } =>
      isFeatureName(feature.name),
  );
  const featureSection =
    visibleFeatures.length === 0
      ? undefined
      : h(
          Section,
          {
            header: "Features",
            footer: "Availability and current state come directly from Codex.",
          },
          ...visibleFeatures.map((capability) => {
            const name = capability.name;
            const requiredValue = booleanValue(featureRequirements?.[name]);
            const locked = capability.locked || requiredValue !== undefined;
            const effective = requiredValue ?? capability.enabled;
            const description = [
              capability.description,
              locked && effective !== undefined
                ? `Managed: ${effective ? "on" : "off"}.`
                : undefined,
              `Stage: ${sentenceCase(capability.stage)}.`,
            ]
              .filter((part): part is string => part !== undefined)
              .join(" ");
            const checked =
              draft.features[name] === "" ? effective : draft.features[name] === "true";
            return toggleField({
              draftKey: `features.${name}`,
              configPath: `features.${name}`,
              label: capability.displayName ?? sentenceCase(name),
              description,
              checked,
              disabled: locked,
              issues,
              onChange: (value) => options.updateFeature(name, value),
              fieldId: `feature-${name}`,
            });
          }),
        );

  const dangerous =
    draft.sandbox_mode === "danger-full-access" && draft.approval_policy === "never"
      ? h(Banner, {
          type: "section",
          className: "bannerSpacing",
          header: "Unrestricted autonomous access",
          subheader: "Full access with approvals disabled lets Codex run without confirmation.",
        })
      : undefined;
  const catalogWarning =
    models.length === 0
      ? h(
          Banner,
          {
            type: "section",
            className: "bannerSpacing",
            header: "Model catalog unavailable",
            subheader: "Model settings are read-only until Codex returns its model capabilities.",
          },
          h(
            Button,
            {
              type: "button",
              mode: "bezeled",
              size: "s",
              onClick: () => window.location.reload(),
            },
            "Retry",
          ),
        )
      : undefined;
  const overrideMetadata = snapshot.writeOutcome?.overriddenMetadata;
  const overrideBanner =
    snapshot.writeOutcome?.status === "okOverridden"
      ? h(Banner, {
          type: "section",
          className: "bannerSpacing",
          header: "Saved, but not currently effective",
          subheader:
            overrideMetadata === null || overrideMetadata === undefined
              ? "A higher-priority configuration layer overrides the saved value."
              : `${overrideMetadata.message} Effective value: ${displayValue(overrideMetadata.effectiveValue)}.`,
        })
      : undefined;

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const saveDisabled =
    !options.dirty ||
    options.saving ||
    options.validating ||
    options.runtimeAction !== undefined ||
    errorCount > 0;
  const saveText = !options.dirty
    ? "Up to date"
    : errorCount > 0
      ? "Fix validation issues"
      : "Save changes";

  return h(
    "form",
    { onSubmit: (event: FormEvent<HTMLFormElement>) => void options.onSave(event) },
    h(
      "main",
      { className: "page" },
      h(
        "header",
        { className: "pageHeader" },
        h(
          "div",
          null,
          h(Headline, { Component: "h1" }, "Telex settings"),
          h(Caption, { className: "pageSubtitle" }, "Bridge behavior and Codex configuration"),
        ),
        h(
          Caption,
          { className: "revision" },
          snapshot.version === null ? "new file" : `rev ${snapshot.version.slice(0, 8)}`,
        ),
      ),
      issueSummary,
      overrideBanner,
      catalogWarning,
      dangerous,
      h(
        "div",
        { className: "sectionStack" },
        runtimeSection,
        telexSection,
        modelSection,
        accessSection,
        environmentSection,
        featureSection,
      ),
    ),
    h(
      "div",
      { className: "saveDock" },
      h(
        "div",
        { className: "saveDockInner" },
        h(
          Caption,
          {
            className: `saveStatus ${errorCount > 0 ? "saveStatusError" : options.dirty ? "saveStatusReady" : ""}`,
            "aria-live": "polite",
          },
          options.validating ? "Checking settings…" : options.notice,
        ),
        h(
          Button,
          {
            type: "submit",
            size: "l",
            stretched: true,
            loading: options.saving,
            disabled: saveDisabled,
          },
          saveText,
        ),
      ),
    ),
  );
}

function listField(props: FieldProps): ReactElement {
  const issue = primaryIssue(props.issues, props.configPath, props.draftKey);
  return h(
    "div",
    { className: "field", key: props.configPath },
    h(
      Caption,
      { Component: "label", className: "controlLabel", htmlFor: `config-${props.draftKey}` },
      props.label,
    ),
    h("textarea", {
      id: `config-${props.draftKey}`,
      className: `nativeControl nativeTextarea ${issue?.severity === "error" ? "nativeControlError" : ""}`,
      value: props.value,
      rows: 3,
      placeholder: "Leave empty to pass the full environment",
      disabled: props.disabled,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
        props.onChange(event.currentTarget.value),
    }),
    h(
      Caption,
      { className: issue === undefined ? "fieldHint" : "fieldHint fieldIssue" },
      issue?.message ?? props.description,
    ),
  );
}

function granularApprovalFields(
  value: GranularApproval,
  issues: readonly ValidationIssue[],
  onChange: (key: keyof GranularApproval, value: boolean) => void,
): ReactElement[] {
  const definitions = [
    ["sandbox_approval", "Sandbox escalation", "Commands that need broader sandbox access."],
    ["rules", "Rules", "Actions governed by configured execution rules."],
    ["skill_approval", "Skills", "Skill actions that require explicit review."],
    ["request_permissions", "Permission requests", "Requests for additional permissions."],
    ["mcp_elicitations", "MCP elicitations", "Interactive requests initiated by MCP servers."],
  ] as const satisfies readonly (readonly [keyof GranularApproval, string, string])[];
  return definitions.map(([key, label, description]) =>
    toggleField({
      draftKey: `approval_policy.granular.${key}`,
      configPath: `approval_policy.granular.${key}`,
      label,
      description,
      checked: value[key],
      disabled: false,
      issues,
      fieldId: `approval-granular-${key}`,
      onChange: (next) => onChange(key, next),
    }),
  );
}

function reasoningSliderField(
  model: ModelCapability | undefined,
  value: string,
  issues: readonly ValidationIssue[],
  onChange: (value: string) => void,
): ReactElement {
  const efforts = model?.supportedReasoningEfforts ?? [];
  const effectiveValue =
    efforts.find((effort) => effort.reasoningEffort === value)?.reasoningEffort ??
    model?.defaultReasoningEffort ??
    efforts[0]?.reasoningEffort ??
    "";
  const selectedIndex = Math.max(
    0,
    efforts.findIndex((effort) => effort.reasoningEffort === effectiveValue),
  );
  const issue = primaryIssue(issues, "model_reasoning_effort", "model_reasoning_effort");
  const description = reasoningDescription(model, effectiveValue);
  return h(
    "div",
    { className: "field reasoningField", key: "model_reasoning_effort" },
    h(
      "div",
      { className: "reasoningHeader" },
      h(Caption, { className: "controlLabel" }, "Reasoning effort"),
      h(
        Caption,
        { className: "reasoningValue", "aria-live": "polite" },
        sentenceCase(effectiveValue),
      ),
    ),
    h(Slider, {
      className: "reasoningSlider",
      min: 0,
      max: Math.max(0, efforts.length - 1),
      step: 1,
      value: selectedIndex,
      disabled: efforts.length < 2,
      getAriaLabel: () => "Reasoning effort",
      getAriaValueText: (index: number) =>
        sentenceCase(efforts[Math.round(index)]?.reasoningEffort ?? effectiveValue),
      onChange: (index: number) => {
        const effort = efforts[Math.round(index)];
        if (effort !== undefined) onChange(effort.reasoningEffort);
      },
    }),
    h(
      "div",
      { className: "reasoningTicks", "aria-hidden": true },
      ...efforts.map((effort, index) =>
        h(
          "span",
          {
            key: effort.reasoningEffort,
            className: `reasoningTick ${index === selectedIndex ? "reasoningTickActive" : ""}`,
            style: {
              left: `${efforts.length < 2 ? 50 : (index / (efforts.length - 1)) * 100}%`,
            },
          },
          sentenceCase(effort.reasoningEffort),
        ),
      ),
    ),
    h(
      Caption,
      { className: issue === undefined ? "fieldHint" : "fieldHint fieldIssue" },
      issue?.message ?? description,
    ),
  );
}

function toggleField(props: {
  readonly draftKey: string;
  readonly configPath: string;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly fieldId: string;
  readonly onChange: (value: boolean) => void;
}): ReactElement {
  const issue = primaryIssue(props.issues, props.configPath, props.draftKey);
  return h(
    "div",
    { className: "toggleField", key: props.configPath },
    h(
      "label",
      { className: "toggleCopy", htmlFor: props.fieldId },
      h(Caption, { className: "toggleLabel" }, props.label),
      h(
        Caption,
        { className: issue === undefined ? "toggleHint" : "toggleHint fieldIssue" },
        issue?.message ?? props.description,
      ),
    ),
    h(Switch, {
      id: props.fieldId,
      checked: props.checked,
      disabled: props.disabled,
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        props.onChange(event.currentTarget.checked),
      "aria-label": props.label,
    }),
  );
}

function selectField(
  props: FieldProps & {
    readonly options: readonly UiOption[];
    readonly fieldId?: string;
  },
): ReactElement {
  const issue = primaryIssue(props.issues, props.configPath, props.draftKey);
  const fieldId = props.fieldId ?? `config-${props.draftKey}`;
  return h(
    "div",
    { className: "field", key: props.configPath },
    h(Caption, { Component: "label", className: "controlLabel", htmlFor: fieldId }, props.label),
    h(
      "select",
      {
        id: fieldId,
        className: `nativeControl nativeSelect ${issue?.severity === "error" ? "nativeControlError" : ""}`,
        value: props.value,
        disabled: props.disabled,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          props.onChange(event.currentTarget.value),
      },
      ...props.options.map((option) =>
        h(
          "option",
          {
            key: option.value || "explicit-default",
            value: option.value,
            disabled: option.disabled,
          },
          option.label,
        ),
      ),
    ),
    h(
      Caption,
      { className: issue === undefined ? "fieldHint" : "fieldHint fieldIssue" },
      issue?.message ?? props.description,
    ),
  );
}

function renderLoading(error: string | undefined, retry: () => void): ReactElement {
  if (error !== undefined) {
    return h(
      "div",
      { className: "loadingRoot" },
      h(Placeholder, {
        header: "Couldn’t open settings",
        description: error,
        action: h(Button, { mode: "filled", onClick: retry }, "Try again"),
      }),
    );
  }
  return h(
    "div",
    { className: "loadingRoot" },
    h(
      Placeholder,
      {
        header: "Loading Codex settings",
        description: "Reading the effective config and capabilities…",
      },
      h(Spinner, { size: "l" }),
    ),
  );
}

function renderIssueSummary(issues: readonly ValidationIssue[]): ReactElement | undefined {
  if (issues.length === 0) return undefined;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const visible = [...errors, ...warnings].slice(0, 3);
  return h(Banner, {
    type: "section",
    className: "bannerSpacing",
    header:
      errors.length > 0
        ? `${errors.length} setting${errors.length === 1 ? " needs" : "s need"} attention`
        : `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
    subheader: visible.map((issue) => issue.message).join(" · "),
  });
}

function draftFromConfig(values: ClientEditableCodexConfig): ConfigDraft {
  const granularApproval = granularApprovalValue(values.approval_policy);
  return {
    model_provider: values.model_provider ?? "",
    model: values.model ?? "",
    model_reasoning_effort: values.model_reasoning_effort ?? "",
    model_reasoning_summary: values.model_reasoning_summary ?? "",
    model_verbosity: values.model_verbosity ?? "",
    service_tier: values.service_tier ?? "",
    personality: values.personality ?? "",
    approval_policy:
      granularApproval === undefined && typeof values.approval_policy === "string"
        ? values.approval_policy
        : granularApproval === undefined
          ? ""
          : "granular",
    approval_granular: granularApproval ?? defaultGranularApproval,
    approvals_reviewer: values.approvals_reviewer ?? "",
    sandbox_mode: values.sandbox_mode ?? "",
    default_permissions: values.default_permissions ?? "",
    web_search: values.web_search ?? "",
    windows_sandbox: values.windows_sandbox ?? "",
    shell_environment_include_only: linesFromConfig(values.shell_environment_include_only),
    features: Object.fromEntries(
      featureNames.map((name) => [name, triStateFromConfig(values.features[name])]),
    ) as Record<FeatureName, TriState>,
  };
}

function configFromDraft(draft: ConfigDraft): ClientEditableCodexConfig {
  return {
    model_provider: nullable(draft.model_provider),
    model: nullable(draft.model),
    model_reasoning_effort: nullable(draft.model_reasoning_effort),
    model_reasoning_summary: enumOrNull(draft.model_reasoning_summary, [
      "auto",
      "concise",
      "detailed",
      "none",
    ]),
    model_verbosity: enumOrNull(draft.model_verbosity, ["low", "medium", "high"]),
    service_tier: nullable(draft.service_tier),
    personality: enumOrNull(draft.personality, ["none", "friendly", "pragmatic"]),
    approval_policy:
      draft.approval_policy === "granular"
        ? { granular: { ...draft.approval_granular } }
        : enumOrNull(draft.approval_policy, ["untrusted", "on-request", "never"]),
    approvals_reviewer: enumOrNull(draft.approvals_reviewer, ["user", "auto_review"]),
    sandbox_mode: enumOrNull(draft.sandbox_mode, [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]),
    default_permissions: nullable(draft.default_permissions),
    web_search: enumOrNull(draft.web_search, ["disabled", "cached", "indexed", "live"]),
    windows_sandbox: enumOrNull(draft.windows_sandbox, ["elevated", "unelevated"]),
    shell_environment_include_only: linesToConfig(draft.shell_environment_include_only),
    features: Object.fromEntries(
      featureNames.map((name) => [name, triStateToConfig(draft.features[name])]),
    ) as Record<FeatureName, boolean | null>,
  };
}

function changedConfig(
  current: ClientEditableCodexConfig,
  candidate: ClientEditableCodexConfig,
): Partial<ClientEditableCodexConfig> {
  const changed: Partial<ClientEditableCodexConfig> = {};
  const target = changed as Record<string, unknown>;
  const currentValues = current as Readonly<Record<string, unknown>>;
  const candidateValues = candidate as Readonly<Record<string, unknown>>;
  for (const key of editableKeys) {
    if (JSON.stringify(currentValues[key]) !== JSON.stringify(candidateValues[key])) {
      target[key] = candidateValues[key];
    }
  }
  return changed;
}

async function requestSnapshot(
  method: "GET" | "PUT",
  body?: Readonly<{
    expectedVersion: string | null;
    values: Partial<ClientEditableCodexConfig>;
    telex?: TelexSettings;
  }>,
): Promise<LoadedSnapshot> {
  const value = await requestJson("/api/config", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return parseSnapshot(value);
}

async function requestValidation(
  body: Readonly<{
    expectedVersion: string | null;
    values: Partial<ClientEditableCodexConfig>;
  }>,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  const value = await requestJson("/api/config/validate", {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  return parseValidation(value);
}

async function requestRuntime(action: "reload" | "restart"): Promise<RuntimeStatus> {
  const value = await requestJson(`/api/runtime/${action}`, { method: "POST" });
  const runtime = parseRuntimeStatus(recordValue(value)?.runtime);
  if (runtime === undefined) throw new Error("The bridge returned an invalid runtime response.");
  return runtime;
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  const initData = webApp?.initData;
  if (initData === undefined || initData.length === 0) {
    throw new Error("Telegram authorization is unavailable.");
  }
  const hasBody = init.body !== undefined;
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `tma ${initData}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    throw new ConfigApiError(
      apiError(value) ?? `Request failed (${response.status}).`,
      validationIssues(value),
    );
  }
  return value;
}

function parseSnapshot(value: unknown): LoadedSnapshot {
  const outerRecord = recordValue(value);
  const record = recordValue(outerRecord?.snapshot) ?? outerRecord;
  const telex = recordValue(record?.telex);
  const runtime = parseRuntimeStatus(outerRecord?.runtime ?? record?.runtime);
  if (
    record === undefined ||
    !(typeof record.version === "string" || record.version === null) ||
    !isEditableConfig(record.values) ||
    typeof telex?.remoteClientContext !== "boolean" ||
    runtime === undefined
  ) {
    throw new Error("The bridge returned an invalid config response.");
  }
  return {
    version: record.version,
    values: record.values,
    capabilities: parseCapabilities(record.capabilities) ?? emptyCapabilities,
    validation: parseValidationIfPresent(record.validation) ?? {
      valid: true,
      issues: [],
    },
    telex: { remoteClientContext: telex.remoteClientContext },
    runtime,
    writeOutcome: parseWriteOutcome(outerRecord?.writeOutcome ?? record.writeOutcome),
  };
}

function parseRuntimeStatus(value: unknown): RuntimeStatus | undefined {
  const record = recordValue(value);
  if (record === undefined || typeof record.state !== "string") return undefined;
  return {
    state: record.state,
    lastAppliedAt: typeof record.lastAppliedAt === "string" ? record.lastAppliedAt : null,
    configPath: typeof record.configPath === "string" ? record.configPath : null,
    restartRequired: record.restartRequired === true,
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    config: parseRuntimeComponent(record.config),
    mcp: parseRuntimeComponent(record.mcp),
    skills: parseRuntimeComponent(record.skills),
  };
}

function parseRuntimeComponent(value: unknown): RuntimeComponentStatus | undefined {
  const record = recordValue(value);
  if (record === undefined || typeof record.state !== "string") return undefined;
  return {
    state: record.state,
    message: typeof record.message === "string" ? record.message : null,
  };
}

function parseWriteOutcome(value: unknown): WriteOutcome | undefined {
  const record = recordValue(value);
  if (record === undefined || (record.status !== "ok" && record.status !== "okOverridden")) {
    return undefined;
  }
  const metadata = recordValue(record.overriddenMetadata);
  const overriddenMetadata =
    metadata !== undefined && typeof metadata.message === "string"
      ? { message: metadata.message, effectiveValue: metadata.effectiveValue }
      : null;
  return { status: record.status, overriddenMetadata };
}

function parseValidation(value: unknown): ValidationResult {
  const record = recordValue(value);
  if (record === undefined || typeof record.valid !== "boolean" || !Array.isArray(record.issues)) {
    throw new Error("The bridge returned an invalid validation response.");
  }
  const issues = record.issues.map(parseIssue);
  if (issues.some((issue) => issue === undefined)) {
    throw new Error("The bridge returned an invalid validation issue.");
  }
  return { valid: record.valid, issues: issues as ValidationIssue[] };
}

function parseValidationIfPresent(value: unknown): ValidationResult | undefined {
  if (value === undefined) return undefined;
  try {
    return parseValidation(value);
  } catch {
    return undefined;
  }
}

function validationIssues(value: unknown): readonly ValidationIssue[] | undefined {
  const issues = arrayValue(recordValue(value)?.issues);
  if (issues === undefined) return undefined;
  const parsed = issues.map(parseIssue);
  return parsed.every(isDefined) ? parsed : undefined;
}

function parseIssue(value: unknown): ValidationIssue | undefined {
  const record = recordValue(value);
  if (record === undefined || typeof record.message !== "string") return undefined;
  const path = Array.isArray(record.path)
    ? record.path.filter((part): part is string => typeof part === "string").join(".")
    : typeof record.path === "string"
      ? record.path
      : "";
  const severity =
    record.severity === "warning" || record.severity === "info" ? record.severity : "error";
  return { path, severity, message: record.message };
}

function parseCapabilities(value: unknown): ConfigCapabilities | undefined {
  const record = recordValue(value);
  if (record === undefined) return undefined;
  const models = arrayValue(record.models)?.map(parseModel).filter(isDefined) ?? [];
  const modelProviders =
    arrayValue(record.modelProviders)?.map(parseModelProvider).filter(isDefined) ?? [];
  const permissionProfiles =
    arrayValue(record.permissionProfiles)?.map(parsePermissionProfile).filter(isDefined) ?? [];
  const features = arrayValue(record.features)?.map(parseFeature).filter(isDefined) ?? [];
  return {
    platform: typeof record.platform === "string" ? record.platform : "unknown",
    modelProviders,
    models,
    permissionProfiles,
    features,
    requirements: recordValue(record.requirements) ?? null,
  };
}

function parseModelProvider(value: unknown): ModelProviderCapability | undefined {
  const record = recordValue(value);
  return record !== undefined &&
    typeof record.id === "string" &&
    typeof record.displayName === "string" &&
    typeof record.description === "string" &&
    typeof record.allowed === "boolean"
    ? {
        id: record.id,
        displayName: record.displayName,
        description: record.description,
        allowed: record.allowed,
      }
    : undefined;
}

function parseModel(value: unknown): ModelCapability | undefined {
  const record = recordValue(value);
  if (
    record === undefined ||
    typeof record.model !== "string" ||
    typeof record.displayName !== "string" ||
    typeof record.description !== "string" ||
    typeof record.defaultReasoningEffort !== "string" ||
    typeof record.isDefault !== "boolean"
  ) {
    return undefined;
  }
  return {
    model: record.model,
    displayName: record.displayName,
    description: record.description,
    supportedReasoningEfforts:
      arrayValue(record.supportedReasoningEfforts)?.map(parseReasoningEffort).filter(isDefined) ??
      [],
    defaultReasoningEffort: record.defaultReasoningEffort,
    serviceTiers: arrayValue(record.serviceTiers)?.map(parseServiceTier).filter(isDefined) ?? [],
    defaultServiceTier:
      typeof record.defaultServiceTier === "string" ? record.defaultServiceTier : null,
    isDefault: record.isDefault,
  };
}

function parseReasoningEffort(value: unknown): ReasoningEffortCapability | undefined {
  const record = recordValue(value);
  return record !== undefined &&
    typeof record.reasoningEffort === "string" &&
    typeof record.description === "string"
    ? { reasoningEffort: record.reasoningEffort, description: record.description }
    : undefined;
}

function parseServiceTier(value: unknown): ServiceTierCapability | undefined {
  const record = recordValue(value);
  return record !== undefined &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.description === "string"
    ? { id: record.id, name: record.name, description: record.description }
    : undefined;
}

function parsePermissionProfile(value: unknown): PermissionProfileCapability | undefined {
  const record = recordValue(value);
  return record !== undefined &&
    typeof record.id === "string" &&
    (typeof record.description === "string" || record.description === null) &&
    typeof record.allowed === "boolean"
    ? { id: record.id, description: record.description, allowed: record.allowed }
    : undefined;
}

function parseFeature(value: unknown): FeatureCapability | undefined {
  const record = recordValue(value);
  if (
    record === undefined ||
    typeof record.name !== "string" ||
    typeof record.stage !== "string" ||
    !(typeof record.displayName === "string" || record.displayName === null) ||
    !(typeof record.description === "string" || record.description === null) ||
    typeof record.enabled !== "boolean" ||
    typeof record.defaultEnabled !== "boolean"
  ) {
    return undefined;
  }
  return {
    name: record.name,
    stage: record.stage,
    displayName: record.displayName,
    description: record.description,
    enabled: record.enabled,
    defaultEnabled: record.defaultEnabled,
    locked: record.locked === true,
  };
}

function isEditableConfig(value: unknown): value is ClientEditableCodexConfig {
  const record = recordValue(value);
  if (record === undefined) return false;
  const listKeys = new Set<string>(["shell_environment_include_only"]);
  const nullableStringKeys = editableKeys.filter(
    (key) => key !== "approval_policy" && key !== "features" && !listKeys.has(key),
  );
  if (
    nullableStringKeys.some((key) => !(typeof record[key] === "string" || record[key] === null))
  ) {
    return false;
  }
  if (!isApprovalPolicy(record.approval_policy)) return false;
  for (const key of ["shell_environment_include_only"]) {
    const field = record[key];
    if (
      !(field === null || (Array.isArray(field) && field.every((item) => typeof item === "string")))
    ) {
      return false;
    }
  }
  const features = recordValue(record.features);
  return (
    features !== undefined &&
    featureNames.every((name) =>
      features[name] === null ? true : typeof features[name] === "boolean",
    )
  );
}

function resolveSelectedModel(
  model: string,
  models: readonly ModelCapability[],
): ModelCapability | undefined {
  return model.length === 0
    ? (models.find((candidate) => candidate.isDefault) ?? models[0])
    : models.find((candidate) => candidate.model === model);
}

function reasoningDescription(model: ModelCapability | undefined, effort: string): string {
  if (model === undefined) return "How much reasoning the model should use.";
  const selected = model.supportedReasoningEfforts.find(
    (option) => option.reasoningEffort === effort,
  );
  return selected?.description ?? "How much reasoning the selected model should use.";
}

function serviceTierDescription(model: ModelCapability | undefined, tier: string): string {
  if (tier.length === 0) return "Standard speed and credit usage.";
  const selected = model?.serviceTiers.find((option) => option.id === tier);
  return selected?.description ?? "The selected model's latency and capacity tier.";
}

function permissionDescription(
  profiles: readonly PermissionProfileCapability[],
  selected: string,
): string {
  return (
    profiles.find((profile) => profile.id === selected)?.description ??
    "A bundled or custom permission profile for Codex tools."
  );
}

function withCurrent(options: readonly UiOption[], current: string): UiOption[] {
  if (current.length === 0 || options.some((option) => option.value === current))
    return [...options];
  return [{ value: current, label: `${sentenceCase(current)} (current)` }, ...options];
}

function constrainOptions(
  options: readonly UiOption[],
  allowed: ReadonlySet<string> | undefined,
): UiOption[] {
  return options.map((option) => ({
    ...option,
    ...(allowed === undefined ? {} : { disabled: !allowed.has(option.value) }),
  }));
}

function primaryIssue(
  issues: readonly ValidationIssue[],
  configPath: string,
  draftKey: string,
): ValidationIssue | undefined {
  return issues.find(
    (issue) =>
      issue.path === configPath ||
      issue.path === draftKey ||
      issue.path.endsWith(`.${configPath}`) ||
      issue.path.endsWith(`.${draftKey}`),
  );
}

function linesFromConfig(value: readonly string[] | null): string {
  return value?.join("\n") ?? "";
}

function linesToConfig(value: string): string[] | null {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 0 ? null : lines;
}

function triStateFromConfig(value: boolean | null): TriState {
  return value === null ? "" : (String(value) as TriState);
}

function triStateToConfig(value: TriState): boolean | null {
  return value === "" ? null : value === "true";
}

function isFeatureName(value: string): value is FeatureName {
  return (featureNames as readonly string[]).includes(value);
}

function granularApprovalValue(value: unknown): GranularApproval | undefined {
  const policy = recordValue(value);
  if (policy === undefined || Object.keys(policy).length !== 1) return undefined;
  const granular = recordValue(policy.granular);
  if (
    granular === undefined ||
    Object.keys(granular).length !== granularApprovalKeys.length ||
    Object.keys(granular).some((key) => !(granularApprovalKeys as readonly string[]).includes(key))
  ) {
    return undefined;
  }

  const sandboxApproval = booleanValue(granular.sandbox_approval);
  const rules = booleanValue(granular.rules);
  const skillApproval = booleanValue(granular.skill_approval);
  const requestPermissions = booleanValue(granular.request_permissions);
  const mcpElicitations = booleanValue(granular.mcp_elicitations);
  if (
    sandboxApproval === undefined ||
    rules === undefined ||
    skillApproval === undefined ||
    requestPermissions === undefined ||
    mcpElicitations === undefined
  ) {
    return undefined;
  }
  return {
    sandbox_approval: sandboxApproval,
    rules,
    skill_approval: skillApproval,
    request_permissions: requestPermissions,
    mcp_elicitations: mcpElicitations,
  };
}

function isApprovalPolicy(value: unknown): value is AskForApproval | null {
  return (
    value === null ||
    value === "untrusted" ||
    value === "on-request" ||
    value === "never" ||
    granularApprovalValue(value) !== undefined
  );
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function enumOrNull<const Values extends readonly string[]>(
  value: string,
  options: Values,
): Values[number] | null {
  if (value === "") return null;
  if (options.includes(value)) return value as Values[number];
  throw new Error(`Invalid setting value: ${value}`);
}

function sentenceCase(value: string): string {
  const words = value.replaceAll("_", " ").replaceAll("-", " ");
  return words.length === 0 ? words : `${words[0]?.toUpperCase()}${words.slice(1)}`;
}

function isWindows(platform: string): boolean {
  return platform === "win32" || platform.toLowerCase().startsWith("windows");
}

function stringSet(value: unknown): ReadonlySet<string> | undefined {
  return Array.isArray(value)
    ? new Set(value.filter((item): item is string => typeof item === "string"))
    : undefined;
}

function approvalModeSet(value: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const modes = new Set<string>();
  for (const policy of value) {
    if (policy === "untrusted" || policy === "on-request" || policy === "never") {
      modes.add(policy);
    } else if (granularApprovalValue(policy) !== undefined) {
      modes.add("granular");
    }
  }
  return modes;
}

function displayValue(value: unknown): string {
  let displayed: string;
  if (typeof value === "string") {
    displayed = value;
  } else {
    try {
      displayed = JSON.stringify(value) ?? "unknown";
    } catch {
      displayed = "unavailable";
    }
  }
  const singleLine = displayed.replaceAll(/\s+/g, " ").trim();
  return singleLine.length <= 120 ? singleLine : `${singleLine.slice(0, 119)}…`;
}

function runtimeStateLabel(runtime: RuntimeStatus): string {
  if (runtime.restartRequired) return "Restart recommended";
  switch (runtime.state) {
    case "ready":
      return "Ready for the next turn";
    case "applying":
      return "Applying changes";
    case "restarting":
      return "Restarting Codex";
    case "degraded":
      return "Some resources need attention";
    default:
      return sentenceCase(runtime.state);
  }
}

function runtimeSaveNotice(runtime: RuntimeStatus): string {
  if (runtime.restartRequired) {
    return "Saved. Restart Codex to apply the startup-only changes.";
  }
  return runtime.state === "degraded"
    ? "Saved. Some Codex resources could not refresh; check runtime status."
    : "Saved. Changes apply on the next turn.";
}

function runtimeActionNotice(runtime: RuntimeStatus, action: "reload" | "restart"): string {
  if (runtime.restartRequired) {
    return action === "reload"
      ? "Reloaded available resources. Restart Codex to apply startup-only changes."
      : "Restart did not complete; check runtime status and retry.";
  }
  if (runtime.state === "degraded") {
    return action === "reload"
      ? "Reload finished with warnings; check runtime status."
      : "Restart needs attention; check runtime status.";
  }
  return action === "reload"
    ? "Config and skills refreshed; MCP changes are queued for the next turn."
    : "Codex restarted and is ready.";
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayValue(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}

function apiError(value: unknown): string | undefined {
  const error = recordValue(value)?.error;
  return typeof error === "string" ? error : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

class ConfigApiError extends Error {
  public readonly issues: readonly ValidationIssue[] | undefined;

  public constructor(message: string, issues: readonly ValidationIssue[] | undefined) {
    super(message);
    this.name = "ConfigApiError";
    this.issues = issues;
  }
}

const root = document.getElementById("root");
if (root === null) throw new Error("Mini App root element is missing");
createRoot(root).render(h(SettingsApp));
