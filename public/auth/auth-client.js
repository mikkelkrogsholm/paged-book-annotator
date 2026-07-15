async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Kaldet fejlede (${response.status}).`);
  return payload;
}

export class AuthClient {
  login(input) { return request("/api/auth/login", { method: "POST", body: JSON.stringify(input) }); }
  register(input) { return request("/api/auth/register", { method: "POST", body: JSON.stringify(input) }); }
  acceptInvitation(input) { return request("/api/auth/invitations/accept", { method: "POST", body: JSON.stringify(input) }); }
  changePassword(input) { return request("/api/auth/password", { method: "POST", body: JSON.stringify(input) }); }
  logout() { return request("/api/auth/logout", { method: "POST" }); }
}
