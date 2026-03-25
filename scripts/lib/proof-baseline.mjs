function parseVersion(version) {
  const cleaned = String(version || "").trim().replace(/^v/, "");
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) return null;
  return {
    raw: cleaned,
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
  };
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function parseRange(range) {
  return String(range || "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => {
      const match = token.match(/^(>=|<=|>|<|=)?(.+)$/u);
      if (!match) return null;
      const operator = match[1] || "=";
      const version = parseVersion(match[2]);
      if (!version) return null;
      return { operator, version };
    })
    .filter(Boolean);
}

export function satisfiesExactVersion(actual, expected) {
  const parsedActual = parseVersion(actual);
  const parsedExpected = parseVersion(expected);
  if (!parsedActual || !parsedExpected) return false;
  return compareVersions(parsedActual, parsedExpected) === 0;
}

export function satisfiesVersionRange(actual, range) {
  const parsedActual = parseVersion(actual);
  if (!parsedActual) return false;
  const comparators = parseRange(range);
  if (!comparators.length) return false;

  return comparators.every((comparator) => {
    const cmp = compareVersions(parsedActual, comparator.version);
    switch (comparator.operator) {
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      case "=":
      default:
        return cmp === 0;
    }
  });
}

export function evaluateProofRuntime({
  actualNodeVersion,
  actualNpmVersion,
  requiredNodeVersion,
  requiredNpmVersion,
  nodeEngineRange,
  npmEngineRange,
}) {
  const nodePinned = satisfiesExactVersion(actualNodeVersion, requiredNodeVersion);
  const npmPinned = satisfiesExactVersion(actualNpmVersion, requiredNpmVersion);
  const nodeAllowed = satisfiesVersionRange(actualNodeVersion, nodeEngineRange);
  const npmAllowed = satisfiesVersionRange(actualNpmVersion, npmEngineRange);

  return {
    nodePinned,
    npmPinned,
    nodeAllowed,
    npmAllowed,
    exactPinned: nodePinned && npmPinned,
    engineCompatible: nodeAllowed && npmAllowed,
  };
}
