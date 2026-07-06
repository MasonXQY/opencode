import { expect, test } from "bun:test"
import { factorySightApiArgs, modelRefFromString, modelsFromFactorySightResponse } from "./factorysight-client"

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
