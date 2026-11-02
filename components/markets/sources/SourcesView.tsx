'use client'

import { useMemo } from 'react'
import { ExternalLink } from 'lucide-react'
import { buildSourcesView } from '@/lib/markets/views'

function LicenceBadge({ licence }: { licence?: string }) {
  if (!licence) return <span className="text-muted-foreground">—</span>
  const open = /open|public|cc|attribution/i.test(licence)
  return (
    <span
      className={
        open
          ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
          : 'rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-800/60 dark:text-slate-300'
      }
      title={licence}
    >
      {licence}
    </span>
  )
}

export default function SourcesView() {
  const view = useMemo(() => buildSourcesView(), [])

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sources</h1>
        <p className="text-sm text-muted-foreground">
          Every figure in Markets is traceable to a registered source. Price series and FX rates are keyed to their source.
        </p>
      </div>

      {/* Source registry */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Source registry</h2>
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Method</th>
                <th className="px-3 py-2 font-medium">Licence</th>
                <th className="px-3 py-2 font-medium">Vintage</th>
                <th className="px-3 py-2 font-medium text-right">Uses</th>
                <th className="px-3 py-2 font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {view.sources.map(s => (
                <tr key={s.id} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2">
                    <span className="font-medium">{s.name}</span>
                    {s.short && s.short !== s.name && (
                      <span className="ml-1 text-xs text-muted-foreground">({s.short})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{s.method ?? '—'}</td>
                  <td className="px-3 py-2"><LicenceBadge licence={s.licence} /></td>
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{s.vintage ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{s.uses}</td>
                  <td className="px-3 py-2">
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" /> Open
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Price series */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Price series</h2>
        {view.prices.length === 0 ? (
          <p className="text-xs text-muted-foreground">No price series seeded.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Commodity</th>
                  <th className="px-3 py-2 font-medium">Series</th>
                  <th className="px-3 py-2 font-medium">Basis</th>
                  <th className="px-3 py-2 font-medium">Season</th>
                  <th className="px-3 py-2 font-medium text-right">Price</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {view.prices.map((p, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 text-muted-foreground">{p.commodityName}</td>
                    <td className="px-3 py-2 font-medium">{p.seriesLabel}</td>
                    <td className="px-3 py-2 text-muted-foreground">{p.basis ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{p.season}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p.value.toLocaleString()} {p.unit ?? ''}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{p.sourceLabel ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* FX rates */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">FX rates</h2>
        {view.fx.length === 0 ? (
          <p className="text-xs text-muted-foreground">No FX rates seeded.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Pair</th>
                  <th className="px-3 py-2 font-medium">Season</th>
                  <th className="px-3 py-2 font-medium text-right">Rate</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {view.fx.map((f, i) => (
                  <tr key={i} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-medium">{f.pair}</td>
                    <td className="px-3 py-2 tabular-nums">{f.season}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{f.rate}</td>
                    <td className="px-3 py-2 text-muted-foreground">{f.sourceLabel ?? '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{f.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-[11px] text-muted-foreground">{view.disclaimer}</p>
    </div>
  )
}
