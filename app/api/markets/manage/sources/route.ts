import { NextResponse } from 'next/server'
import { requireManager, readJson, str } from '../_auth'
import { listSources, createSource, updateSource, setArchived } from '@/lib/markets/manage'

export const runtime = 'nodejs'

/**
 * Markets sources curation API (MKT-6). Manager+ only.
 *   GET    ?includeArchived=1 → list
 *   POST   { id, name, … }    → create
 *   PATCH  { id, …patch }     → update, OR { id, archived } to archive/restore
 */
export async function GET(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1'
  return NextResponse.json({ rows: await listSources({ includeArchived }) })
}

export async function POST(req: Request) {
  const ctx = await requireManager()
  if (ctx.error) return ctx.error
  const body = await readJson(req)
  const id = str(body.id)
  const name = str(body.name)
  if (!id || !name) return NextResponse.json({ error: 'id and name are required' }, { status: 400 })

  try {
    const row = await createSource(
      {
        id,
        name,
        short: str(body.short),
        url: str(body.url),
        method: str(body.method),
        licence: str(body.licence),
        vintage: str(body.vintage),
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
      await setArchived('markets_sources', id, body.archived, ctx.userId)
      return NextResponse.json({ ok: true })
    }
    const row = await updateSource(
      id,
      {
        name: str(body.name) ?? undefined,
        short: 'short' in body ? str(body.short) : undefined,
        url: 'url' in body ? str(body.url) : undefined,
        method: 'method' in body ? str(body.method) : undefined,
        licence: 'licence' in body ? str(body.licence) : undefined,
        vintage: 'vintage' in body ? str(body.vintage) : undefined,
      },
      ctx.userId,
    )
    return NextResponse.json({ row })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
