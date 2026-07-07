import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

let cleanup: string | undefined

afterEach(async () => {
  if (cleanup) await rm(cleanup, { recursive: true, force: true })
  cleanup = undefined
  delete process.env.FACTORYSIGHT_REMOTE_DATA
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.FACTORYSIGHT_GMAIL_REDIRECT_URI
})

test("gmailAuthorizationUrl requests readonly Gmail access with backend callback state", async () => {
  cleanup = await mkdtemp(join(tmpdir(), "factorysight-gmail-client-"))
  process.env.FACTORYSIGHT_REMOTE_DATA = cleanup
  process.env.GOOGLE_CLIENT_ID = "client-id"
  process.env.GOOGLE_CLIENT_SECRET = "client-secret"
  process.env.FACTORYSIGHT_GMAIL_REDIRECT_URI = "http://localhost:3090/api/integrations/gmail/callback"
  const { gmailAuthorizationUrl } = await import(`./gmail-client.ts?token=${Date.now()}`)

  const url = new URL(await gmailAuthorizationUrl("usr_1"))

  expect(url.origin).toBe("https://accounts.google.com")
  expect(url.searchParams.get("client_id")).toBe("client-id")
  expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly")
  expect(url.searchParams.get("access_type")).toBe("offline")
  expect(url.searchParams.get("state")).toBeTruthy()
})
