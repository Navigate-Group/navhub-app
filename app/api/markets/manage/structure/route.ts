import { NextResponse } from 'next/server'
import { requireManager, readJson, str } from '../_auth'
import { listStructure, createStructure, updateStructure, setArchived } from '@/lib/markets/manage'

export const runtime = 'nodejs'

/**
 * Markets farm-structure curation API (MKT-6). Manager+ only.
 *   GET    ?includeArchived=1&commodity=banana → list
 *   POST   { commodity, geo, note, … } → create
 *   PATCH  { id, …patch } → update, OR { id, archived } to archive/restore
 */
export async function GET(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const sp = new URL(req.url).searchParams
  const rows = await listStructure({
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
  const geo = str(body.geo)
  if (!commodity || !geo) {
    return NextResponse.json({ error: 'commodity and geo are required' }, { status: 400 })
  }
  try {
    const row = await createStructure(
      {
        commodity,
        geo,
        note: str(body.note),
        classifications: isRecord(body.classifications) ? body.classifications : {},
        breakdowns: Array.isArray(body.breakdowns) ? body.breakdowns : [],
        sources: Array.isArray(body.sources) ? body.sources : [],
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
      await setArchived('markets_structure', id, body.archived, ctx.userId)
      return NextResponse.json({ ok: true })
    }
    const row = await updateStructure(
      id,
      {
        commodity: str(body.commodity) ?? undefined,
        geo: str(body.geo) ?? undefined,
        note: 'note' in body ? str(body.note) : undefined,
        classifications: isRecord(body.classifications) ? body.classifications : undefined,
        breakdowns: Array.isArray(body.breakdowns) ? body.breakdowns : undefined,
        sources: Array.isArray(body.sources) ? body.sources : undefined,
      },
      ctx.userId,
    )
    return NextResponse.json({ row })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
