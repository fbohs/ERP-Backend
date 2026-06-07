import { createHash } from 'node:crypto';

// Session and magic-link tokens are 32 bytes of CSPRNG entropy, so a fast,
// deterministic one-way hash (SHA-256) is the right primitive to store them at
// rest: a database leak yields only hashes, never usable tokens. Salting / argon2
// are for low-entropy secrets (passwords) and would also break unique-index
// lookups — neither applies here. Lookups hash the presented token and match by
// hash.
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
