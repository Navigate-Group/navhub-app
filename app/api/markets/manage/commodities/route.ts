import { NextResponse } from 'next/server'
import { requireManager, readJson, str, num } from '../_auth'
import { listCommodities, createCommodity, updateCommodity, setArchived } from '@/lib/markets/manage'

export const runtime = 'nodejs'

/**
 * Markets commodity curation API (MKT-6). Manager+ only.
 *   GET    ?includeArchived=1 → list
 *   POST   { id, name, … } → create
 *   PATCH  { id, …patch } → update, OR { id, archived } to archive/restore
 *
 * Valuation methods embedded in a commodity are curated via the sibling route
 * /api/markets/manage/valuation-methods.
 */
export async function GET(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1'
  return NextResponse.json({ rows: await listCommodities({ includeArchived }) })
}

function parseSeasons(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean)
  return undefined
}

export async function POST(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const body = await readJson(req)
  const id = str(body.id)
  const name = str(body.name)
  if (!id || !name) return NextResponse.json({ error: 'id and name are required' }, { status: 400 })

  try {
    const row = await createCommodity(
      {
        id,
        name,
        scope_note: str(body.scope_note),
        season_basis: str(body.season_basis),
        seasons: parseSeasons(body.seasons) ?? [],
        default_season: str(body.default_season),
        default_country: str(body.default_country),
        sort_order: num(body.sort_order) ?? 0,
      },
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
      await setArchived('markets_commodities', id, body.archived, ctx.userId)
      return NextResponse.json({ ok: true })
    }
    const sortOrder = 'sort_order' in body ? num(body.sort_order) : undefined
    const row = await updateCommodity(
      id,
      {
        name: str(body.name) ?? undefined,
        scope_note: 'scope_note' in body ? str(body.scope_note) : undefined,
        season_basis: 'season_basis' in body ? str(body.season_basis) : undefined,
        seasons: parseSeasons(body.seasons),
        default_season: 'default_season' in body ? str(body.default_season) : undefined,
        default_country: 'default_country' in body ? str(body.default_country) : undefined,
        sort_order: sortOrder === null ? undefined : sortOrder,
      },
      ctx.userId,
    )
    return NextResponse.json({ row })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
