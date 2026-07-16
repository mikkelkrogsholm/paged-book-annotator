export class SurveyApi {
  constructor({ baseUrl = "/api/surveys" } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(path = "", options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers ?? {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `Surveykaldet fejlede (${response.status}).`);
    return payload;
  }

  async list() { return (await this.request()).surveys ?? []; }
  async getResponse(id) { return (await this.request(`/${encodeURIComponent(id)}/response`)).response ?? null; }
  async submit(id, answers) {
    return (await this.request(`/${encodeURIComponent(id)}/response`, {
      method: "PUT",
      body: JSON.stringify({ answers }),
    })).response;
  }
}
