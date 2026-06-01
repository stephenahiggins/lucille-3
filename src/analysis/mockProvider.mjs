import { readFileSync } from "node:fs";
import path from "node:path";

export function loadMockObservations(root, day) {
  const fixturePath = path.join(root, "fixtures", "mock-observations.json");
  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));

  return fixtures.map((fixture, index) => ({
    schemaVersion: "observation.v1",
    id: `${day}-${fixture.fixtureId}`,
    capturedAt: `${day}T09:${String(index * 7).padStart(2, "0")}:00.000Z`,
    appName: fixture.appName,
    windowTitle: fixture.windowTitle,
    domain: fixture.domain,
    activity: fixture.activity,
    visibleTextSummary: fixture.visibleTextSummary,
    redactedSignals: fixture.redactedSignals,
    evidenceIds: fixture.evidenceIds
  }));
}
