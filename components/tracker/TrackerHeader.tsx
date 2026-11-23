import TrackerTabs from '@/components/tracker/TrackerTabs'

/**
 * Shared tracker page header (design spec). The agreed order on every Projects
 * page is:
 *   1. the group's name (small grey text)
 *   2. the page title, with its buttons on the right
 *   3. the section tabs
 * then the page content. This replaces the old order where the tabs sat between
 * the group name and the page title.
 *
 * Server component: it only renders layout. The tabs themselves are a client
 * component (they read the active path).
 */
export default function TrackerHeader({
  groupName,
  title,
  actions,
  showSettings,
  titleId,
}: {
  groupName: string | null
  /** The page title. Pass a string for the common case, or a node for custom markup. */
  title: React.ReactNode
  /** Right-aligned buttons / controls for the title row. */
  actions?: React.ReactNode
  showSettings: boolean
  /** Optional id for the <h1> so a breadcrumb or aria-labelledby can point at it. */
  titleId?: string
}) {
  return (
    <div className="mb-4 space-y-3">
      {groupName && <p className="text-xs text-muted-foreground">{groupName}</p>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        {typeof title === 'string' ? (
          <h1 id={titleId} className="text-2xl font-semibold">{title}</h1>
        ) : (
          title
        )}
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <TrackerTabs showSettings={showSettings} />
    </div>
  )
}
