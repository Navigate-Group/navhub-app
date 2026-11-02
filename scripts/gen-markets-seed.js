const fs = require('fs');
const ROOT = '/home/builder/work/jobs/0ccfc780-5144-4588-ac63-4830f135f91e';
const d = require(ROOT + '/markets_sample.json');

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
};
const num = (v) => (v === null || v === undefined) ? 'NULL' : String(v);
const jb = (v) => "'" + JSON.stringify(v ?? null).replace(/'/g, "''") + "'::jsonb";
const bool = (v) => v ? 'true' : 'false';

let out = [];
out.push('-- Migration 073: Markets seed data (MKT-2)');
out.push('-- ──────────────────────────────────────────────────────────────────────────');
out.push('-- Loads markets_sample.json VERBATIM into the data model from migration 072.');
out.push('-- GENERATED from markets_sample.json (scripts/gen-markets-seed.js) — do not');
out.push('-- hand-edit; regenerate if the sample changes. Idempotent via upserts.');
out.push('--');
out.push('-- Row counts: 2 commodities, 84 geo_units (52 countries + 32 regions),');
out.push('-- 5 seasons, 7 measures, 21 sources, 14 prices, 386 observations, 1 fx rate,');
out.push('-- 6 structure rows, 15 operators.');
out.push('');

// Commodities
out.push('-- ── commodities ────────────────────────────────────────────────────────────');
let ci = 0;
for (const key of Object.keys(d.commodities)) {
  const c = d.commodities[key];
  out.push(
    `INSERT INTO markets_commodities (id, name, scope_note, season_basis, seasons, default_season, default_country, codes, valuation_methods, structure, gap_sources, crm, sort_order) VALUES (` +
    [q(c.id), q(c.name), q(c.scope_note), q(c.season_basis), jb(c.seasons), q(c.default_season), q(c.default_country), jb(c.codes), jb(c.valuation_methods), jb(c.structure), jb(c.gap_sources), c.crm ? jb(c.crm) : 'NULL', ci++].join(', ') +
    `)\nON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, scope_note=EXCLUDED.scope_note, season_basis=EXCLUDED.season_basis, seasons=EXCLUDED.seasons, default_season=EXCLUDED.default_season, default_country=EXCLUDED.default_country, codes=EXCLUDED.codes, valuation_methods=EXCLUDED.valuation_methods, structure=EXCLUDED.structure, gap_sources=EXCLUDED.gap_sources, crm=EXCLUDED.crm, sort_order=EXCLUDED.sort_order, updated_at=now();`
  );
}
out.push('');

// Geo units — insert countries first (parents) then regions to satisfy FK
out.push('-- ── geo_units (countries first, then regions for parent FK) ────────────────');
const geoSorted = [...d.geo].sort((a,b) => (a.level==='country'?0:1) - (b.level==='country'?0:1));
for (const g of geoSorted) {
  out.push(
    `INSERT INTO markets_geo_units (id, name, level, m49, continent, zones, parent, region_type) VALUES (` +
    [q(g.id), q(g.name), q(g.level), q(g.m49), q(g.continent), jb(g.zones ?? []), q(g.parent), q(g.region_type)].join(', ') +
    `)\nON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, level=EXCLUDED.level, m49=EXCLUDED.m49, continent=EXCLUDED.continent, zones=EXCLUDED.zones, parent=EXCLUDED.parent, region_type=EXCLUDED.region_type;`
  );
}
out.push('');

// Seasons
out.push('-- ── seasons ────────────────────────────────────────────────────────────────');
let si = 0;
for (const s of d.seasons) {
  out.push(
    `INSERT INTO markets_seasons (id, label, start_date, end_date, sort_order) VALUES (` +
    [q(s.id), q(s.label), q(s.start), q(s.end), si++].join(', ') +
    `)\nON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date, sort_order=EXCLUDED.sort_order;`
  );
}
out.push('');

// Measures
out.push('-- ── measures ───────────────────────────────────────────────────────────────');
let mi = 0;
for (const key of Object.keys(d.measures)) {
  const m = d.measures[key];
  out.push(
    `INSERT INTO markets_measures (id, label, short_label, unit, format, agg, numerator, denominator, derived, caption, sort_order) VALUES (` +
    [q(key), q(m.label), q(m.short), q(m.unit), q(m.format), q(m.agg), q(m.numerator), q(m.denominator), bool(m.derived), q(m.caption), mi++].join(', ') +
    `)\nON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, short_label=EXCLUDED.short_label, unit=EXCLUDED.unit, format=EXCLUDED.format, agg=EXCLUDED.agg, numerator=EXCLUDED.numerator, denominator=EXCLUDED.denominator, derived=EXCLUDED.derived, caption=EXCLUDED.caption, sort_order=EXCLUDED.sort_order;`
  );
}
out.push('');

// Sources
out.push('-- ── sources ────────────────────────────────────────────────────────────────');
for (const key of Object.keys(d.sources)) {
  const s = d.sources[key];
  out.push(
    `INSERT INTO markets_sources (id, name, short, url, method, licence, vintage) VALUES (` +
    [q(key), q(s.name), q(s.short), q(s.url), q(s.method), q(s.licence), q(s.vintage)].join(', ') +
    `)\nON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, short=EXCLUDED.short, url=EXCLUDED.url, method=EXCLUDED.method, licence=EXCLUDED.licence, vintage=EXCLUDED.vintage;`
  );
}
out.push('');

// Prices
out.push('-- ── prices ─────────────────────────────────────────────────────────────────');
for (const p of d.prices) {
  out.push(
    `INSERT INTO markets_prices (commodity, series, season, value, unit, source, note) VALUES (` +
    [q(p.commodity), q(p.series), q(p.season), num(p.value), q(p.unit), q(p.source), q(p.note)].join(', ') +
    `)\nON CONFLICT (commodity, series, season) DO UPDATE SET value=EXCLUDED.value, unit=EXCLUDED.unit, source=EXCLUDED.source, note=EXCLUDED.note;`
  );
}
out.push('');

// Observations — clear then insert (verbatim, no natural key)
out.push('-- ── observations (386 rows, replace-all for verbatim idempotency) ──────────');
out.push('DELETE FROM markets_observations;');
for (const o of d.observations) {
  out.push(
    `INSERT INTO markets_observations (geo, commodity, measure, season, value, source, confidence, note) VALUES (` +
    [q(o.geo), q(o.commodity), q(o.measure), q(o.season), num(o.value), q(o.source), q(o.confidence), q(o.note)].join(', ') +
    `);`
  );
}
out.push('');

// FX
out.push('-- ── fx ─────────────────────────────────────────────────────────────────────');
for (const f of d.fx) {
  out.push(
    `INSERT INTO markets_fx (pair, season, rate, source, note) VALUES (` +
    [q(f.pair), q(f.season), num(f.rate), q(f.source), q(f.note)].join(', ') +
    `)\nON CONFLICT (pair, season) DO UPDATE SET rate=EXCLUDED.rate, source=EXCLUDED.source, note=EXCLUDED.note;`
  );
}
out.push('');

// Structure — from each commodity.structure
out.push('-- ── structure (farm classifications + breakdowns + sources per commodity/geo) ─');
for (const key of Object.keys(d.commodities)) {
  const c = d.commodities[key];
  const struct = c.structure || {};
  for (const geo of Object.keys(struct)) {
    const st = struct[geo];
    out.push(
      `INSERT INTO markets_structure (commodity, geo, note, classifications, breakdowns, sources) VALUES (` +
      [q(c.id), q(geo), q(st.note), jb(st.classifications ?? {}), jb(st.breakdowns ?? []), jb(st.sources ?? [])].join(', ') +
      `)\nON CONFLICT (commodity, geo) DO UPDATE SET note=EXCLUDED.note, classifications=EXCLUDED.classifications, breakdowns=EXCLUDED.breakdowns, sources=EXCLUDED.sources;`
    );
  }
}
out.push('');

// Operators — replace-all per commodity (no natural key)
out.push('-- ── operators (15 rows: 12 banana + 3 mango, replace-all) ──────────────────');
out.push('DELETE FROM markets_operators;');
for (const key of Object.keys(d.commodities)) {
  const c = d.commodities[key];
  const ops = c.operators || [];
  let oi = 0;
  for (const op of ops) {
    out.push(
      `INSERT INTO markets_operators (commodity, name, country, region, ownership, role, size, status, source, sort_order) VALUES (` +
      [q(c.id), q(op.name), q(op.country), q(op.region), q(op.ownership), q(op.role), q(op.size), q(op.status), q(op.source), oi++].join(', ') +
      `);`
    );
  }
}
out.push('');

fs.writeFileSync(ROOT + '/supabase/migrations/073_markets_seed.sql', out.join('\n') + '\n');
console.log('Wrote 073_markets_seed.sql with', out.length, 'lines');
// counts
console.log('commodities', Object.keys(d.commodities).length);
console.log('geo', d.geo.length);
console.log('sources', Object.keys(d.sources).length);
console.log('prices', d.prices.length);
console.log('observations', d.observations.length);
console.log('operators total', Object.values(d.commodities).reduce((a,c)=>a+(c.operators?.length||0),0));
console.log('structure rows', Object.values(d.commodities).reduce((a,c)=>a+Object.keys(c.structure||{}).length,0));
