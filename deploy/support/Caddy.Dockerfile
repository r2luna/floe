# Caddy + two plugins, built the official way (xcaddy):
#  • caddy-dns/cloudflare      → wildcard TLS via DNS-01, no ports exposed
#  • caddy-docker-proxy        → per-worktree app routes discovered from container
#                                labels, so routes come and go with the containers
FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/lucaslorentz/caddy-docker-proxy/v2

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# Run in docker-proxy mode: watch labels, merge with the base Caddyfile.
CMD ["caddy", "docker-proxy"]
