// Railway Infrastructure as Code for the two services that still read a
// Config as Code file (railway.facilitator.json, railway.worker.json). Those
// files stop being read on 2026-12-01; this file carries the same settings.
//
// Prepared, not applied. The owner runbook is docs/railway-iac-migration.md:
// plan, confirm no deletes, apply outside a CI run, clear each service's
// config file path, verify /health.
//
// A named partial, so this file owns only the services it declares: every
// other service, database and variable in the environment is left alone
// when it is missing from here. Variables are unmanaged, so no service
// variable is declared, changed or deleted. Each service keeps the source it
// has now: the facilitator builds from this repository's main branch (a
// service declared without `source` would be disconnected from it), and the
// worker, deployed by upload, declares none.
import { defineRailway, github, project, service } from "railway/iac";

export const partial = "agent402";

// Self-hosted Stellar facilitator. Redeploys only when its own tree or
// Dockerfile changes (watch patterns).
export const facilitatorConfig = {
  source: github("MikeyPetrillo/Agent402", { branch: "main" }),
  build: {
    builder: "DOCKERFILE",
    dockerfilePath: "Dockerfile.facilitator",
    watchPatterns: ["facilitator/**", "Dockerfile.facilitator"],
  },
  deploy: {
    healthcheckPath: "/health",
    healthcheckTimeout: 60,
    restartPolicyType: "ON_FAILURE",
    restartPolicyMaxRetries: 5,
    numReplicas: 1,
  },
} as const;

// Background worker image. It sleeps when idle (set on the service today;
// left out, the apply would turn it off).
export const workerConfig = {
  build: {
    builder: "DOCKERFILE",
    dockerfilePath: "Dockerfile.worker",
  },
  deploy: {
    healthcheckPath: "/health",
    healthcheckTimeout: 90,
    restartPolicyType: "ON_FAILURE",
    restartPolicyMaxRetries: 5,
    numReplicas: 1,
    sleepApplication: true,
  },
} as const;

export default defineRailway(() => {
  const facilitator = service("agent402-facilitator", facilitatorConfig);
  const worker = service("agent402-worker", workerConfig);
  // Variables stay owned by Railway: this file neither declares nor deletes
  // any service variable.
  return project("agent402", { resources: [facilitator, worker], variables: { managed: false } } as Parameters<typeof project>[1]);
});
