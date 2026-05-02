import { afterEach, describe, expect, it, vi } from 'vitest';
import { TogglAPI, TogglAPIError } from '../src/toggl-api.js';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('node-fetch', () => ({
  default: fetchMock,
}));

function response({
  status,
  text = '',
  json,
  retryAfter,
  contentLength,
}: {
  status: number;
  text?: string;
  json?: unknown;
  retryAfter?: string;
  contentLength?: string;
}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: vi.fn((name: string) => {
        const key = name.toLowerCase();
        if (key === 'retry-after') return retryAfter;
        if (key === 'content-length') return contentLength;
        return null;
      }),
    },
    text: vi.fn(async () => {
      if (text) return text;
      if (json !== undefined) return JSON.stringify(json);
      return '';
    }),
    json: vi.fn(async () => {
      if (json !== undefined) return json;
      return JSON.parse(text);
    }),
  };
}

describe('toggl api errors', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('parses Toggl quota reset seconds from 402 responses', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 402,
        text: 'You have hit your hourly limit for API calls. The quota will reset in 133 seconds.',
      })
    );

    const api = new TogglAPI('token');
    await expect(api.getWorkspaces()).rejects.toMatchObject({
      code: 'TOGGL_QUOTA_LIMIT',
      status: 402,
      retry_after_seconds: 133,
    });
    await expect(api.getWorkspaces()).rejects.toBeInstanceOf(TogglAPIError);
  });

  it('returns structured rate limit errors instead of sleeping for long retry windows', async () => {
    fetchMock.mockResolvedValue(response({ status: 429, retryAfter: '60' }));

    const api = new TogglAPI('token');
    await expect(api.getWorkspaces()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retry_after_seconds: 60,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Toggl returns HTTP 200 with content-length: 0 (not 204) on some write endpoints,
  // including DELETE /workspaces/{wid}/tags/{tid} and DELETE /workspaces/{wid}/time_entries/{tid}.
  // Naive response.json() throws on the empty body, which previously triggered a misleading retry
  // that could surface as a 404 because the first call had already succeeded server-side.
  it('treats HTTP 200 with content-length: 0 as a successful empty response', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, contentLength: '0', text: '' }));

    const api = new TogglAPI('token');
    await expect(api.deleteTimeEntry(1, 100)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('toggl api time entry CRUD', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('POSTs to the workspace time_entries endpoint with start, billable, and created_with', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: {
          id: 100,
          workspace_id: 1,
          start: '2026-05-01T09:00:00Z',
          stop: '2026-05-01T10:00:00Z',
          duration: 3600,
          description: 'Focused work',
          billable: true,
        },
      })
    );

    const api = new TogglAPI('token');
    const entry = await api.createTimeEntry(1, {
      start: '2026-05-01T09:00:00Z',
      stop: '2026-05-01T10:00:00Z',
      duration: 3600,
      description: 'Focused work',
      billable: true,
    });

    expect(entry.id).toBe(100);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/time_entries');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      workspace_id: 1,
      created_with: 'mcp-toggl',
      start: '2026-05-01T09:00:00Z',
      stop: '2026-05-01T10:00:00Z',
      duration: 3600,
      description: 'Focused work',
      billable: true,
    });
  });

  it('PUTs to the single time_entry endpoint with only the supplied update fields', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: {
          id: 100,
          workspace_id: 1,
          start: '2026-05-01T09:00:00Z',
          duration: 3600,
          project_id: 50,
          description: 'Categorized',
        },
      })
    );

    const api = new TogglAPI('token');
    const entry = await api.updateTimeEntry(1, 100, {
      project_id: 50,
      description: 'Categorized',
    });

    expect(entry.id).toBe(100);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/time_entries/100');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ project_id: 50, description: 'Categorized' });
  });

  it('DELETEs the single time_entry endpoint without a body', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, contentLength: '0', text: '' }));

    const api = new TogglAPI('token');
    await api.deleteTimeEntry(1, 100);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.track.toggl.com/api/v9/workspaces/1/time_entries/100');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('passes billable through startTimer to the underlying createTimeEntry payload', async () => {
    fetchMock.mockResolvedValue(
      response({
        status: 200,
        json: {
          id: 101,
          workspace_id: 1,
          start: '2026-05-01T09:00:00Z',
          duration: -1,
          billable: true,
        },
      })
    );

    const api = new TogglAPI('token');
    await api.startTimer(1, 'Working', undefined, undefined, undefined, true);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      description: 'Working',
      billable: true,
      duration: -1,
    });
  });

  it('does not retry create on 4xx client errors', async () => {
    fetchMock.mockResolvedValue(
      response({ status: 400, text: 'start cannot be in the future for completed entries' })
    );

    const api = new TogglAPI('token');
    await expect(
      api.createTimeEntry(1, { start: '2050-01-01T00:00:00Z', duration: 60 })
    ).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
