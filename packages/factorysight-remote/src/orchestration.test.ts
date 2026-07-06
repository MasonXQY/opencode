import { expect, test } from "bun:test"
import { orchestrationPlan } from "./orchestration"

test("orchestrationPlan starts with a primary planning step before specialist roles", () => {
  const plan = orchestrationPlan("Build a responsive web app with backend auth", "balanced")

  expect(plan[0]).toMatchObject({
    agent: "plan",
    title: "Plan orchestration sequence",
    phase: "plan",
  })
  expect(plan.slice(1).some((step) => step.agent === "frontend-engineer")).toBe(true)
  expect(plan.slice(1).some((step) => step.agent === "backend-engineer")).toBe(true)
})

test("orchestrationPlan keeps verification roles after implementation roles", () => {
  const plan = orchestrationPlan("Build and test a feature", "wide")
  const buildIndex = plan.findIndex((step) => step.agent === "build")
  const qaIndex = plan.findIndex((step) => step.agent === "qa-engineer")
  const reviewIndex = plan.findIndex((step) => step.agent === "code-reviewer")

  expect(buildIndex).toBeGreaterThan(0)
  expect(qaIndex).toBeGreaterThan(buildIndex)
  expect(reviewIndex).toBeGreaterThan(qaIndex)
})
