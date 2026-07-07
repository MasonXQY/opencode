import { consumeGmailOAuthState, createGmailOAuthState, readGmailToken, writeGmailToken } from "./gmail-storage"

const gmailReadonlyScope = "https://www.googleapis.com/auth/gmail.readonly"
const googleAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth"
const googleTokenUrl = "https://oauth2.googleapis.com/token"
const gmailApiUrl = "https://gmail.googleapis.com/gmail/v1"

type GmailMessageListResponse = {
  messages?: Array<{ id: string; threadId?: string }>
  resultSizeEstimate?: number
}

type GmailMessageResponse = {
  id: string
  threadId?: string
  snippet?: string
  payload?: {
    headers?: Array<{ name?: string; value?: string }>
  }
  internalDate?: string
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

type UserInfoResponse = {
  email?: string
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required to connect Gmail`)
  return value
}

export function gmailRedirectUri() {
  return process.env.FACTORYSIGHT_GMAIL_REDIRECT_URI ?? "http://localhost:3090/api/integrations/gmail/callback"
}

export async function gmailAuthorizationUrl(userId: string) {
  const state = await createGmailOAuthState(userId)
  const url = new URL(googleAuthUrl)
  url.searchParams.set("client_id", requiredEnv("GOOGLE_CLIENT_ID"))
  url.searchParams.set("redirect_uri", gmailRedirectUri())
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", gmailReadonlyScope)
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  url.searchParams.set("state", state)
  return url.toString()
}

async function tokenRequest(body: Record<string, string>) {
  const response = await fetch(googleTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredEnv("GOOGLE_CLIENT_ID"),
      client_secret: requiredEnv("GOOGLE_CLIENT_SECRET"),
      ...body,
    }),
  })
  const payload = (await response.json()) as TokenResponse
  if (!response.ok || payload.error) {
    throw new Error(payload.error_description || payload.error || `Gmail token request failed: HTTP ${response.status}`)
  }
  if (!payload.access_token) throw new Error("Gmail token response did not include an access token")
  return payload
}

async function gmailFetch<T>(accessToken: string, path: string) {
  const response = await fetch(`${gmailApiUrl}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(text || `Gmail API failed: HTTP ${response.status}`)
  return JSON.parse(text) as T
}

async function gmailUserEmail(accessToken: string) {
  try {
    const profile = await gmailFetch<UserInfoResponse>(accessToken, "/users/me/profile")
    return profile.email
  } catch {
    return undefined
  }
}

export async function completeGmailAuthorization(input: { state: string; code: string }) {
  const record = await consumeGmailOAuthState(input.state)
  const token = await tokenRequest({
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: gmailRedirectUri(),
  })
  const email = await gmailUserEmail(token.access_token!)
  await writeGmailToken({
    userId: record.userId,
    accessToken: token.access_token!,
    refreshToken: token.refresh_token,
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    scope: token.scope,
    email,
  })
}

export async function gmailAccessToken(userId: string) {
  const token = await readGmailToken(userId)
  if (!token) throw new Error("Gmail is not connected")
  if (!token.expiresAt || token.expiresAt > Date.now() + 60_000) return token.accessToken
  if (!token.refreshToken) return token.accessToken
  const refreshed = await tokenRequest({
    refresh_token: token.refreshToken,
    grant_type: "refresh_token",
  })
  const next = await writeGmailToken({
    userId,
    accessToken: refreshed.access_token!,
    refreshToken: refreshed.refresh_token ?? token.refreshToken,
    expiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined,
    scope: refreshed.scope ?? token.scope,
    email: token.email,
  })
  return next.accessToken
}

function header(message: GmailMessageResponse, name: string) {
  return message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value
}

export type GmailImportedMessage = {
  id: string
  threadId?: string
  from?: string
  to?: string
  subject?: string
  date?: string
  snippet?: string
}

export async function importGmailMessages(input: { userId: string; query?: string; maxResults?: number }) {
  const accessToken = await gmailAccessToken(input.userId)
  const maxResults = Math.min(Math.max(input.maxResults ?? 10, 1), 25)
  const listUrl = new URL("/gmail/v1/users/me/messages", "https://gmail.googleapis.com")
  listUrl.searchParams.set("maxResults", String(maxResults))
  if (input.query?.trim()) listUrl.searchParams.set("q", input.query.trim())

  const listResponse = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
  const list = (await listResponse.json()) as GmailMessageListResponse
  if (!listResponse.ok) throw new Error(JSON.stringify(list))

  const messages = await Promise.all(
    (list.messages ?? []).map(async (message) => {
      const detail = await gmailFetch<GmailMessageResponse>(
        accessToken,
        `/users/me/messages/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      )
      return {
        id: detail.id,
        threadId: detail.threadId,
        from: header(detail, "From"),
        to: header(detail, "To"),
        subject: header(detail, "Subject"),
        date: header(detail, "Date"),
        snippet: detail.snippet,
      } satisfies GmailImportedMessage
    }),
  )

  return {
    source: "gmail",
    query: input.query?.trim() || "latest",
    importedAt: new Date().toISOString(),
    messages,
  }
}
