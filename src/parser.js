import { load } from 'cheerio';
import { PortalError } from './client.js';

function invalid() { throw new PortalError('INVALID_DATA','Unexpected portal data format.'); }
export function rows(payload) {
  if (!Array.isArray(payload?.data)) invalid();
  return payload.data;
}
function numeric(v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return null;
  if (!['number','string'].includes(typeof v) || !Number.isFinite(Number(v))) invalid();
  return Number(v);
}
export function meter(r) {
  if (typeof r?.meterId !== 'string' || !r.meterId) invalid();
  const hierarchy = {};
  for (const level of ['zone','circle','division','subdivision','substation','feeder','dt']) {
    hierarchy[level] = {name:r.hierarchy?.[level]?.name || null, code:r.hierarchy?.[level]?.code || null};
  }
  return {id:r.meterId, serial:r.serialNo, make:r.make, phase:r.phaseType, status:r.installStatus,
    installation_type:r.installType, transformer_id:r.dtCode, hierarchy,
    location:{latitude:numeric(r.geo?.lat),longitude:numeric(r.geo?.lng)}};
}
export function reading(r) {
  if (typeof r?.timestamp !== 'string') invalid();
  return {timestamp:r.timestamp,kwh:numeric(r.kwh),kvah:numeric(r.kvah),voltage_r:numeric(r.voltR)};
}
// Optional adapter for a future HTML-only page. Supply selectors observed in DevTools.
export function parseHtmlRows(html, rowSelector, fields) {
  // TODO: INSERT_TABLE_ROW_SELECTOR_HERE after checking the actual response HTML.
  // TODO: INSERT_FIELD_SELECTORS_HERE as a mapping of field names to relative selectors.
  if (!rowSelector || !fields || !Object.keys(fields).length) throw new Error('Supply verified row and field selectors.');
  const $ = load(html);
  return $(rowSelector).toArray().map(row => Object.fromEntries(Object.entries(fields)
    .map(([key,selector])=>[key,$(row).find(selector).first().text().trim() || null])));
}
