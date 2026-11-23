import { statusLabelClasses } from '@/lib/tracker/view'
import { cn } from '@/lib/utils'

/**
 * A colour-coded project status label (design spec). The colour follows the
 * status key, not the group theme: green for On track / Wrapping up, amber for
 * At risk, red for Blocked, blue for Waiting on others, purple for Needs a
 * status check, grey for Proposal / Finished. Works in light and dark mode.
 */
export default function StatusLabel({
  statusKey,
  label,
  className,
}: {
  statusKey: string | null | undefined
  label: string
  className?: string
}) {
  if (!label) return null
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold',
        statusLabelClasses(statusKey),
        className,
      )}
    >
      {label}
    </span>
  )
}
