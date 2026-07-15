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
  constructor({ bookId = "" } = {}) {
    this.bookId = bookId;
    this.apiBase = bookId ? `/api/books/${encodeURIComponent(bookId)}` : "/api";
  }

  withBook(input) { return this.bookId ? { ...input, bookId: this.bookId } : input; }

  login(input) { return request(`${this.apiBase}/auth/login`, { method: "POST", body: JSON.stringify(input) }); }
  register(input) { return request(`${this.apiBase}/auth/register`, { method: "POST", body: JSON.stringify(this.withBook(input)) }); }
  acceptInvitation(input) { return request(`${this.apiBase}/auth/invitations/accept`, { method: "POST", body: JSON.stringify(this.withBook(input)) }); }
  acceptAccessCode(input) { return request(`${this.apiBase}/auth/access-codes/accept`, { method: "POST", body: JSON.stringify(this.withBook(input)) }); }
  changePassword(input) { return request(`${this.apiBase}/auth/password`, { method: "POST", body: JSON.stringify(input) }); }
  exportAccount() { return request(`${this.apiBase}/account/export`); }
  eraseAccount() { return request(`${this.apiBase}/account`, { method: "DELETE" }); }
  logout() { return request(`${this.apiBase}/auth/logout`, { method: "POST" }); }
}
