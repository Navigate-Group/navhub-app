/**
 * Error capture instrumentation for Sage Phase 1.
 *
 * Lightweight helper to log errors into error_logs table. Called from API
 * routes on unhandled exceptions, 4xx/5xx responses, DB write failures, auth
 * failures. Service-role only writes; super_admin read access for Sage.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export interface ErrorContext {
  route:      string
  action?:    string
  errorType:  'unhandled_exception' | 'http_4xx' | 'http_5xx' | 'db_write_failure' | 'auth_failure' | 'validation_error' | 'timeout'
  message:    string
  stack?:     string
  context?:   Record<string, unknown>
  userId?:    string
  groupId?:   string
}

/**
 * Log an error to the error_logs table (best-effort, never throws).
 */
export async function captureError(ctx: ErrorContext): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin.from('error_logs').insert({
      route:      ctx.route,
      action:     ctx.action ?? null,
      error_type: ctx.errorType,
      message:    ctx.message.slice(0, 1000),
      stack:      ctx.stack?.slice(0, 5000) ?? null,
      context:    ctx.context ?? null,
      user_id:    ctx.userId ?? null,
      group_id:   ctx.groupId ?? null,
    })
  } catch (err) {
    // Silent failure — error capture must not throw or we cascade errors
    console.error('[error-capture] Failed to log error:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Wrap an API route handler to capture unhandled exceptions.
 * Usage:
 *   export const POST = withErrorCapture('/api/foo', async (req) => { ... })
 */
export function withErrorCapture<T extends (...args: unknown[]) => Promise<Response>>(
  route:   string,
  handler: T,
): T {
  return (async (...args: Parameters<T>): Promise<Response> => {
    try {
      const res = await handler(...args)
      // Capture 4xx/5xx responses
      if (res.status >= 400) {
        const errorType = res.status >= 500 ? 'http_5xx' : 'http_4xx'
        const body = await res.clone().text().catch(() => '')
        void captureError({
          route,
          errorType,
          message: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        })
      }
      return res
    } catch (err) {
      // Capture unhandled exception
      const message = err instanceof Error ? err.message : String(err)
      const stack   = err instanceof Error ? err.stack : undefined
      void captureError({
        route,
        errorType: 'unhandled_exception',
        message,
        stack,
      })
      // Re-throw so the caller still sees the error
      throw err
    }
  }) as T
}
