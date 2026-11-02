'use client'

import { Info } from 'lucide-react'
import { type AboutFigures } from '@/lib/markets/explorer'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="w-40 shrink-0 font-medium text-foreground">{label}</dt>
      <dd className="text-muted-foreground">{children}</dd>
    </div>
  )
}

export default function AboutFiguresFooter({ about }: { about: AboutFigures }) {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Info className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">About these figures</h2>
      </div>

      {about.intro && <p className="mb-4 text-sm text-muted-foreground">{about.intro}</p>}

      <dl className="space-y-2 text-sm">
        <Row label="Commodity">{about.commodityName}</Row>
        {about.codes.length > 0 && (
          <Row label="Codes">
            {about.codes.map((c, i) => (
              <span key={`${c.scheme}-${c.code}`}>
                {i > 0 && ' · '}
                {c.scheme} {c.code}
              </span>
            ))}
          </Row>
        )}
        <Row label="Season(s)">{about.seasons.join(', ') || '—'}</Row>
        {about.seasonBasis && <Row label="Season basis">{about.seasonBasis}</Row>}
        <Row label="Gap fill">
          {about.gapFill
            ? 'On — missing seasons are forward-filled from the most recent earlier season, and flagged.'
            : 'Off — only directly reported figures are shown.'}
        </Row>
        <Row label="Valuation method">
          {about.valuationLabel}
          {about.valuationDescription && (
            <span className="block text-muted-foreground/90">{about.valuationDescription}</span>
          )}
        </Row>
        {about.priceCaveat && <Row label="Price caveat">{about.priceCaveat}</Row>}
      </dl>

      {about.disclaimer && (
        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          {about.disclaimer}
        </p>
      )}
    </div>
  )
}
