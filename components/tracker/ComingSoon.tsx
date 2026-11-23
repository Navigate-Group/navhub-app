import Link from 'next/link'
import { Sparkles } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

/**
 * Friendly placeholder for tracker tabs built in a later release (design spec).
 * Shows an icon, "{title} is coming soon", one sentence about what it will do,
 * and a "Go to Projects" link. Centred in the page; theme-aware.
 */
export default function ComingSoon({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="flex justify-center py-10">
      <Card className="max-w-md text-center">
        <CardContent className="flex flex-col items-center gap-3 p-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="h-6 w-6" aria-hidden />
          </div>
          <h1 className="text-lg font-semibold">{title} is coming soon</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
          <Button asChild variant="outline" size="sm">
            <Link href="/tracker/plans">Go to Projects</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
