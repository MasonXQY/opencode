import { expect, test } from "bun:test"
import {
  agentsFromFactorySightResponse,
  factorySightApiArgs,
  factorySightApiUrl,
  factorySightModelCandidates,
  factorySightSessionToTask,
  factorySightPermissionRules,
  isFactorySightTransportFallbackError,
  isSessionWaitUnavailable,
  sessionMessagesState,
  selectAvailableFactorySightModel,
  withFactorySightTimeout,
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

test("selectAvailableFactorySightModel keeps available requests and falls back to backend models", () => {
  expect(selectAvailableFactorySightModel("opencode/hy3-free", ["opencode/hy3-free"])).toBe("opencode/hy3-free")
  expect(selectAvailableFactorySightModel("anthropic/claude-opus-4-8", ["opencode/hy3-free"])).toBe(
    "opencode/hy3-free",
  )
  expect(selectAvailableFactorySightModel("missing/model", ["opencode/big-pickle", "opencode/hy3-free"])).toBe(
    "opencode/hy3-free",
  )
  expect(selectAvailableFactorySightModel("missing/model", ["ollama/deepseek-coder-v2:16b", "opencode/hy3-free"])).toBe(
    "opencode/hy3-free",
  )
  expect(selectAvailableFactorySightModel("missing/model", ["anthropic/claude-opus-4-8", "opencode/hy3-free"])).toBe(
    "anthropic/claude-opus-4-8",
  )
})

test("factorySightModelCandidates orders stable retry candidates before slower backend models", () => {
  expect(
    factorySightModelCandidates("missing/model", [
      "opencode/big-pickle",
      "opencode/deepseek-v4-flash-free",
      "opencode/hy3-free",
    ]),
  ).toEqual(["opencode/hy3-free", "opencode/deepseek-v4-flash-free"])
  expect(factorySightModelCandidates("opencode/big-pickle", ["opencode/big-pickle", "opencode/hy3-free"])).toEqual([
    "opencode/big-pickle",
    "opencode/hy3-free",
  ])
})

test("factorySightPermissionRules maps Remote project permission levels into backend rules", () => {
  expect(factorySightPermissionRules("full_auto")).toEqual([{ permission: "*", pattern: "*", action: "allow" }])
  expect(factorySightPermissionRules("ask")).toBeUndefined()
  expect(factorySightPermissionRules("read_only")).toEqual([
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
})

test("agentsFromFactorySightResponse maps FactorySight agents into Remote profiles", () => {
  const result = agentsFromFactorySightResponse({
    data: [
      {
        id: "product-lead",
        mode: "primary",
        description: "Shapes product work",
        steps: 20,
        permissions: [{ permission: "read", action: "allow" }],
      },
      {
        id: "backend-engineer",
        mode: "subagent",
        description: "Builds APIs",
      },
    ],
  })

  expect(result.agents).toEqual(["product-lead", "backend-engineer"])
  expect(result.agentProfiles["product-lead"]).toMatchObject({
    id: "product-lead",
    mode: "primary",
    backend: "factorysight",
    summary: "Shapes product work",
    steps: 20,
    permissions: ["read:allow"],
  })
  expect(result.agentProfiles["backend-engineer"]).toMatchObject({
    mode: "subagent",
    backend: "factorysight",
    summary: "Builds APIs",
  })
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

test("isSessionWaitUnavailable detects FactorySight wait capability gaps", () => {
  expect(
    isSessionWaitUnavailable(
      new Error(
        '{"_tag":"ServiceUnavailableError","message":"Session wait is not available yet","service":"session.wait"}',
      ),
    ),
  ).toBe(true)
  expect(isSessionWaitUnavailable(new Error("provider failed"))).toBe(false)
})

test("FactorySight wait timeouts stay on HTTP transport instead of falling back to CLI", () => {
  expect(isFactorySightTransportFallbackError(new Error("Timed out waiting for FactorySight session ses_123"))).toBe(
    false,
  )
  expect(isFactorySightTransportFallbackError(new Error("Session wait is not available yet"))).toBe(false)
  expect(isFactorySightTransportFallbackError(new Error("Unknown command api"))).toBe(true)
})

test("withFactorySightTimeout rejects hung wait calls", async () => {
  await expect(withFactorySightTimeout(new Promise(() => {}), "FactorySight session ses_hung", 5)).rejects.toThrow(
    "Timed out waiting for FactorySight session ses_hung",
  )
})

test("sessionMessagesState classifies completed and failed FactorySight messages", () => {
  expect(
    sessionMessagesState({
      data: [
        { id: "msg_user", type: "user", text: "hello" },
        {
          id: "msg_assistant",
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "OK" }],
        },
      ],
    }),
  ).toEqual({ status: "completed", text: "OK" })

  expect(
    sessionMessagesState({
      data: [
        {
          id: "msg_assistant",
          type: "assistant",
          finish: "error",
          error: { message: "Provider request failed" },
        },
      ],
    }),
  ).toEqual({ status: "failed", text: "Provider request failed" })
})
