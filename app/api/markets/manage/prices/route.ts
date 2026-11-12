import { NextResponse } from 'next/server'
import { requireManager, readJson, str, num } from '../_auth'
import { listPrices, createPrice, updatePrice, setArchived } from '@/lib/markets/manage'

export const runtime = 'nodejs'

/**
 * Markets price-series curation API (MKT-6). Manager+ only.
 *   GET    ?includeArchived=1&commodity=banana → list
 *   POST   { commodity, series, season, value, … } → create
 *   PATCH  { id, …patch } → update, OR { id, archived } to archive/restore
 */
export async function GET(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const sp = new URL(req.url).searchParams
  const rows = await listPrices({
    includeArchived: sp.get('includeArchived') === '1',
    commodity: sp.get('commodity') ?? undefined,
  })
  return NextResponse.json({ rows })
}

export async function POST(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const body = await readJson(req)
  const commodity = str(body.commodity)
  const series = str(body.series)
  const season = str(body.season)
  const value = num(body.value)
  if (!commodity || !series || !season || value === null) {
    return NextResponse.json({ error: 'commodity, series, season and a numeric value are required' }, { status: 400 })
  }
  try {
    const row = await createPrice(
      { commodity, series, season, value, unit: str(body.unit), source: str(body.source), note: str(body.note) },
      ctx.userId,
    )
    return NextResponse.json({ row }, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

export async function PATCH(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const body = await readJson(req)
  const id = str(body.id)
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  try {
    if (typeof body.archived === 'boolean') {
      await setArchived('markets_prices', id, body.archived, ctx.userId)
      return NextResponse.json({ ok: true })
    }
    const value = 'value' in body ? num(body.value) : undefined
    const row = await updatePrice(
      id,
      {
        commodity: str(body.commodity) ?? undefined,
        series: str(body.series) ?? undefined,
        season: str(body.season) ?? undefined,
        value: value === null ? undefined : value,
        unit: 'unit' in body ? str(body.unit) : undefined,
        source: 'source' in body ? str(body.source) : undefined,
        note: 'note' in body ? str(body.note) : undefined,
      },
      ctx.userId,
    )
    return NextResponse.json({ row })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
