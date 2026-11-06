import { createHmac } from 'node:crypto';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';

// One instance per process: all future API routes share this authenticated client.
export class PortalClient {
  #http;
  #jar = new CookieJar();
  #baseUrl;
  #email;
  #password;
  #loginPromise;
  #authenticated = false;
  #generation = 0;

  constructor({ baseUrl, email, password, timeoutMs = 15000 }) {
    this.#baseUrl = new URL(baseUrl).origin;
    this.#email = email;
    this.#password = password;
    this.#http = axios.create({
      baseURL: this.#baseUrl,
      adapter: 'fetch',
      fetchOptions: { redirect: 'manual' },
      timeout: timeoutMs,
      // Inspect redirects ourselves: never silently return a login page as data.
      maxRedirects: 0,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(body) => body],
      maxContentLength: 5 * 1024 * 1024,
      maxBodyLength: 64 * 1024,
      headers: { Accept: 'application/json' },
    });
  }

  get sessionInfo() {
    return {
      authenticated: this.#authenticated,
      successfulLogins: this.#generation,
    };
  }

  async login() {
    if (this.#loginPromise) return this.#loginPromise;
    if (this.#authenticated) return;
    // Share an in-flight login so concurrent requests do not create competing sessions.
    this.#loginPromise = this.#authenticate();
    try {
      await this.#loginPromise;
    } finally {
      this.#loginPromise = undefined;
    }
  }

  async #authenticate() {
    await this.#jar.removeAllCookies();
    const body = new URLSearchParams({ email: this.#email, password: this.#password });
    const response = await this.#request({
      method: 'POST',
      url: '/login',
      data: body.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: this.#baseUrl,
        Referer: `${this.#baseUrl}/login`,
        Accept: 'text/html',
      },
    });
    this.#checkServerFailure(response);
    const destination = this.#redirectTarget(response);
    const cookies = await this.#jar.getCookies(`${this.#baseUrl}/portal/meters/search`);
    if (response.status !== 303 || destination?.pathname !== '/meters' || cookies.length === 0) {
      throw new PortalError('PORTAL_AUTH_FAILED', 'The portal did not establish an authenticated session.');
    }
    this.#authenticated = true;
    this.#generation += 1;
  }

  async searchMeters({ q = '', page = 1 } = {}) {
    if (typeof q !== 'string' || !Number.isInteger(page) || page < 1) {
      throw new PortalError('INVALID_INPUT', 'Search requires a string query and a positive integer page.', 400);
    }
    const params = new URLSearchParams({ q, page: String(page) });
    const result = await this.#getJson(`/portal/meters/search?${params}`);
    if (!Array.isArray(result?.data) ||
        !Number.isInteger(result.total) || result.total < 0 ||
        !Number.isInteger(result.page) || result.page < 1 ||
        !Number.isInteger(result.pageSize) || result.pageSize < 1) {
      throw new PortalError('PORTAL_INVALID_RESPONSE', 'The portal returned an unexpected meter-list structure.');
    }
    return result;
  }

  async metadata() {
    try {
      return await this.#signedExport();
    } catch (error) {
      if (error.code !== 'EXPORT_SESSION_EXPIRED') throw error;
      // A new session may have a different key. Rebuild the entire signed request once.
      return this.#signedExport();
    }
  }

  async #signedExport() {
    const key = await this.#getJson('/portal/keys');
    if (!key?.data?.signingSecret) throw new PortalError('INVALID_EXPORT_KEY','Portal export key unavailable.');
    const timestamp = String(Math.floor(Date.now()/1000));
    const signature = createHmac('sha256',key.data.signingSecret)
      .update(['GET','/portal/export','page=1',timestamp].join('\n')).digest('hex');
    return this.#getJson('/portal/export?page=1', {'x-timestamp':timestamp,'x-signature':signature}, false);
  }

  readings(id) { return this.#getJson('/portal/meters/'+encodeURIComponent(id)+'/energy'); }
  transformers(page) { return this.#getJson('/portal/dts?page='+page); }

  async #getJson(path, headers = {}, retry = true) {
    await this.login();
    const observedGeneration = this.#generation;
    let response = await this.#request({ method: 'GET', url: path, headers });
    if (this.#sessionRejected(response)) {
      if (!retry) { this.#authenticated = false; throw new PortalError("EXPORT_SESSION_EXPIRED","Export session expired. Retry the request.",503); }
      // A concurrent request may already have renewed the session.
      if (this.#generation === observedGeneration) this.#authenticated = false;
      await this.login();
      response = await this.#request({ method: 'GET', url: path, headers });
      if (this.#sessionRejected(response)) {
        this.#authenticated = false;
        throw new PortalError('PORTAL_AUTH_FAILED', 'The portal rejected the renewed session.');
      }
    }
    this.#checkServerFailure(response);
    if (response.status === 403) {
      throw new PortalError('PORTAL_FORBIDDEN', 'The portal refused access to this resource.');
    }
    if (response.status === 404) {
      throw new PortalError('PORTAL_NOT_FOUND', 'The requested portal resource was not found.', 404);
    }
    if (response.status !== 200 ||
        !/application\/json\b/i.test(response.headers['content-type'] || '')) {
      throw new PortalError('PORTAL_INVALID_RESPONSE', 'The portal returned an unexpected response.');
    }
    try {
      return JSON.parse(response.data);
    } catch {
      throw new PortalError('PORTAL_INVALID_RESPONSE', 'The portal returned malformed JSON.');
    }
  }

  #redirectTarget(response) {
    if (response.status < 300 || response.status >= 400 || !response.headers.location) return null;
    try {
      const target = new URL(response.headers.location, this.#baseUrl);
      return target.origin === this.#baseUrl ? target : null;
    } catch {
      return null;
    }
  }

  #sessionRejected(response) {
    return response.status === 401 || this.#redirectTarget(response)?.pathname === '/login';
  }

  #checkServerFailure(response) {
    if (response.status === 429) {
      throw new PortalError('PORTAL_RATE_LIMITED', 'The portal is rate limiting requests. Try again later.', 503);
    }
    if (response.status >= 500) {
      throw new PortalError('PORTAL_UNAVAILABLE', 'The portal is temporarily unavailable.');
    }
  }

  async #request(options) {
    try {
      // Associate cookies with the real HTTPS origin, even when Axios uses a proxy.
      // Redirects are disabled, so this URL is also the response cookie's origin.
      const url = new URL(options.url, this.#baseUrl);
      if (url.origin !== this.#baseUrl) {
        throw new PortalError('PORTAL_INVALID_RESPONSE', 'Unexpected portal destination.');
      }
      const cookie = await this.#jar.getCookieString(url.href);
      const response = await this.#http.request({
        ...options,
        headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
      });
      for (const value of [].concat(response.headers['set-cookie'] || [])) {
        await this.#jar.setCookie(value, url.href, { ignoreError: true });
      }
      return response;
    } catch (error) {
      if (error instanceof PortalError) throw error;
      // Axios errors can include request bodies and cookies. Never expose or log them.
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        throw new PortalError('PORTAL_TIMEOUT', 'The portal request timed out.', 504);
      }
      throw new PortalError('PORTAL_UNAVAILABLE', 'Could not reach the portal.');
    }
  }
}
export class PortalError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'PortalError';
    this.code = code;
    this.status = status;
  }
}
