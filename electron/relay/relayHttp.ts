export function buildRelayAuthorizedHeaders(accessToken: string, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  if (init?.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return headers
}
