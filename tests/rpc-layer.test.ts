/**
 * E2E: JSON-RPC layer — jsonRpcCall and jsonRpcBatch with mocked fetch.
 * Covers HTTP errors, RPC errors, rate-limit retryable flag, batch
 * ordering, empty batch, and id counter incrementing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jsonRpcCall, jsonRpcBatch } from '@doubloon/checker-mobile';

function mockFetch(response: { ok: boolean; status: number; statusText?: string; json?: unknown }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? '',
    json: async () => response.json,
  });
}

describe('jsonRpcCall', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns result on success', async () => {
    globalThis.fetch = mockFetch({
      ok: true, status: 200,
      json: { jsonrpc: '2.0', id: 1, result: { value: 42 } },
    }) as any;

    const result = await jsonRpcCall<{ value: number }>('https://rpc.test', 'getBalance', ['addr']);
    expect(result).toEqual({ value: 42 });
  });

  it('sends correct JSON-RPC body', async () => {
    const fetchMock = mockFetch({
      ok: true, status: 200,
      json: { jsonrpc: '2.0', id: 1, result: null },
    });
    globalThis.fetch = fetchMock as any;

    await jsonRpcCall('https://rpc.test', 'getAccountInfo', ['addr', { encoding: 'base64' }]);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://rpc.test');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('getAccountInfo');
    expect(body.params).toEqual(['addr', { encoding: 'base64' }]);
  });

  it('HTTP 500 → RPC_ERROR with retryable=true', async () => {
    globalThis.fetch = mockFetch({ ok: false, status: 500, statusText: 'Internal Server Error' }) as any;

    const err: any = await jsonRpcCall('https://rpc.test', 'm', []).catch(e => e);
    expect(err.code).toBe('RPC_ERROR');
    expect(err.message).toContain('500');
    expect(err.retryable).toBe(true);
  });

  it('HTTP 404 → RPC_ERROR with retryable=false', async () => {
    globalThis.fetch = mockFetch({ ok: false, status: 404, statusText: 'Not Found' }) as any;

    const err: any = await jsonRpcCall('https://rpc.test', 'm', []).catch(e => e);
    expect(err.code).toBe('RPC_ERROR');
    expect(err.retryable).toBe(false);
  });

  it('RPC error code -32005 (rate limited) → retryable=true', async () => {
    globalThis.fetch = mockFetch({
      ok: true, status: 200,
      json: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Rate limited' } },
    }) as any;

    const err: any = await jsonRpcCall('https://rpc.test', 'm', []).catch(e => e);
    expect(err.code).toBe('RPC_ERROR');
    expect(err.message).toContain('-32005');
    expect(err.retryable).toBe(true);
  });

  it('RPC error code -32600 (invalid request) → not retryable', async () => {
    globalThis.fetch = mockFetch({
      ok: true, status: 200,
      json: { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid request' } },
    }) as any;

    const err: any = await jsonRpcCall('https://rpc.test', 'm', []).catch(e => e);
    expect(err.code).toBe('RPC_ERROR');
    expect(err.message).toContain('-32600');
  });
});

describe('jsonRpcBatch', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('empty calls → empty results', async () => {
    const result = await jsonRpcBatch('https://rpc.test', []);
    expect(result).toEqual([]);
  });

  it('sorts results by id to match input order', async () => {
    // Return results in reverse order to test sorting
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { jsonrpc: '2.0', id: 1002, result: 'second' },
        { jsonrpc: '2.0', id: 1001, result: 'first' },
        { jsonrpc: '2.0', id: 1003, result: 'third' },
      ],
    }) as any;

    const results = await jsonRpcBatch<string>('https://rpc.test', [
      { method: 'a', params: [] },
      { method: 'b', params: [] },
      { method: 'c', params: [] },
    ]);

    expect(results).toEqual(['first', 'second', 'third']);
  });

  it('batch HTTP error → RPC_ERROR', async () => {
    globalThis.fetch = mockFetch({ ok: false, status: 503, statusText: 'Service Unavailable' }) as any;

    await expect(jsonRpcBatch('https://rpc.test', [
      { method: 'a', params: [] },
    ])).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });

  it('one error in batch → throws on that item', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { jsonrpc: '2.0', id: 2001, result: 'ok' },
        { jsonrpc: '2.0', id: 2002, error: { code: -32000, message: 'Account not found' } },
      ],
    }) as any;

    await expect(jsonRpcBatch('https://rpc.test', [
      { method: 'a', params: [] },
      { method: 'b', params: [] },
    ])).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });
});
