'use client'

import Link from 'next/link'
import { type RankingList } from '@/lib/markets/explorer'
import { formatMeasure, formatShare } from './format'

function RankingCard({ list }: { list: RankingList }) {
  const isRatio = list.measure === 'export_share'
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Top {list.rows.length || 10} — {list.label}</h3>
        <span className="text-xs text-muted-foreground">by {isRatio ? 'share' : 'value'}</span>
      </div>

      {list.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data for this measure in the current view.</p>
      ) : (
        <ol className="space-y-1.5">
          {list.rows.map(row => (
            <li key={row.iso3} className="flex items-center gap-2 text-sm">
              <span className="w-5 shrink-0 text-right text-xs font-medium text-muted-foreground tabular-nums">
                {row.rank}
              </span>
              <Link
                href={`/markets/country/${row.iso3}`}
                className="w-28 shrink-0 truncate hover:underline"
                title={row.name}
              >
                {row.name}
              </Link>
              <div className="relative h-4 flex-1 overflow-hidden rounded bg-muted/50">
                <div
                  className="absolute inset-y-0 left-0 rounded bg-primary/70"
                  style={{ width: `${Math.max(2, row.share * 100)}%` }}
                />
              </div>
              <span className="w-24 shrink-0 text-right text-xs tabular-nums">
                {formatMeasure(row.value, list.format)}
              </span>
              {!isRatio && (
                <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                  {formatShare(row.share)}
                </span>
              )}
              {row.filled && row.filledFrom && (
                <span
                  className="shrink-0 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                  title={`Forward-filled from ${row.filledFrom}`}
                >
                  {row.filledFrom}
                </span>
              )}
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

export default function RankingLists({ rankings }: { rankings: RankingList[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {rankings.map(list => (
        <RankingCard key={list.measure} list={list} />
      ))}
    </div>
  )
}
