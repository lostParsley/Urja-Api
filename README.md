# Urja Meter API

A local, read-only API over the Urja Meter Ops portal for the Flock Energy engineering assignment. Other programs can search meters, inspect nameplate and network information, retrieve historical readings, and look up transformer membership without managing the portal login. A custom dashboard presents the same data to operations users.

The backend logs in on demand, keeps session cookies in memory, retrieves metadata through a signed bulk export, and normalizes portal fields into JSON responses. It does not modify meter or transformer records.

## Install and run

Use Node.js 24 or later, as declared in `package.json`, and npm. From this directory:

```sh
npm ci
```

Create local configuration without overwriting an existing `.env`:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Set `PORTAL_PASSWORD` in `.env` using the assignment access details. Set `PORTAL_EMAIL` if you need to override the built-in operator account. Keep credentials in `.env`; do not commit credentials, cookies, signing secrets, or authenticated request captures. `.gitignore` excludes local environment files while allowing `.env.example`.

```sh
npm start
```

| Setting | Behavior |
| --- | --- |
| `PORTAL_PASSWORD` | Required at startup. |
| `PORTAL_EMAIL` | Optional override for the portal account. |
| `PORT` | Local port, default `3000`. |
| `HOST` | Bind address, default `127.0.0.1`. |

The upstream portal address and 15-second timeout per upstream request are set in `src/index.js`. Login, signing, and renewal can involve several upstream requests, so this is not an overall route deadline. Proxy configuration depends on the runtime/environment and is not managed by the application.

Open these addresses after startup:

