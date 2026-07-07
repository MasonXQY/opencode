import { expect, test } from "bun:test"
import { adaptiveOrchestrationSteps, handoffText, initialOrchestrationPlan, orchestrationPlan } from "./orchestration"

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

test("initialOrchestrationPlan starts with only the core workflow spine", () => {
  const plan = initialOrchestrationPlan("Build a responsive web app with backend auth", "wide")

  expect(plan.map((step) => step.agent)).toEqual(["plan", "product-lead", "tech-lead", "build"])
})

test("adaptiveOrchestrationSteps adds demand-specific roles while running", () => {
  const steps = adaptiveOrchestrationSteps({
    prompt: "Build a responsive web app with backend auth",
    scale: "wide",
    completedAgent: "tech-lead",
    existingAgents: ["plan", "product-lead", "tech-lead", "build"],
  })

  expect(steps.some((step) => step.agent === "frontend-engineer")).toBe(true)
  expect(steps.some((step) => step.agent === "backend-engineer")).toBe(true)
})

test("orchestration steps include explicit handoff contracts", () => {
  const plan = orchestrationPlan("Build backend API and frontend UI", "wide")
  const backend = plan.find((step) => step.agent === "backend-engineer")

  expect(backend).toMatchObject({
    failurePolicy: "retry",
    acceptance: expect.any(String),
  })
  expect(backend?.requires.length).toBeGreaterThan(0)
  expect(backend?.provides.length).toBeGreaterThan(0)
})

test("handoffText summarizes agent handshake state", () => {
  const [step] = orchestrationPlan("Build backend API", "balanced")
  if (!step) throw new Error("expected a plan step")

  expect(handoffText({ from: "orchestrator", to: step.agent, step, status: "offered" })).toContain(
    "Agent handoff offered: orchestrator -> plan",
  )
})
