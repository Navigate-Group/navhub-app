/**
 * Sage health ping cron (hourly)
 *
 * POSTs health status to Builder's Kaizen to confirm Sage is alive.
 * Implements contract lane 3 (outbound health ping).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getContractConfig, postHealthPing } from '@/lib/sage-contract'

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const config = await getContractConfig()
    await postHealthPing(config)

    return NextResponse.json({
      status: 'ok',
      message: 'Health ping sent to Builder',
      ts: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[sage-health] Health ping failed:', err)
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Health ping failed',
        ts: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
