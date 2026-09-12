#!/usr/bin/env bash
# Docker MCP Gateway — ONE INSTANCE PER LOCAL SERVER, with the flags that are
# not safe by default.
#
# WHY THIS SCRIPT EXISTS AT ALL. Measured from the `docker mcp gateway run`
# reference:
#
#   --verify-signatures   DEFAULT OFF   image trust is NOT on by default
#   --block-network       DEFAULT OFF   containers reach the network by default
#   --log-calls           DEFAULT TRUE  tool ARGUMENTS are logged by default
#   --enable-all-servers  off           must stay off; --servers is the allowlist
#
# So "the gateway is secure by default" is false for the two controls that matter
# most, and the invocation has to be specified rather than inherited.
#
# AND THE LIMIT, stated here because this is the file an operator reads:
# OllaSuper connects to the gateway as an MCP client. No MCP method reports which
# flags a gateway was launched with, so OllaSuper CANNOT verify this script ran.
# It is the operator's responsibility, and `/v1/mcp/local` reports
# `flags_verified: false` precisely so nobody reads a green status as proof.
#
# WHAT --verify-signatures AND --block-network ACTUALLY DO IS UNDOCUMENTED.
# They exist in the CLI reference with one-line descriptions and no statement of
# what they verify or block. They are set because setting them cannot hurt; no
# security claim in this repo rests on them until someone with a Docker host has
# demonstrated their effect.
#
# ONE GATEWAY PER SERVER, each on its own port: the gateway aggregates many
# servers behind one endpoint, and the convention it uses to namespace their tool
# names is undocumented. One server per instance keeps per-server identity,
# trust, credentials and network policy structural rather than dependent on
# parsing a string Docker never specified.
#
# The AI service holds NO Docker privileges and NO socket. It only speaks HTTP to
# the loopback port below.
set -euo pipefail

SLUG="${1:?usage: 75-mcp-gateway.sh <slug> <gateway-server-name> <port>}"
SERVER="${2:?missing gateway server name}"
PORT="${3:?missing port}"

: "${MCP_GATEWAY_AUTH_TOKEN:?refusing to start without a gateway auth token}"

echo "starting MCP gateway for ${SLUG} (server=${SERVER}) on 127.0.0.1:${PORT}"

# --transport streaming + --port makes it reachable over HTTP on LOOPBACK ONLY.
# Binding anywhere else would put the auth token on a network; OllaSuper's
# `assert_gateway_url` refuses a non-loopback URL for exactly that reason.
exec docker mcp gateway run \
  --transport streaming \
  --port "127.0.0.1:${PORT}" \
  --servers "${SERVER}" \
  --verify-signatures \
  --block-network \
  --block-secrets \
  --log-calls=false \
  --cpus 1 \
  --memory 512m
