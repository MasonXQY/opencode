import { expect, test } from "bun:test"
import {
  factorySightApiArgs,
  factorySightApiUrl,
  factorySightSessionToTask,
  modelRefFromString,
  modelsFromFactorySightResponse,
} from "./factorysight-client"

test("modelRefFromString converts remote model strings into FactorySight model refs", () => {
  expect(modelRefFromString("anthropic/claude-opus-4-8")).toEqual({
    providerID: "anthropic",
    id: "claude-opus-4-8",
  })
})

test("modelRefFromString keeps provider prefixes with slash-free model ids", () => {
  expect(modelRefFromString("openai/gpt-5.1")).toEqual({
    providerID: "openai",
    id: "gpt-5.1",
  })
})

test("modelsFromFactorySightResponse flattens FactorySight model list responses", () => {
  expect(
    modelsFromFactorySightResponse({
      data: [
        { providerID: "anthropic", id: "claude-opus-4-8", enabled: true },
        { providerID: "openai", id: "gpt-5.1", enabled: false },
        { providerID: "anthropic", id: "claude-sonnet-4-5", enabled: true },
      ],
    }),
  ).toEqual(["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-5"])
})

test("factorySightApiArgs builds raw FactorySight API commands", () => {
  expect(factorySightApiArgs("POST", "/api/session", { ok: true })).toEqual([
    "api",
    "post",
    "/api/session",
    "--data",
    '{"ok":true}',
  ])
})

test("factorySightApiUrl resolves API paths against a FactorySight backend URL", () => {
  expect(factorySightApiUrl("http://127.0.0.1:4096", "/api/model")).toBe("http://127.0.0.1:4096/api/model")
  expect(factorySightApiUrl("http://127.0.0.1:4096/", "/api/session")).toBe("http://127.0.0.1:4096/api/session")
})

test("factorySightSessionToTask maps FactorySight sessions to Remote task cards", () => {
  expect(
    factorySightSessionToTask(
      {
        id: "ses_123",
        projectID: "prj_backend",
        agent: "build",
        model: { providerID: "anthropic", id: "claude-opus-4-8" },
        title: "Implement login",
        time: { created: 1783348196848, updated: 1783348459715 },
        location: { directory: "/tmp/app" },
      },
      "usr_mason",
    ),
  ).toMatchObject({
    id: "fs_ses_123",
    projectId: "fs_prj_backend",
    creatorId: "usr_mason",
    title: "Implement login",
    agent: "build",
    model: "anthropic/claude-opus-4-8",
    status: "completed",
    sessionId: "ses_123",
  })
})
