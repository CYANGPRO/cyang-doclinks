import { getProductionLaunchState } from "../src/lib/production-launch-policy.ts";

const state = getProductionLaunchState(process.env);
const safeOutput = {
  environment: state.environment,
  launchRequested: state.launchRequested,
  ready: state.ready,
  blockers: state.blockers,
};

process.stdout.write(`${JSON.stringify(safeOutput, null, 2)}\n`);
process.exitCode = state.ready ? 0 : 2;
