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
  list() {
    return requestJson("/api/annotations");
  }

  create(annotation) {
    return requestJson("/api/annotations", { method: "POST", body: JSON.stringify(annotation) });
  }

  update(id, changes) {
    return requestJson(`/api/annotations/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(changes),
    });
  }

  delete(id) {
    return requestJson(`/api/annotations/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  import(document, mode = "merge") {
    return requestJson("/api/annotations/import", {
      method: "POST",
      body: JSON.stringify({ document, mode }),
    });
  }
}
