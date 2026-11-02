'use client'

import { type HeadlineCard } from '@/lib/markets/explorer'
import { formatMeasure, formatInt, formatShare } from './format'

export default function HeadlineCards({
  cards,
  scopeLabel,
}: {
  cards: HeadlineCard[]
  scopeLabel: string
}) {
  const isWorld = scopeLabel === 'World'
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map(card => (
        <div key={card.measure} className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {card.label}
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {formatMeasure(card.value, card.format)}
          </p>

          <p className="mt-2 text-xs text-muted-foreground">
            {formatInt(card.counted)} {card.counted === 1 ? 'country' : 'countries'}
            {card.notCounted > 0 && `, ${formatInt(card.notCounted)} not counted`}
            {card.filled > 0 && `, ${formatInt(card.filled)} filled`}
          </p>

          {!isWorld && card.shareOfWorld != null && (
            <p className="mt-1 text-xs text-muted-foreground">
              {formatShare(card.shareOfWorld)} of world
              {card.worldValue != null && (
                <span className="text-muted-foreground/70">
                  {' '}({formatMeasure(card.worldValue, card.format)})
                </span>
              )}
            </p>
          )}
          {isWorld && card.worldValue != null && (
            <p className="mt-1 text-xs text-muted-foreground">
              Across all seeded countries
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
