import { expect, test } from "bun:test"
import {
  adaptiveOrchestrationSteps,
  adaptiveBatchKey,
  appendAdaptiveTaskIds,
  childPrompt,
  handoffText,
  initialOrchestrationPlan,
  orchestrationPlan,
  limitAdaptiveSteps,
} from "./orchestration"
import type { Task } from "./shared"

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

test("orchestrationPlan only dispatches agents from the backend roster when provided", () => {
  const plan = orchestrationPlan("Build a frontend and backend workflow", "wide", ["plan", "build", "qa-engineer"])

  expect(plan.every((step) => ["plan", "build", "qa-engineer"].includes(step.agent))).toBe(true)
  expect(plan.map((step) => step.title)).toContain("Plan orchestration sequence")
})

test("adaptiveOrchestrationSteps reacts to completed output signals", () => {
  const steps = adaptiveOrchestrationSteps({
    prompt: "Build project intake workflow",
    scale: "wide",
    completedAgent: "build",
    existingAgents: ["plan", "product-lead", "tech-lead", "build"],
    completedOutput: "The implementation introduced OAuth tokens and permission handling that need security review.",
    availableAgents: ["plan", "build", "security-reviewer", "qa-engineer"],
  })

  expect(steps.some((step) => step.agent === "security-reviewer")).toBe(true)
})

test("childPrompt includes four-step workflow methodology and JSON handoff contract", () => {
  const [step] = orchestrationPlan("Build backend API", "balanced")
  if (!step) throw new Error("expected a plan step")
  const parent: Task = {
    id: "tsk_parent",
    projectId: "prj_1",
    creatorId: "usr_1",
    kind: "orchestration",
    title: "Parent",
    prompt: "Build backend API",
    agent: "orchestrator",
    model: "anthropic/claude-opus-4-8",
    status: "queued",
    collaboration: "project",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    events: [],
  }

  const prompt = childPrompt(parent, step)

  expect(prompt).toContain("Decompose the objective")
  expect(prompt).toContain("```json")
  expect(prompt).toContain('"execution"')
  expect(prompt).toContain("uncertainty/conflict")
})

test("appendAdaptiveTaskIds keeps existing workflow order before adaptive nodes", () => {
  expect(appendAdaptiveTaskIds(["plan", "product", "tech", "build"], ["security", "docs"])).toEqual([
    "plan",
    "product",
    "tech",
    "build",
    "security",
    "docs",
  ])
  expect(appendAdaptiveTaskIds(["plan", "security"], ["security", "docs"])).toEqual(["plan", "security", "docs"])
})

test("adaptiveBatchKey groups dynamic topology additions by workflow phase", () => {
  expect(adaptiveBatchKey("plan")).toBe("design")
  expect(adaptiveBatchKey("tech-lead")).toBe("build")
  expect(adaptiveBatchKey("ux-designer")).toBe("build")
  expect(adaptiveBatchKey("build")).toBe("verify")
  expect(adaptiveBatchKey("backend-engineer")).toBe("verify")
  expect(adaptiveBatchKey("code-reviewer")).toBeUndefined()
})

test("limitAdaptiveSteps caps dynamic workflow growth", () => {
  expect(limitAdaptiveSteps(["a", "b", "c"], 6, 8)).toEqual(["a", "b"])
  expect(limitAdaptiveSteps(["a", "b"], 8, 8)).toEqual([])
  expect(limitAdaptiveSteps(["a", "b"], 3, 8)).toEqual(["a", "b"])
})
