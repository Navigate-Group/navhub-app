'use client'

import { useMemo, useState } from 'react'
import {
  buildExplorerView,
  listCommodityOptions,
  listScopeOptions,
  getCommodityMeta,
  getCommodityValuationMethods,
  getDefaultCommodity,
  RANKING_MEASURES,
  type ExplorerMeasure,
} from '@/lib/markets/explorer'
import ControlRow, { type ControlState } from './ControlRow'
import HeadlineCards from './HeadlineCards'
import ChoroplethMap from './ChoroplethMap'
import RankingLists from './RankingLists'
import AboutFiguresFooter from './AboutFigures'

/**
 * Markets Overview tab (MKT-3). A fully client-driven explorer: every control
 * change recomputes the view from the MKT-2 compute layer in place, so the
 * figures the viewer sees always match the backend functions. Read-only —
 * identical for Viewers and Managers (role gating is enforced upstream in the
 * layout + middleware).
 */
export default function OverviewExplorer() {
  const commodities = useMemo(() => listCommodityOptions(), [])
  const scopes = useMemo(() => listScopeOptions(), [])

  const defaultCommodity = getDefaultCommodity()
  const defaultMeta = getCommodityMeta(defaultCommodity)

  const [state, setState] = useState<ControlState>({
    commodity: defaultCommodity,
    seasons: defaultMeta ? [defaultMeta.defaultSeason] : [],
    annualAverage: false,
    valuationMethod: getCommodityValuationMethods(defaultCommodity)[0]?.id ?? '',
    fillGaps: true,
    scope: 'WORLD',
  })
  const [mapMeasure, setMapMeasure] = useState<ExplorerMeasure>('production')

  // When commodity changes, reset dependent controls to valid defaults.
  const onChange = (next: Partial<ControlState>) => {
    setState(prev => {
      const merged = { ...prev, ...next }
      if (next.commodity && next.commodity !== prev.commodity) {
        const meta = getCommodityMeta(next.commodity)
        const methods = getCommodityValuationMethods(next.commodity)
        merged.seasons = meta ? [meta.defaultSeason] : []
        merged.annualAverage = false
        // Keep the current valuation method if the new commodity offers it,
        // otherwise fall back to its first method.
        merged.valuationMethod = methods.find(m => m.id === prev.valuationMethod)?.id
          ?? methods[0]?.id
          ?? ''
      }
      return merged
    })
  }

  const view = useMemo(
    () =>
      buildExplorerView({
        commodity: state.commodity,
        seasons: state.seasons,
        annualAverage: state.annualAverage,
        valuationMethod: state.valuationMethod,
        fillGaps: state.fillGaps,
        scope: state.scope,
        mapMeasure,
      }),
    [state, mapMeasure],
  )

  const scopeLabel = scopes.find(s => s.id === state.scope)?.label ?? 'World'

  const measureLabelsById = useMemo(() => {
    const out = {} as Record<ExplorerMeasure, string>
    for (const r of view.rankings) out[r.measure] = r.label
    // Ensure every ranking measure has a label even if a list was empty.
    for (const m of RANKING_MEASURES) out[m] = out[m] ?? m
    return out
  }, [view.rankings])

  const mapCard = view.rankings.find(r => r.measure === mapMeasure)

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Production, value, exports and export share by commodity, season and scope.
        </p>
      </div>

      <ControlRow
        commodities={commodities}
        scopes={scopes}
        state={state}
        onChange={onChange}
      />

      <HeadlineCards cards={view.cards} scopeLabel={scopeLabel} />

      <ChoroplethMap
        map={view.map}
        measure={mapMeasure}
        measureLabel={mapCard?.label ?? mapMeasure}
        measureFormat={mapCard?.format ?? 'number'}
        measureLabelsById={measureLabelsById}
        onMeasureChange={setMapMeasure}
      />

      <RankingLists rankings={view.rankings} />

      <AboutFiguresFooter about={view.about} />
    </div>
  )
}
