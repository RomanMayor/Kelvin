// Thin wrappers around the backend API. All NASA calls go through the backend (key, cache, quota).

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const problem = await res.json();
      detail = problem.detail || problem.title || detail;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

const query = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

export const api = {
  config: () => request('/api/config'),
  layers: () => request('/api/layers'),
  status: () => request('/api/status'),

  /** URL is also the browser-side cache key, so build it deterministically. */
  hotspotsUrl: ({ layer, bbox, country, from, to }) =>
    '/api/hotspots?' + query({ layer, bbox: bbox?.join(','), country, from, to }),

  hotspots: (url, signal) => request(url, { signal }),

  stats: (body, signal) =>
    request('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
};
