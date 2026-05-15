import * as crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from '../cache/redis.js';
import { ConflictError, ValidationError } from '../errors/base.js';
import { logger } from '../logging/index.js';

const TTL_SECONDS = 24 * 60 * 60;
const MAX_KEY_LENGTH = 255;
const IN_FLIGHT_PREFIX = 'in-flight:';

interface StoredResponse {
  statusCode: number;
  contentType: string | null;
  body: string;
  fingerprint: string;
}

function storageKey(method: string, route: string, idempotencyKey: string): string {
  return `idem:${method}:${route}:${idempotencyKey}`;
}

// Ties a stored response to the exact request that produced it. Two callers
// reusing the same key string for different requests must not replay each
// other's response — they get a 409 instead.
function fingerprint(request: FastifyRequest): string {
  const body = request.body === undefined ? '' : JSON.stringify(request.body);
  return crypto.createHash('sha256').update(body).digest('hex');
}

export interface Idempotency {
  before: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  after: (request: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>;
}

/**
 * Idempotency-Key support for HTTP mutations (hard rule #8). Register
 * `before` as a `preHandler` and `after` as an `onSend` hook on the route.
 *
 * Keys live in Redis with a 24h TTL. The header is optional — a request
 * without it is processed normally. A repeated key replays the stored
 * response without re-running the handler; a concurrent duplicate gets 409.
 */
export function createIdempotency(redis: Redis): Idempotency {
  async function before(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const header = request.headers['idempotency-key'];
    if (header === undefined) {
      return undefined;
    }
    if (typeof header !== 'string' || header.length === 0 || header.length > MAX_KEY_LENGTH) {
      throw new ValidationError(
        'Idempotency-Key must be a non-empty string of at most 255 characters',
      );
    }

    const key = storageKey(request.method, request.routeOptions.url ?? request.url, header);
    const fp = fingerprint(request);

    // Atomically claim the key. 'OK' means this is the first request for it.
    const claimed = await redis.set(key, `${IN_FLIGHT_PREFIX}${fp}`, 'EX', TTL_SECONDS, 'NX');
    if (claimed === 'OK') {
      request.idempotencyKey = key;
      return undefined;
    }

    const stored = await redis.get(key);
    if (stored === null || stored.startsWith(IN_FLIGHT_PREFIX)) {
      // A sibling request holding the same key is still running (or just
      // released a failed slot) — the client should retry, not get a partial.
      throw new ConflictError('A request with this Idempotency-Key is already in progress');
    }

    let response: StoredResponse;
    try {
      response = JSON.parse(stored) as StoredResponse;
    } catch {
      logger.error({ key }, 'idempotency: corrupt cache entry, clearing and reprocessing');
      await redis.del(key);
      request.idempotencyKey = key;
      return undefined;
    }
    if (response.fingerprint !== fp) {
      throw new ConflictError('Idempotency-Key was already used for a different request');
    }

    if (response.contentType !== null) {
      reply.header('content-type', response.contentType);
    }
    reply.status(response.statusCode);
    return reply.send(response.body);
  }

  async function after(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
  ): Promise<unknown> {
    const key = request.idempotencyKey;
    if (key === undefined) {
      return payload; // a replay, or a request that carried no Idempotency-Key
    }

    const succeeded = reply.statusCode >= 200 && reply.statusCode < 300;
    const replayableBody =
      typeof payload === 'string' || payload === null || payload === undefined;

    if (succeeded && replayableBody) {
      const contentType = reply.getHeader('content-type');
      const response: StoredResponse = {
        statusCode: reply.statusCode,
        contentType: typeof contentType === 'string' ? contentType : null,
        body: typeof payload === 'string' ? payload : '',
        fingerprint: fingerprint(request),
      };
      await redis.set(key, JSON.stringify(response), 'EX', TTL_SECONDS);
    } else {
      // Failure, or a body we cannot safely replay — release the slot so the
      // client can retry with the same key.
      await redis.del(key);
    }

    return payload;
  }

  return { before, after };
}
