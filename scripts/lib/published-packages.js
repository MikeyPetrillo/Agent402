// The npm packages the deploy.yml publish job ships, as the directories its
// "Publish ... to npm" steps `cd` into. Read from the workflow so a package
// added to the publish job is picked up by every check that reads this.
import { load } from "js-yaml";
import { expandedDeployWorkflow } from "./ci-workflow.js";

export function publishedPackageDirs(workflowText = expandedDeployWorkflow()) {
  const steps = load(workflowText).jobs?.publish?.steps || [];
  const dirs = [];
  for (const s of steps) {
    if (!/^Publish .+ to npm$/.test(String(s.name || ""))) continue;
    const m = /^\s*cd\s+(\S+)\s*$/m.exec(String(s.run || ""));
    if (m) dirs.push(m[1]);
  }
  return dirs;
}
