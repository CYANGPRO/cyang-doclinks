export const CURRENT_ACCESS_POLICY = Object.freeze({
  key: "privacy-acceptable-use",
  version: "2026-08-18",
  title: "Privacy and acceptable use",
});

export const MAPE_DATA_PRIVACY_POLICY = Object.freeze({
  key: "mape-data-privacy-agreement",
  version: "2026-09-02",
  title: "MAPE Data Privacy Agreement",
  url: "https://mape.org/data-privacy-agreement-form",
});

export const REQUIRED_ACCESS_POLICIES = Object.freeze([
  CURRENT_ACCESS_POLICY,
  MAPE_DATA_PRIVACY_POLICY,
]);

export const REQUIRED_ACCESS_POLICY_PARAMETERS = Object.freeze(
  REQUIRED_ACCESS_POLICIES.flatMap((policy) => [policy.key, policy.version]),
);
