import { NextResponse } from 'next/server'
import { requireManager, readJson, str } from '../_auth'
import { listGeoUnits, createGeoUnit, updateGeoUnit, setArchived } from '@/lib/markets/manage'

export const runtime = 'nodejs'

/**
 * Markets geo-units curation API (MKT-6). Manager+ only (middleware + handler).
 *   GET    ?includeArchived=1   → list
 *   POST   { id, name, level, … } → create
 *   PATCH  { id, …patch }        → update, OR { id, archived } to archive/restore
 */
export async function GET(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1'
  const rows = await listGeoUnits({ includeArchived })
  return NextResponse.json({ rows })
}

export async function POST(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const body = await readJson(req)

  const id = str(body.id)
  const name = str(body.name)
  const level = str(body.level)
  if (!id || !name || (level !== 'country' && level !== 'region')) {
    return NextResponse.json({ error: 'id, name and a valid level (country|region) are required' }, { status: 400 })
  }
  try {
    const row = await createGeoUnit(
      {
        id,
        name,
        level,
        m49: str(body.m49),
        continent: str(body.continent),
        zones: Array.isArray(body.zones) ? (body.zones as unknown[]).map(String) : [],
        parent: str(body.parent),
        region_type: str(body.region_type),
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
      await setArchived('markets_geo_units', id, body.archived, ctx.userId)
      return NextResponse.json({ ok: true })
    }
    const level = str(body.level)
    const row = await updateGeoUnit(
      id,
      {
        name: str(body.name) ?? undefined,
        level: level === 'country' || level === 'region' ? level : undefined,
        m49: 'm49' in body ? str(body.m49) : undefined,
        continent: 'continent' in body ? str(body.continent) : undefined,
        zones: Array.isArray(body.zones) ? (body.zones as unknown[]).map(String) : undefined,
        parent: 'parent' in body ? str(body.parent) : undefined,
        region_type: 'region_type' in body ? str(body.region_type) : undefined,
      },
      ctx.userId,
    )
    return NextResponse.json({ row })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
