import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

/**
 * POST /api/dev/seed-markets-review-fixture  (MKT-7b fixture — dev only)
 *
 * Seeds the acceptance fixture for the Review Queue: a 5-row document whose rows
 * are staged as PENDING observations in markets_review_queue, plus ONE existing
 * live markets_observations figure that a later approval will supersede. This
 * lets the full flow be exercised end-to-end:
 *
 *   extract → pending → edit one value → approve all → live observations created,
 *   prior figure marked superseded.
 *
 * Idempotent-ish: each call creates a fresh document + 5 pending rows tagged with
 * the returned document id, so re-running simply adds another fixture batch. The
 * single pre-existing live figure is upserted on its natural key so it is not
 * duplicated.
 *
 * Super-admin only, and returns 404 in production.
 */
export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const admin = createAdminClient()

  const { data: superRows } = await admin
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('role', 'super_admin')
    .limit(1)
  if ((superRows?.length ?? 0) === 0) {
    return NextResponse.json({ error: 'Super admin required' }, { status: 403 })
  }

  const COMMODITY = 'banana'
  const GEO = 'IND'
  const SEASON = '2024'
  const SOURCE = null as string | null
  const FILENAME = 'india_bananas_2024.xlsx'

  // 1. Create the source document row.
  const { data: doc, error: docErr } = await admin
    .from('markets_documents')
    .insert({
      title: FILENAME,
      original_filename: FILENAME,
      storage_path: `fixtures/${Date.now()}_${FILENAME}`,
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size_bytes: 1024,
      commodities: [COMMODITY],
      geographies: [GEO],
      season: SEASON,
      status: 'extracted',
      uploaded_by: session.user.id,
    })
    .select('id')
    .single()
  if (docErr || !doc) {
    return NextResponse.json({ error: docErr?.message ?? 'Failed to create fixture document' }, { status: 500 })
  }
  const documentId = (doc as { id: string }).id

  // 2. Pre-existing live figure for the production key (to be superseded later).
  await admin
    .from('markets_observations')
    .insert({
      geo: GEO, commodity: COMMODITY, measure: 'production', season: SEASON,
      value: 25_000_000, confidence: 'high', note: 'fixture: prior live figure',
    })

  // 3. Five pending observations referencing the document.
  const rows = [
    { measure: 'production',     value: 31_000_000, unit: 't',    confidence: 'medium' },
    { measure: 'area_harvested', value: 880_000,    unit: 'ha',   confidence: 'medium' },
    { measure: 'yield',          value: 35.2,       unit: 't/ha', confidence: 'low'    },
    { measure: 'value',          value: 9_500_000,  unit: 'USD',  confidence: 'low'    },
    { measure: 'exports',        value: 120_000,    unit: 't',    confidence: 'medium' },
  ]

  const queueRows = rows.map(r => ({
    payload: {
      geo: GEO, geo_label: 'India',
      commodity: COMMODITY, commodity_label: 'Banana',
      measure: r.measure, season: SEASON,
      value: r.value, unit: r.unit, source: SOURCE,
      confidence: r.confidence, method: 'spreadsheet_extract',
      note: null, mapping_status: 'matched',
      document_id: documentId, document_name: FILENAME,
    },
    commodity: COMMODITY,
    source: SOURCE,
    status: 'pending',
    submitted_by: session.user.id,
  }))

  const { error: qErr } = await admin.from('markets_review_queue').insert(queueRows)
  if (qErr) {
    return NextResponse.json({ error: qErr.message }, { status: 500 })
  }

  return NextResponse.json({
    data: {
      document_id: documentId,
      filename: FILENAME,
      pending_rows: queueRows.length,
      note: 'Open /markets/manage/review to edit a value and approve all.',
    },
  })
}
