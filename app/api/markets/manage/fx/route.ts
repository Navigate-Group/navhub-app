import { NextResponse } from 'next/server'
import { requireManager, readJson, str, num } from '../_auth'
import { listFx, createFx, updateFx, setArchived } from '@/lib/markets/manage'

export const runtime = 'nodejs'

/**
 * Markets FX-rate curation API (MKT-6). Manager+ only.
 *   GET    ?includeArchived=1 → list
 *   POST   { pair, season, rate, … } → create
 *   PATCH  { id, …patch } → update, OR { id, archived } to archive/restore
 */
export async function GET(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1'
  return NextResponse.json({ rows: await listFx({ includeArchived }) })
}

export async function POST(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const body = await readJson(req)
  const pair = str(body.pair)
  const season = str(body.season)
  const rate = num(body.rate)
  if (!pair || !season || rate === null) {
    return NextResponse.json({ error: 'pair, season and a numeric rate are required' }, { status: 400 })
  }
  try {
    const row = await createFx(
      { pair, season, rate, source: str(body.source), note: str(body.note) },
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
      await setArchived('markets_fx', id, body.archived, ctx.userId)
      return NextResponse.json({ ok: true })
    }
    const rate = 'rate' in body ? num(body.rate) : undefined
    const row = await updateFx(
      id,
      {
        pair: str(body.pair) ?? undefined,
        season: str(body.season) ?? undefined,
        rate: rate === null ? undefined : rate,
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
