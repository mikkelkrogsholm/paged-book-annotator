async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Serverfejl (${response.status}).`);
  return body;
}

export class AnnotationApi {
  constructor({ baseUrl = "/api/annotations" } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  list() {
    return requestJson(this.baseUrl);
  }

  create(annotation) {
    return requestJson(this.baseUrl, { method: "POST", body: JSON.stringify(annotation) });
  }

  update(id, changes) {
    return requestJson(`${this.baseUrl}/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(changes),
    });
  }

  delete(id) {
    return requestJson(`${this.baseUrl}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  import(document, mode = "merge") {
    return requestJson(`${this.baseUrl}/import`, {
      method: "POST",
      body: JSON.stringify({ document, mode }),
    });
  }
}
