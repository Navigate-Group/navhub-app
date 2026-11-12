import { NextResponse } from 'next/server'
import { requireManager, readJson, str } from '../_auth'
import { listCommodities, setValuationMethods, type ValuationMethodItem } from '@/lib/markets/manage'

export const runtime = 'nodejs'

/**
 * Markets valuation-methods curation API (MKT-6). Manager+ only.
 *
 * Valuation methods live inside markets_commodities.valuation_methods (JSONB).
 * They are curated per-commodity, so this route writes the whole array back:
 *   GET   ?commodity=banana                 → { methods }
 *   PUT   { commodity, methods: [...] }      → replace the array
 *
 * The UI composes add / edit / archive-style removals client-side and PUTs the
 * resulting array; every write is audit-logged in the data layer.
 */
export async function GET(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const commodity = new URL(req.url).searchParams.get('commodity')
  if (!commodity) return NextResponse.json({ error: 'commodity is required' }, { status: 400 })

  const rows = await listCommodities({ includeArchived: true })
  const row = rows.find(c => c.id === commodity)
  if (!row) return NextResponse.json({ error: 'Unknown commodity' }, { status: 404 })
  return NextResponse.json({ methods: row.valuation_methods ?? [] })
}

function parseMethods(v: unknown): ValuationMethodItem[] | null {
  if (!Array.isArray(v)) return null
  const out: ValuationMethodItem[] = []
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) return null
    const m = raw as Record<string, unknown>
    const id = str(m.id)
    const label = str(m.label)
    if (!id || !label) return null
    out.push({
      id,
      label,
      price_series: str(m.price_series) ?? undefined,
      price_measure: str(m.price_measure) ?? undefined,
      description: str(m.description) ?? undefined,
      caveat: str(m.caveat) ?? undefined,
    })
  }
  return out
}

export async function PUT(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const body = await readJson(req)
  const commodity = str(body.commodity)
  if (!commodity) return NextResponse.json({ error: 'commodity is required' }, { status: 400 })

  const methods = parseMethods(body.methods)
  if (methods === null) {
    return NextResponse.json({ error: 'methods must be an array of { id, label, … }' }, { status: 400 })
  }
  try {
    const row = await setValuationMethods(commodity, methods, ctx.userId)
    return NextResponse.json({ methods: row.valuation_methods })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
