# Urja Meter Ops protocol

These notes describe the upstream portal, distinct from the clean API in [openapi.json](openapi.json). They combine earlier AI-assisted inspection, live checks, current implementation, and the supplied J100000 screenshot. They do not claim that every behavior was personally verified by the candidate. Confirm your own DevTools observations before submission. Never include credential values, cookies, or signing secrets.

## Authentication

The origin is `https://urja-ops.flockenergy.tech`. The client submits `POST /login` with form-encoded `email` and `password`, a same-origin `Origin`, and login-page `Referer`. The ordinary form returned 303 with `Location: /meters` and `Set-Cookie`. The enhanced SvelteKit form can also use a JSON action response; this client uses the ordinary form flow.

The implementation requires the expected redirect and an applicable cookie, stores cookies in a process-local `tough-cookie` jar, and inspects redirects manually. A prior unauthenticated search returned 401 JSON. A 401 or same-origin redirect to `/login` means session rejection. A 403 means forbidden access and does not automatically trigger renewal.

Concurrent requests share login. Ordinary GETs can renew the session and retry once after rejection. If the renewed session is rejected again, the client returns a safe authentication error. Natural lifetime and actual portal cookie attributes remain to be recorded; fixture attributes are not evidence of production policy.

## Discovered paths

| Portal request | Earlier observation | Current use |
| --- | --- | --- |
| `GET /portal/meters/search?q=...&page=1` | Meter ID/serial search, page size 20. | Client helper and tests; public search uses export metadata. |
| `GET /portal/dts?page=1` | Transformer inventory, feeder, and capacity. | Checks existence if no exported meters match a transformer. |
| `GET /portal/meters/{id}/geo` | Coordinates in `data.latitude` and `data.longitude` as strings. | Discovered; metadata uses export coordinates. |
| `GET /portal/meters/{id}/energy` | `data` contains timestamp, kWh, kVAh, and `voltR`. | Per-meter historical readings. |
| `GET /meters/{id}/__data.json` | Indexed SvelteKit loader data with nameplate and hierarchy. | Discovered; metadata uses the common export. |
| `GET /portal/keys` | `data.signingSecret`. | Export signing key, kept on the backend. |
| `GET /portal/export?page=1` | Metadata, hierarchy, location; 403 rows in checked snapshot. | Main inventory source. |

These are upstream paths. The public endpoints are `/meters`, `/meters/{id}`, `/meters/{id}/readings`, and `/transformers/{id}/meters`; see [README.md](README.md).

## Signed export

The Transformers page exposes bulk export. The client retrieves a key using its session and signs four newline-separated lines, with no trailing newline:

```text
GET
/portal/export
page=1
<Unix timestamp in seconds>
```

The algorithm is HMAC-SHA256 with the key as UTF-8 text and lowercase hexadecimal output. Send `x-timestamp` and `x-signature`. This reproduces a normal logged-in operation and does not bypass authentication.

If export rejects the session, the implementation renews authentication, retrieves a fresh key, and signs a new request, once. It does not replay the old signature. A 403 signature rejection is not treated as session expiry; key rotation outside renewal remains unverified.

Inventory validation requires a `data` array and nonnegative safe-integer `total` matching its length. Records must normalize, and meter IDs must be unique. The implementation assumes the response is the full dataset; it does not iterate export pages.

## Normalization

| Portal field | Public field |
| --- | --- |
| `meterId` | `id` |
| `serialNo` | `serial` |
| `make` | `make` |
| `phaseType` | `phase` |
| `installStatus` | `status` |
| `installType` | `installation_type` |
| `dtCode` | `transformer_id` |
| `geo.lat`, `geo.lng` | `location.latitude`, `location.longitude` |
| Hierarchy names/codes | `hierarchy`: zone, circle, division, subdivision, substation, feeder, dt. |
| Reading `timestamp`, `kwh`, `kvah`, `voltR` | `timestamp`, `kwh`, `kvah`, `voltage_r` |

Meter IDs must be nonempty strings. Coordinates and measurements accept finite numbers or numeric strings. Missing/blank numeric values become `null`; invalid numeric values are rejected. Blank hierarchy names/codes become `null`. Not every metadata field is currently validated against the OpenAPI schema.

## Quirks and interpretation

- Earlier inspection found legacy detail parameter pairs and a v2 `installed_meter` inside JSON-encoded `classData`. Export supplies a common metadata format across builds.
- An earlier snapshot contained 22 meters with blank hierarchy codes. Codes can recur under different parent contexts; the solution preserves per-record hierarchy rather than building a globally unique tree.
- DT-007 had two names across records. Membership uses codes and preserves individual names.
- Export coordinates are numbers; the geo endpoint uses strings.
- Sample history contained 337 half-hourly records with day-first timestamps. Timezone, ordering guarantees, supported windows, and register-reset semantics remain unverified.
- kWh and kVAh are preserved as cumulative registers, not interval consumption. No usage differences are calculated.
- Decommissioned meters can retain history. The supplied J100000 screenshot shows nameplate, location, hierarchy, and readings despite that status.

The main path uses JSON. Cheerio's optional `parseHtmlRows` is not connected to implemented routes. Future HTML adapters need selectors verified against raw response HTML because visible data can be populated by JavaScript.

## Cache and dashboard

`src/inventory.js` caches normalized metadata for 60 seconds after successful retrieval and validation. Concurrent misses share one promise. Failed/invalid exports are not cached. Expired refresh failures return errors; there is no backend stale fallback, background refresh, or force-refresh route.

Meter lists, details, transformer membership, and the existence check before readings use inventory. Warm readings requests fetch the energy endpoint after a cached lookup; cold requests can first need login and export.

The dashboard loads inventory pages and renders nameplate, coordinates, and hierarchy from loaded records. Selection fetches readings separately for the table and chart and ignores older responses. Refresh passes through the same cache; failed refresh can leave old browser inventory displayed with a banner. Browser retrieval time is not upstream freshness.

## Failures

The client checks redirects, status, JSON content type, and JSON parsing. Timeouts map to 504, connection/server failures generally to 502, and rate limiting to 503 without an automatic retry loop. The default timeout is 15 seconds per upstream request, not an overall route deadline. Authentication retries are bounded. Caller errors omit raw upstream bodies, headers, and credentials.

## Verification record

| Date | Check | Result and scope |
| --- | --- | --- |
| 5 November 2026 | Live client and inventory | 403 meters, 337 sample readings, 13 DT-007 members, cached-array reuse. |
| 5 November 2026 | Local HTTP smoke checks | Health, dashboard, Swagger, and OpenAPI returned 200. |
| 6 November 2026 | `npm test` | 16/16 passed on Node 22.17.1; project declares Node 24+. |

Session rejection, renewal, safe failures, timeout, and fresh signing are covered by fixtures, not by waiting for natural live expiry. Cache tests check concurrency, expiry, invalid/duplicate exports, and retry. A simulated-document test checks immediate nameplate rendering, readings-only fetching, and ignoring an older response. It does not check real browser layout, scrolling, or every interaction. Visual verification of the latest profile/table is pending. No new live portal check was performed on 6 November.

## Remaining investigation

Record sanitized cookie attributes, natural session lifetime, key rotation, signing timestamp tolerance, rate limits, history windows, timezone, and ordering guarantees. Compare representative export/nameplate values across both meter builds. Add personal observed requests, response shapes, and normalization decisions without secrets. Recheck on the declared Node 24+ runtime before submission.
