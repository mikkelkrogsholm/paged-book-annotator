export class ProgressClient {
  constructor({ baseUrl = "/api/progress" } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async get() {
    const response = await fetch(this.baseUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return (await response.json()).progress;
  }

  async save(progress) {
    const response = await fetch(this.baseUrl, {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(progress),
    });
    if (!response.ok) throw new Error(`Læsepositionen kunne ikke gemmes (${response.status}).`);
    return (await response.json()).progress;
  }

  async getPreference() {
    const response = await fetch(`${this.baseUrl}/preferences`, { headers: { Accept: "application/json" } });
    if (!response.ok) return { trackingEnabled: false, updatedAt: null };
    return (await response.json()).preference;
  }

  async setPreference(trackingEnabled) {
    const response = await fetch(`${this.baseUrl}/preferences`, {
      method: "PUT", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ trackingEnabled }),
    });
    if (!response.ok) throw new Error(`Privatlivsindstillingen kunne ikke gemmes (${response.status}).`);
    return (await response.json()).preference;
  }
}
