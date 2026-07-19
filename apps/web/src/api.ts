export function getApiBaseUrl(): string {
  return import.meta.env["VITE_API_URL"] ?? "";
}

/** Fetches an authenticated `/api/*` path, attaching a bearer token if present. */
export async function apiFetch(
  path: string,
  token: string | null,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`Request to ${path} failed: ${response.status}`);
  return response;
}
