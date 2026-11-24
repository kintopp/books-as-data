import { defineRailway, github, project, service } from "railway/iac";

// The project is shared with other repos' services; the partial limits this file to its own.
export const partial = "books-as-data";

export default defineRailway(() => {
  const mcp = service("books-as-data", {
    source: github("kintopp/books-as-data", { branch: "main", checkSuites: false }),
    // Only runtime files redeploy on push; notes, tests, scripts and the skill don't.
    build: { watchPatterns: ["src/**", "package.json", "package-lock.json"] },
    start: "node src/http.js",
    healthcheck: "/health",
    replicas: { "europe-west4-drams3a": 1 },
    deploy: { limitOverride: { containers: { cpu: 24, memoryBytes: 1000000000 } }, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 3 },
  });
  return project("endearing-warmth", {
    // The npm types lack this field, but the CLI honours it: without it, an apply would
    // own every variable and drop those set only on Railway.
    variables: { managed: false },
    resources: [mcp],
  });
});
