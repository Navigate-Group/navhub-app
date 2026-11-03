/**
 * Markets manage dashboard metadata (MKT-6) — shared by the server page and the
 * client dashboard component.
 *
 * `MANAGE_SECTIONS` drives the quick-access card grid and also provides the
 * human-readable labels for the recent-changes feed, which groups audit rows by
 * their `target_table`. The audit log's `target_table` values are the real
 * markets_* table names (see migration 075); we map each to a friendly label and
 * the (future) CRUD route under /markets/manage. The CRUD pages themselves are
 * delivered by MKT-6c–6e and are intentionally out of scope here.
 */

/** One manageable reference-data section. */
export interface ManageSection {
  /** Stable key used for React keys and lookups. */
  key: string
  /** Human-readable label shown on the card and in the recent-changes feed. */
  label: string
  /** Short description of what the section manages. */
  description: string
  /** Destination CRUD route (delivered by a later brief). */
  href: string
  /** The markets_* table this section manages, matching audit `target_table`. */
  table: string
}

/**
 * The reference-data sections surfaced on /markets/manage, in display order.
 * `table` must match the `target_table` written to markets_audit so the
 * recent-changes feed can resolve a friendly label for each grouped entity.
 */
export const MANAGE_SECTIONS: readonly ManageSection[] = [
  {
    key: 'commodities',
    label: 'Commodities',
    description: 'Commodity definitions, units and valuation methods.',
    href: '/markets/manage/commodities',
    table: 'markets_commodities',
  },
  {
    key: 'locations',
    label: 'Locations',
    description: 'Countries, regions and other geographic units.',
    href: '/markets/manage/locations',
    table: 'markets_geo_units',
  },
  {
    key: 'seasons',
    label: 'Seasons',
    description: 'Seasons and reporting periods for observations.',
    href: '/markets/manage/seasons',
    table: 'markets_seasons',
  },
  {
    key: 'prices',
    label: 'Prices',
    description: 'Price series, bases and the values behind them.',
    href: '/markets/manage/prices',
    table: 'markets_prices',
  },
  {
    key: 'sources',
    label: 'Sources',
    description: 'The source registry: method, licence and vintage.',
    href: '/markets/manage/sources',
    table: 'markets_sources',
  },
  {
    key: 'structure',
    label: 'Structure notes',
    description: 'Farm-structure notes: area, ownership and turnover.',
    href: '/markets/manage/structure',
    table: 'markets_structure',
  },
] as const

/** Resolve a friendly label for an audit `target_table`, falling back to the raw name. */
export function labelForTable(table: string): string {
  return MANAGE_SECTIONS.find(s => s.table === table)?.label ?? table
}
