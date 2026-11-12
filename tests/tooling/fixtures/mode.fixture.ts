// FIXTURE for tests/tooling/exit-code.test.ts — passes or fails on demand.
import { expect, test } from "vitest";

test("fixture outcome is controlled by FIXTURE_MODE", () => {
  expect(process.env.FIXTURE_MODE, "deliberate failure when FIXTURE_MODE=fail").toBe("pass");
});
