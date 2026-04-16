import type { EntitlementCheck } from '@doubloon/core';
import { MemoryDedupStore } from './dedup.js';
import type { DedupStore } from './dedup.js';
import type { RateLimiterConfig } from './rate-limiter.js';
import { createServer } from './server.js';
import type { ServerConfig } from './server.js';
import { defineConfig } from './define-config.js';
import type { DoubloonProductConfig, DestinationLike } from './define-config.js';
import type { MintRetryOpts } from './mint-retry.js';
import type { Logger } from '@doubloon/core';

const RESERVED_NAMES = new Set(['webhook', 'check', 'health', 'products', 'entitlements', 'batch']);

export interface NamespaceConfig {
  products: DoubloonProductConfig[];
  destination: DestinationLike;
  bridges?: ServerConfig['bridges'];
  hooks?: {
    beforeMint?: ServerConfig['beforeMint'];
    afterMint?: ServerConfig['afterMint'];
    afterRevoke?: ServerConfig['afterRevoke'];
    onAcknowledgmentRequired?: ServerConfig['onAcknowledgmentRequired'];
    onMintFailure?: ServerConfig['onMintFailure'];
  };
  mintRetry?: MintRetryOpts;
}

export interface NamespacedServerConfig {
  namespaces: Record<string, NamespaceConfig>;
  /** Default onMintFailure used when a namespace doesn't define its own. */
  onMintFailure: ServerConfig['onMintFailure'];
  /** Shared dedup store across all namespaces. Defaults to a single MemoryDedupStore. */
  dedup?: DedupStore;
  /** Rate limit config applied to each namespace. Defaults to 60 req/min. */
  rateLimiter?: RateLimiterConfig | false;
  logger?: Logger;
}

type NamespaceServer = ReturnType<typeof createServer>;

export interface NamespacedServer {
  /**
   * Route an incoming request to the correct namespace.
   * Extracts namespace from the first URL path segment.
   */
  handleRequest(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: Buffer | string;
  }): Promise<{ status: number; body?: string; headers?: Record<string, string> }>;

  /** Direct access to a namespace's server instance. */
  getNamespace(name: string): NamespaceServer | undefined;

  /** Names of all registered namespaces. */
  namespaces(): string[];

  /** Check entitlement within a specific namespace. */
  checkEntitlement(namespace: string, productId: string, wallet: string): Promise<EntitlementCheck>;
}

/**
 * Create a namespaced Doubloon server that routes to multiple app configurations.
 *
 * Each namespace gets its own products, destination, and bridges. Dedup store is
 * shared across all namespaces to prevent cross-namespace duplicate processing.
 *
 * URL routing:
 * - POST  /{ns}/webhook              → namespace webhook handler
 * - GET   /{ns}/check/{product}/{wallet} → namespace entitlement check
 * - GET   /{ns}/health               → 200 OK
 * - Unknown namespace                → 404
 *
 * @example
 * ```ts
 * const ns = createNamespacedServer({
 *   namespaces: {
 *     'app-a': { products: [...], destination: starfishDest, bridges: { stripe } },
 *     'app-b': { products: [...], destination: localChain },
 *   },
 *   onMintFailure: async (e) => console.error(e),
 * });
 *
 * // In your HTTP server:
 * const result = await ns.handleRequest({ method, url, headers, body });
 * ```
 */
export function createNamespacedServer(config: NamespacedServerConfig): NamespacedServer {
  // Validate namespace names
  for (const name of Object.keys(config.namespaces)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Invalid namespace name: "${name}". Use only a-z, A-Z, 0-9, _ or -.`);
    }
    if (RESERVED_NAMES.has(name)) {
      throw new Error(`Namespace name "${name}" is reserved.`);
    }
  }

  // Shared dedup across all namespaces
  const sharedDedup: DedupStore = config.dedup ?? new MemoryDedupStore();

  // Build a server per namespace
  const servers = new Map<string, NamespaceServer>();

  for (const [name, ns] of Object.entries(config.namespaces)) {
    const { serverConfig } = defineConfig({
      products: ns.products,
      destination: ns.destination,
      bridges: ns.bridges,
      hooks: {
        beforeMint: ns.hooks?.beforeMint,
        afterMint: ns.hooks?.afterMint,
        afterRevoke: ns.hooks?.afterRevoke,
        onAcknowledgmentRequired: ns.hooks?.onAcknowledgmentRequired,
      },
      onMintFailure: ns.hooks?.onMintFailure ?? config.onMintFailure,
      mintRetry: ns.mintRetry,
      dedup: sharedDedup,
      rateLimiter: config.rateLimiter,
      logger: config.logger,
    });
    servers.set(name, createServer(serverConfig));
  }

  function parseRequest(req: { method: string; url: string }): {
    namespace: string;
    subPath: string;
  } | null {
    // Strip query string
    const rawPath = req.url.split('?')[0] ?? '';
    const parts = rawPath.replace(/^\//, '').split('/');
    const namespace = parts[0] ?? '';
    const subPath = '/' + parts.slice(1).join('/');
    if (!namespace) return null;
    return { namespace, subPath };
  }

  return {
    async handleRequest(req) {
      const parsed = parseRequest(req);
      if (!parsed) return { status: 404, body: 'No namespace in path' };

      const { namespace, subPath } = parsed;
      const server = servers.get(namespace);
      if (!server) return { status: 404, body: `Unknown namespace: ${namespace}` };

      // Health check
      if (req.method === 'GET' && (subPath === '/health' || subPath === '/health/')) {
        return { status: 200, body: JSON.stringify({ ok: true, namespace }) };
      }

      // Webhook
      if (req.method === 'POST' && (subPath === '/webhook' || subPath === '/webhook/')) {
        return server.handleWebhook({ headers: req.headers, body: req.body ?? '' });
      }

      // Entitlement check: GET /check/{productId}/{wallet}
      const checkMatch = subPath.match(/^\/check\/([^/]+)\/([^/]+)\/?$/);
      if (req.method === 'GET' && checkMatch) {
        const productId = decodeURIComponent(checkMatch[1]!);
        const wallet = decodeURIComponent(checkMatch[2]!);
        const result = await server.checkEntitlement(productId, wallet);
        return { status: 200, body: JSON.stringify(result), headers: { 'Content-Type': 'application/json' } };
      }

      return { status: 404, body: 'Not found' };
    },

    getNamespace(name: string): NamespaceServer | undefined {
      return servers.get(name);
    },

    namespaces(): string[] {
      return Array.from(servers.keys());
    },

    async checkEntitlement(namespace: string, productId: string, wallet: string): Promise<EntitlementCheck> {
      const server = servers.get(namespace);
      if (!server) throw new Error(`Unknown namespace: ${namespace}`);
      return server.checkEntitlement(productId, wallet);
    },
  };
}
