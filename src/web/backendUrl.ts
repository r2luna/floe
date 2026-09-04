// The one thing a backend url has to survive on the way to a browser.
//
// The server-mode plugin builds every machine's url as `ws://<host>` — it was
// written for the desktop, where a preload opens the socket and no page origin
// is involved. A tab is not that: a page served over https opening a cleartext
// ws:// socket is mixed content, and whether it is allowed depends on the
// browser, the address, and the week. Chrome currently permits it to a private
// address; Safari's rules differ, and a carve-out is not something to build on.
//
// So the scheme is decided by the PAGE, not by the config: a page on https
// upgrades every backend to wss. That makes each machine responsible for its
// own TLS, which is how the link already works (Caddy) and how the Mac does
// (`tailscale serve` in front of the gate) — see docs/web.md.

/**
 * The url this page may actually open, or null when it cannot be made safe.
 *
 * Null rather than a silent downgrade: a machine paired by bare IP has no TLS
 * to upgrade to, and connecting anyway would be the mixed-content gamble this
 * exists to remove. The rail shows it as unreachable, which is the truth.
 */
export function secureBackendUrl(url: string, pageProtocol: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
  // An http page is being served over the tailnet or in dev; ws: is no worse
  // than the page itself, so it passes through untouched.
  if (pageProtocol !== 'https:') return url
  if (parsed.protocol === 'wss:') return url

  // A bare IP cannot present a certificate for a name, so there is nothing to
  // upgrade TO. Pair the machine by its tailnet DNS name instead.
  if (isIpLiteral(parsed.hostname)) return null

  parsed.protocol = 'wss:'
  // `ws://host:443` is how a TLS machine has to be spelled in a config whose
  // scheme is hardcoded; once the scheme is right the port is the default and
  // saying it adds nothing.
  if (parsed.port === '443') parsed.port = ''
  return parsed.toString()
}

/** IPv4 dotted-quad or a bracketed IPv6 literal, as URL.hostname reports them. */
export function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
  return hostname.startsWith('[') && hostname.endsWith(']')
}
