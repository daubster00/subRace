// Build absolute API URLs from window.location.origin instead of letting the
// browser resolve relative paths against window.location.href. When a user
// visits with embedded Basic Auth credentials (e.g. https://user:pass@host/),
// href carries the userinfo and fetch() rejects the resulting URL with
// "Request cannot be constructed from a URL that includes credentials".
// origin is spec-guaranteed to be protocol://host[:port] only — no userinfo —
// so the request stays same-origin (CORS-safe, Basic Auth header auto-attached)
// while the credentials in the page URL are stripped.
export function apiUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return window.location.origin + path;
}
