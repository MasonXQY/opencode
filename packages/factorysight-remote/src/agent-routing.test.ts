import { expect, test } from "bun:test"
import { runnerAgentFor } from "./agent-routing"

test("runnerAgentFor maps FactorySight role agents onto valid primary CLI agents", () => {
  expect(runnerAgentFor("build")).toBe("build")
  expect(runnerAgentFor("plan")).toBe("plan")
  expect(runnerAgentFor("code-reviewer")).toBe("build")
  expect(runnerAgentFor("frontend-engineer")).toBe("build")
})
