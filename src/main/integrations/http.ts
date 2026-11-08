// The REST calls behind the integrations. Failures carry a status and never the
// request's headers, so an error shown in the form cannot leak a key.
const TIMEOUT_MS = 20_000

export class ApiError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

export const basicAuth = (email: string, token: string): string =>
  `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`

export async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) throw new ApiError(response.status)
  return (await response.json()) as T
}

/** `value`, or null when the thing asked for does not exist. */
export async function orNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}
