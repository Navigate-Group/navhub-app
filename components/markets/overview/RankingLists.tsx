'use client'

import Link from 'next/link'
import { type RankingList } from '@/lib/markets/explorer'
import { formatMeasure, formatShare } from './format'

function RankingCard({ list }: { list: RankingList }) {
  const isRatio = list.measure === 'export_share'
  const topN = list.rows.length || 10
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Top {topN} — {list.label}</h3>
        <span className="text-xs text-muted-foreground">by {isRatio ? 'share' : 'value'}</span>
      </div>
      {/* Unit caption */}
      <p className="mb-3 text-[11px] uppercase tracking-wide text-muted-foreground">
        {isRatio ? 'Share of production exported' : list.unit ? `in ${list.unit}` : ''}
      </p>

      {list.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data for this measure in the current view.</p>
      ) : (
        <ol className="space-y-1.5">
          {list.rows.map(row => (
            <li key={row.iso3} className="flex items-center gap-2 text-sm">
              {/* rank */}
              <span className="w-5 shrink-0 text-right text-xs font-medium text-muted-foreground tabular-nums">
                {row.rank}
              </span>
              {/* country + bar */}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link
                  href={`/markets/country/${row.iso3}`}
                  className="truncate text-xs hover:underline"
                  title={row.name}
                >
                  {row.name}
                </Link>
                <div className="relative h-2 w-full overflow-hidden rounded bg-muted/50">
                  <div
                    className="absolute inset-y-0 left-0 rounded"
                    style={{
                      width: `${Math.max(2, row.share * 100)}%`,
                      backgroundColor: 'hsl(var(--data))',
                    }}
                  />
                </div>
              </div>
              {/* value + share/fill */}
              <div className="flex shrink-0 flex-col items-end">
                <span className="text-xs tabular-nums">
                  {formatMeasure(row.value, list.format)}
                </span>
                {!isRatio && (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {formatShare(row.share)}
                  </span>
                )}
                {row.filled && row.filledFrom && (
                  <span
                    className="mt-0.5 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                    title={`Forward-filled from ${row.filledFrom}`}
                  >
                    {row.filledFrom}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* Notes: missing-season and no-price countries */}
      {(list.missingCount > 0 || list.noPriceCount > 0) && (
        <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
          {list.missingCount > 0 && (
            <>
              {list.missingCount} {list.missingCount === 1 ? 'country' : 'countries'} in scope have no{' '}
              {list.label.toLowerCase()} figure for the selected season
              {list.noPriceCount > 0 && list.measure === 'value'
                ? `, of which ${list.noPriceCount} lack a price`
                : ''}
              .
            </>
          )}
        </p>
      )}
    </div>
  )
}

/**
 * Responsive rankings grid. Full-width (no sidebar). Columns:
 *   • mobile            → 1 column
 *   • ≥1024px (lg)      → 3 columns
 *   • ≥1280px (xl)      → 5 columns (all five rankings in one row)
 */
export default function RankingLists({ rankings }: { rankings: RankingList[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5">
      {rankings.map(list => (
        <RankingCard key={list.measure} list={list} />
      ))}
    </div>
  )
}
