/**
 * @param {Record<string, string | undefined>} [env]
 */
export function getPlaywrightInstallInvocation(env = process.env) {
  const withDeps = env.PROOF_PLAYWRIGHT_INSTALL_WITH_DEPS === "1";
  return {
    label: withDeps ? "Playwright runtime (chromium + OS deps)" : "Playwright runtime (chromium)",
    command: "repo-tool",
    args: ["playwright", "install", ...(withDeps ? ["--with-deps"] : []), "chromium"],
    scope: withDeps ? "Chromium browser runtime and Linux OS dependencies" : "Chromium browser runtime",
  };
}
