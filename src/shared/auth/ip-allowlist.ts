// Parses a comma-separated allowlist of exact IPs and IPv4 CIDR ranges into a
// matcher. IPv4 entries support CIDR (a.b.c.d/n); IPv6 and exact-IPv4 entries
// match by string equality. Fail-closed: a blank list allows nothing, and a
// malformed entry is dropped (never silently widens access). See ADR 0002.

interface Cidr {
  base: number;
  mask: number;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(ip: string): number | null {
  const match = IPV4.exec(ip);
  if (match === null) {
    return null;
  }
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (octet > 255) {
      return null;
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// Strips the IPv4-mapped IPv6 prefix so a v4 client arriving over a v6 socket
// (e.g. "::ffff:203.0.113.5") is matched against the IPv4 rules.
function normalize(ip: string): string {
  const lower = ip.toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower;
}

export interface IpAllowlist {
  allows(ip: string): boolean;
}

export function createIpAllowlist(raw: string): IpAllowlist {
  const exact = new Set<string>();
  const cidrs: Cidr[] = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }

    const slash = trimmed.indexOf('/');
    if (slash === -1) {
      exact.add(normalize(trimmed));
      continue;
    }

    const base = ipv4ToInt(trimmed.slice(0, slash));
    const bits = Number(trimmed.slice(slash + 1));
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      continue;
    }
    // A /0 must match everything; a 32-bit left shift is undefined in JS, so
    // the all-zero mask is special-cased.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    cidrs.push({ base: (base & mask) >>> 0, mask });
  }

  return {
    allows(ip: string): boolean {
      const normalized = normalize(ip);
      if (exact.has(normalized)) {
        return true;
      }
      const asInt = ipv4ToInt(normalized);
      if (asInt === null) {
        return false;
      }
      return cidrs.some((cidr) => ((asInt & cidr.mask) >>> 0) === cidr.base);
    },
  };
}
