import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/** Placeholder for tracker tabs built in later phases (P8). */
export default function ComingSoon({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Coming soon.</p>
      </CardContent>
    </Card>
  )
}