- Dashboard: [http://127.0.0.1:3000/docs/](http://127.0.0.1:3000/docs/) (also available at `/`).
- Swagger UI: [http://127.0.0.1:3000/api-docs/](http://127.0.0.1:3000/api-docs/).
- Specification: [http://127.0.0.1:3000/openapi.json](http://127.0.0.1:3000/openapi.json).

Use `npm run dev` for Node's watch mode. No frontend build or database is required.

## API

| Request | Response |
| --- | --- |
| `GET /health` | Process liveness: `{"status":"ok"}`. Does not contact the portal. |
| `GET /meters?q=SE33962&page=1&limit=20` | Case-insensitive partial search by meter ID or serial, with pagination. |
| `GET /meters/J100000` | Nameplate fields, transformer code, hierarchy, and coordinates. |
| `GET /meters/J100000/readings` | Timestamped kWh, kVAh, and R-phase voltage in the default portal history window. |
| `GET /transformers/DT-007/meters?page=1&limit=20` | Paginated meters attached to a transformer code. |

For example, use `curl` (or `curl.exe` in Windows PowerShell):

```sh
curl "http://127.0.0.1:3000/meters?q=SE33962&page=1&limit=20"
curl "http://127.0.0.1:3000/meters/J100000"
curl "http://127.0.0.1:3000/meters/J100000/readings"
curl "http://127.0.0.1:3000/transformers/DT-007/meters"
```

List responses contain `data`, `total`, `page`, and `limit`. Defaults are page 1 and limit 20; the maximum limit is 100. An empty search result returns an empty list. An unknown meter or transformer returns 404. A transformer confirmed to exist but with no attached meters returns an empty list.

Readings responses contain `meter_id` and `data`. Missing numeric measurements become `null`. Energy values are cumulative registers as supplied, not calculated interval consumption. Timestamps retain their portal representation because the timezone is unverified.

Errors have a consistent shape:

```json
{"error":{"code":"PORTAL_TIMEOUT","message":"The portal request timed out."}}
```

Invalid query values return 400 when validated; missing resources return 404. Portal authentication, format, connection, and server failures generally return 502; rate limiting returns 503; upstream request timeouts return 504. Unexpected application failures return a generic 500. Raw Axios errors are not exposed because they can contain sensitive request data. See [openapi.json](openapi.json) for response schemas.

## Dashboard

The dashboard loads all inventory pages, then applies meter/serial search, status filters, transformer filters, and pagination locally. Fleet cards describe the complete loaded inventory. Filters affect the table and CSV export. Transformer counts include distinct codes attached to meters, not empty transformers.

Click a meter ID to select it and scroll to its profile. Nameplate, coordinates, and network hierarchy display immediately from loaded inventory. Historical readings are fetched separately and shown in a scrollable table with timestamp, kWh, kVAh, and V(R). The chart supports kWh, kVAh, and voltage. Missing numeric values break chart segments rather than being interpolated. The arrow and View meter details button also open a profile dialog with a JSON link.

Switching meters aborts the previous browser request and ignores responses from older selections. Readings have loading, empty, and error states; selecting the meter again retries. Profiles remain available when readings fail. Browser cancellation does not guarantee that upstream server work stops.

Refresh reloads through the backend metadata cache; it does not force an upstream refresh. Inventory time reports browser retrieval time, not portal freshness. If refresh fails, previously fetched inventory can remain visible with an error banner. The health indicator checks only the API process.

The interface uses plain HTML, CSS, JavaScript, and SVG, with responsive styles and reduced-motion handling. Google Fonts are optional, with system fallbacks. Visual browser verification of the latest inline profile/table remains pending.

## Project architecture

```text
urja-api/
|-- src/                    Backend API and portal integration
|   |-- index.js            Express routes, dashboard hosting, Swagger, errors
|   |-- client.js           Portal login, cookies, Axios requests, export signing
|   |-- inventory.js        Validated metadata cache (60 seconds), shared fetches
|   `-- parser.js           Meter/readings normalization, optional HTML adapter
|-- public/                 Browser dashboard (no frontend build step)
|   |-- index.html          Inventory, nameplate, location, readings table, dialog
|   |-- dashboard.js        API calls, selection, filters, charts, CSV export
|   `-- dashboard.css       Dashboard styling and responsive layouts
|-- openapi.json            Public API contract (OpenAPI 3.0.3)
|-- README.md               Setup, architecture, API usage, decisions, limitations
|-- PROTOCOL.md             Portal endpoints, authentication, signing, data quirks
|-- REFLECTION.md           Assignment reflection answers
|-- package.json            Dependencies, runtime requirement, npm commands
|-- package-lock.json       Locked dependency versions
|-- .env.example            Configuration template without real credentials
|-- .env                    Private local configuration; ignored by Git
|-- .gitignore              Excludes local secrets and generated files
`-- node_modules/           Installed dependencies; generated and ignored by Git
```

Requests enter through `src/index.js`. Meter metadata passes through the inventory cache, which uses `client.js` to retrieve a signed export on a cache miss and `parser.js` to normalize it before caching. Readings first check meter existence through inventory, then fetch the selected meter's history through the portal client and normalize the response. The dashboard calls these same local JSON endpoints; portal credentials and cookies stay on the backend.

```text
Express application (src/index.js)
|-- Dashboard: / and /docs/
|   `-- public/ assets --> local JSON API requests
|-- API documentation: /api-docs/ and /openapi.json
|-- Health: /health --> process liveness, no portal call
`-- Data routes: /meters, /meters/:id, /meters/:id/readings,
    |           /transformers/:id/meters
    |-- inventory.js --> 60-second normalized metadata cache
    |   `-- Cache miss --> client.js --> authenticated signed portal export
    |                     `-- parser.js --> validated, normalized inventory
    |-- Readings --> client.js --> portal energy endpoint --> parser.js
    `-- Unmatched transformer code --> client.js --> portal transformer pages
```

### File responsibilities

| File | Responsibility |
| --- | --- |
| `src/client.js` | Axios requests, scoped cookies, shared login, renewal, signed exports, and safe errors. |
| `src/inventory.js` | Validated metadata cache and shared in-flight retrieval. |
| `src/parser.js` | Normalized fields and an optional Cheerio HTML adapter. |
| `src/index.js` | Express routes, pagination, resource lookup, dashboard hosting, and Swagger UI. |
| `public/index.html` | Dashboard structure, inline profile, readings table, and detail dialog. |
| `public/dashboard.js` | Inventory loading, filtering, selection, charts, and CSV export. |
| `public/dashboard.css` | Styling and responsive layouts. |
| `test/session.test.js` | Fixture tests for authentication, failures, timeouts, and export renewal. |
| `test/inventory.test.js` | Concurrency, cache expiry, invalid exports, and retry after failure. |
| `test/dashboard.test.js` | Simulated-document selection and stale-response test. |

The main extraction path uses JSON. Cheerio's `parseHtmlRows` is an unused optional adapter; implemented routes need no HTML selectors. The portal search helper is tested, but public meter search filters the normalized export locally.

## Assumptions and design decisions

- The export contains the full inventory in one response. Its total must match the row count, records must pass normalization, and meter IDs must be unique before caching.
- Export metadata provides a common representation across meter builds. Per-meter readings are fetched separately rather than loading every history upfront.
- Transformer membership uses exact codes. Per-record hierarchy names and aliases are preserved; blank hierarchy names/codes become `null`.
- Timestamps and energy registers are preserved without inferring timezone, reset behavior, or interval usage.
- Cookie and cache state are process-local. Login attempts are shared; ordinary GETs can retry once after session rejection. Signed exports are rebuilt with a fresh key after rejection.
- Loopback binding suits local evaluation. The local API has no caller authentication; exposing it elsewhere needs an appropriate access policy.

## Caching and latency trade offs

Validated metadata is cached for 60 seconds after successful retrieval and normalization. Concurrent cache misses share one retrieval and validation. Failures are not cached. An expired refresh failure returns an error rather than serving expired backend data. There is no background refresh or force-refresh route.

This reduces repeated exports during pagination and selection at the cost of up to 60 seconds of metadata staleness relative to retrieval. Readings are fetched on each selection and are not cached by this service. Browser profiles use loaded inventory, which can remain displayed until refresh.

The earlier flow requested details already loaded in the browser and repeatedly exported metadata. Reuse and shared retrieval remove redundant work. They do not establish the exact cause of the reported 504 or eliminate portal timeouts.



## Intentionally left out

Database persistence and distributed caching are unnecessary for the current small, local inventory. Custom history windows, calculated consumption, register-reset detection, spatial queries, and a reconstructed network graph need further investigation or requirements. Public-service authentication and deployment infrastructure are outside the local submission scope.

## With more time

Add HTTP route tests and browser checks for clicks, scrolling, filters, failures, and mobile layouts. Confirm session lifetime, signing-key rotation, rate limits, timestamp ordering/timezone, and supported reading windows. Measure cold and warm latency before changing timeout/cache policies. Validate normalized fields against OpenAPI schemas.

If the service runs across multiple instances, use Redis for a shared metadata cache with a 60-second TTL. This would let instances reuse cached inventory instead of each maintaining a separate copy. Add coordination for concurrent cache misses to avoid duplicate portal exports, and define behavior when Redis is unavailable.

Filtering currently scans an in-memory inventory, and the dashboard downloads every page. Much larger datasets would need a persistent indexed query layer, bounded server-side filtering, and a different frontend loading strategy. A paginated export would require replacing the full-response assumption.

## Supporting notes and submission

- [PROTOCOL.md](PROTOCOL.md): portal authentication, endpoints, signing, normalization, observations, and unresolved questions.
- [REFLECTION.md](REFLECTION.md): the five reflection answers, marked for personal review.
- [openapi.json](openapi.json): OpenAPI 3.0.3 description of this API.

Development and review were AI-assisted. Verify your own DevTools findings and personalize the reflection so the submission represents your investigation accurately. Public GitHub publication and the email handoff are separate submission steps; this documentation does not claim they have happened.
