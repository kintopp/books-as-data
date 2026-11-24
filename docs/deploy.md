# Hosted deployment

`src/http.js` serves the same ten tools over stateless Streamable HTTP, so claude.ai and other web clients can use them without a local install. `src/index.js` stays the stdio entry, and the only one the `.mcpb` bundle ships. The server holds no credentials and only reads the public `books-as-data.ch` services.

The endpoint is `POST /mcp`. Every other path answers 404. `GET /health` is public and returns `{ status, server, version, commit, node }`. `GET` and `DELETE` on the endpoint answer 405, because there are no sessions.

The HTTP entry serves anonymous access only. It refuses to start with `SGBR_ACCESS_TOKEN` set, because a shared endpoint must not serve ACL-restricted records to everyone who has the URL.

## Run locally

```sh
npm run serve             # listens on 0.0.0.0:3000
PORT=8080 npm run serve
```

Point the inspector at `http://localhost:3000/mcp` with `npx @modelcontextprotocol/inspector`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port (Railway sets it). `0` picks a free port. |
| `MCP_ALLOWED_ORIGINS` | claude.ai, claude.com, chatgpt.com and their subdomains, chat.mistral.ai, console.mistral.ai | Comma-separated hostnames or `*.host` globs. **Replaces** the defaults, so list them again to add one. `*` alone turns the check off. A mismatch is 403. An entry that is no hostname stops the server at startup. |
| `MCP_ALLOWED_HOSTS` | unset | Comma-separated hostnames the `Host` header must match. `RAILWAY_PUBLIC_DOMAIN` and localhost are added. With neither set, the Host check is off. An entry that is no hostname, a glob included, stops the server at startup. |
| `SGBR_HTTP_RESPONSE_TIMEOUT_MS` | `235000` | Wall-clock limit per request to the endpoint, then 504, or the stream is cut if it has started. Kept under claude.ai's 240 s per tool call. |
| `SGBR_HTTP_MAX_INFLIGHT` | `16` | Concurrent requests to the endpoint. More get 503 with `Retry-After: 5`. |

The other variables in the README's configuration table apply too, except `SGBR_ACCESS_TOKEN`. `SGBR_ENTRY_POINT` defaults to `http`, so the outbound `User-Agent` tells hosted traffic apart.

Every tool call writes one JSON line to stderr with a level, the tool, the latency and whether it succeeded. It never holds the input or an error message, which can quote the input: a failure is named only by its error class and HTTP status. The Origin check lets through a missing Origin, `null`, schemes other than http(s), and loopback. Requests over 1 MiB get 413, and compressed request bodies 415. Railpack installs the Node version in `.nvmrc`.

## Railway

The service `books-as-data`, in the Railway project `endearing-warmth` shared with other services, runs `node src/http.js` with `/health` as its health check, one replica in `europe-west4-drams3a` and a 1 GB memory limit. Its configuration is `.railway/railway.ts`, which declares the partial `books-as-data`, so it never touches the other services of the project.

- `railway config plan` is read only. Stop on any change to another service or to a variable.
- `railway config apply --yes` applies it and starts a deployment from `main` at once. Claude's auto mode blocks it, so run it yourself (`! railway config apply --yes` in Claude Code).
- Code deploys from GitHub on every push to `main` that touches `src/`, `package.json` or `package-lock.json`. A push of notes, tests, docs, scripts or the skill does not redeploy.
- Variables are set by hand and stay out of the file, which declares them unmanaged so that an apply does not drop them: `railway variable set MCP_ALLOWED_HOSTS=<host> -s books-as-data`. Setting one redeploys the service; add `--skip-deploys` to set it without, and redeploy later with `railway redeploy -s books-as-data --yes`.
- A failed startup (a token set, a bad Origin entry) fails the health check, so Railway keeps the previous deployment serving.
- The public domain comes from `railway domain -s books-as-data`.

## Add it to claude.ai

Settings, Customize, Connectors, Add custom connector. Use the URL `https://<domain>/mcp` and no authentication.

## Limits

- claude.ai gives up on a tool call after 240 s. The server cuts a request at 235 s; a long `sgbr_locate_text` page scan is the slowest call.
- Results are capped at about 150,000 characters.
- The server is stateless: no session survives between requests.
- All hosted users reach the backend from one address. The platform's Terms of Use restrict mass downloads, so do not script bulk calls against the hosted instance.
