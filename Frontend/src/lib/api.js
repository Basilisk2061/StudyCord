import { supabase } from './supabase';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';

export class ApiError extends Error {
  constructor(message, status, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function getAuthHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new ApiError('You must be signed in to do that.', 401);
  }
  return {
    Authorization: `Bearer ${session.access_token}`,
  };
}

async function authenticatedFetch(path, options = {}) {
  const headers = await getAuthHeaders();
  const isFormData = options.body instanceof FormData;
  return fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(!isFormData && options.body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
      ...(options.headers || {}),
    },
  });
}

async function responseError(response) {
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
  }
  return new ApiError(
    data?.detail || data?.message || 'Request failed.',
    response.status,
    data,
  );
}

export async function apiRequest(path, options = {}) {
  const response = await authenticatedFetch(path, options);

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
  }

  if (!response.ok) {
    throw new ApiError(data?.detail || data?.message || 'Request failed.', response.status, data);
  }

  return data;
}

export async function apiBlobRequest(path, options = {}) {
  const response = await authenticatedFetch(path, options);
  if (!response.ok) throw await responseError(response);
  return response.blob();
}
