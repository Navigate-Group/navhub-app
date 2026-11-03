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
import AnalystPanel from '@/components/markets/analyst/AnalystPanel'
import type { ExplorerParams } from '@/lib/markets/explorer'

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

  // Driven by the analyst's change_view tool — applies a commodity / scope /
  // map-measure switch live, re-using the same validation as onChange so the
  // page re-renders with a valid view.
  const onChangeView = (next: Partial<ExplorerParams>) => {
    const scopeIds = new Set(scopes.map(s => s.id))
    const patch: Partial<ControlState> = {}
    if (typeof next.commodity === 'string' && commodities.some(c => c.id === next.commodity)) {
      patch.commodity = next.commodity
    }
    if (typeof next.scope === 'string' && scopeIds.has(next.scope)) {
      patch.scope = next.scope
    }
    if (Object.keys(patch).length) onChange(patch)
    if (typeof next.mapMeasure === 'string' && (RANKING_MEASURES as string[]).includes(next.mapMeasure)) {
      setMapMeasure(next.mapMeasure as ExplorerMeasure)
    }
  }

  const viewParams: ExplorerParams = {
    commodity: state.commodity,
    seasons: state.seasons,
    annualAverage: state.annualAverage,
    valuationMethod: state.valuationMethod,
    fillGaps: state.fillGaps,
    scope: state.scope,
    mapMeasure,
  }

  const view = useMemo(
    () => buildExplorerView(viewParams),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="w-full space-y-4">
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

      {/* Factual explorer (left) with the Agent Analysis panel to its right on
          wide screens; the panel stacks below on narrow screens. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-4">
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

        <AnalystPanel
          view={view}
          viewParams={viewParams}
          scopeLabel={scopeLabel}
          onChangeView={onChangeView}
        />
      </div>
    </div>
  )
}
