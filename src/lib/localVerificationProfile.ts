export type RuntimeDependencyMode = "production" | "local-verify";

export type LocalVerificationAdapterSummary = {
  mode: RuntimeDependencyMode;
  enabled: boolean;
  adapters: {
    database: string;
    objectStorage: string;
    malwareScanner: string;
    billingWebhook: string;
    health: string;
    audit: string;
    restoreVerification: string;
  };
};

function truthy(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isLocalVerificationRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.VERIFY_LOCAL_RUNTIME);
}

export function getRuntimeDependencyMode(env: NodeJS.ProcessEnv = process.env): RuntimeDependencyMode {
  return isLocalVerificationRuntime(env) ? "local-verify" : "production";
}

export function getLocalVerificationAdapterSummary(
  env: NodeJS.ProcessEnv = process.env
): LocalVerificationAdapterSummary {
  const enabled = isLocalVerificationRuntime(env);
  return {
    mode: enabled ? "local-verify" : "production",
    enabled,
    adapters: enabled
      ? {
          database: "deterministic route-level state adapter",
          objectStorage: "in-memory object store adapter",
          malwareScanner: "deterministic clean/infected/unknown/unavailable adapter",
          billingWebhook: "signed local fixture adapter",
          health: "injectable dependency summary adapter",
          audit: "in-memory audit/security capture adapter",
          restoreVerification: "deterministic restore snapshot adapter",
        }
      : {
          database: "production database adapter",
          objectStorage: "production object storage adapter",
          malwareScanner: "production malware scanner adapter",
          billingWebhook: "production Stripe webhook adapter",
          health: "production dependency probes",
          audit: "production audit/event sinks",
          restoreVerification: "production restore verification path",
        },
  };
}
