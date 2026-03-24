import { DoubloonError } from '@doubloon/core';

/**
 * Minimal JSON-RPC client using fetch(). Works in React Native, browsers, and Node.js.
 * No external dependencies.
 */

let rpcIdCounter = 1;

export interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export async function jsonRpcCall<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  // Wrap counter at 1 million to prevent overflow issues
  if (rpcIdCounter > 1_000_000) rpcIdCounter = 1;
  const id = rpcIdCounter++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    throw new DoubloonError(
      'RPC_ERROR',
      `RPC fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true },
    );
  }

  if (!res.ok) {
    throw new DoubloonError('RPC_ERROR', `RPC HTTP ${res.status}: ${res.statusText}`, {
      retryable: res.status >= 500,
    });
  }

  const json = (await res.json()) as JsonRpcResponse<T>;

  if (json.error) {
    throw new DoubloonError('RPC_ERROR', `RPC error ${json.error.code}: ${json.error.message}`, {
      retryable: json.error.code === -32005, // rate limited
    });
  }

  return json.result as T;
}

/**
 * Batch JSON-RPC call. Sends multiple requests in a single HTTP request.
 */
/**
 * Result of a single call within a batch. Either success (value) or failure (error).
 */
export type BatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DoubloonError };

/**
 * Batch JSON-RPC call. Sends multiple requests in a single HTTP request.
 *
 * Returns an array of results in the same order as the input `calls`.
 * Individual call failures are returned as `{ ok: false, error }` instead of
 * throwing, so the caller can handle partial failures without losing the
 * successful results.
 */
export async function jsonRpcBatch<T>(
  url: string,
  calls: Array<{ method: string; params: unknown[] }>,
): Promise<BatchResult<T>[]> {
  if (calls.length === 0) return [];

  // Wrap counter at 1 million to prevent overflow issues
  if (rpcIdCounter > 1_000_000) rpcIdCounter = 1;

  const batch = calls.map((call) => ({
    jsonrpc: '2.0' as const,
    id: rpcIdCounter++,
    method: call.method,
    params: call.params,
  }));

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
  } catch (err) {
    throw new DoubloonError(
      'RPC_ERROR',
      `RPC batch fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true },
    );
  }

  if (!res.ok) {
    throw new DoubloonError('RPC_ERROR', `RPC HTTP ${res.status}: ${res.statusText}`, {
      retryable: res.status >= 500,
    });
  }

  const results = (await res.json()) as Array<JsonRpcResponse<T>>;

  // Validate we got the same number of results as requests
  if (!Array.isArray(results)) {
    throw new DoubloonError('RPC_ERROR', 'Batch RPC response is not an array', {
      retryable: true,
    });
  }

  if (results.length !== batch.length) {
    throw new DoubloonError(
      'RPC_ERROR',
      `Batch RPC: expected ${batch.length} responses, got ${results.length}`,
      { retryable: true },
    );
  }

  // Verify all expected IDs are present
  const expectedIds = new Set(batch.map((b) => b.id));
  const receivedIds = new Set(results.map((r) => r.id));
  for (const id of expectedIds) {
    if (!receivedIds.has(id)) {
      throw new DoubloonError(
        'RPC_ERROR',
        `Batch RPC: missing response for request id ${id}`,
        { retryable: true },
      );
    }
  }

  // Sort by id to match input order
  const sorted = [...results].sort((a, b) => a.id - b.id);
  return sorted.map((r): BatchResult<T> => {
    if (r.error) {
      return {
        ok: false,
        error: new DoubloonError('RPC_ERROR', `RPC error ${r.error.code}: ${r.error.message}`, {
          retryable: r.error.code === -32005,
        }),
      };
    }
    return { ok: true, value: r.result as T };
  });
}
