import { NextResponse }      from 'next/server'
import { createClient }      from '@/lib/supabase/server'
import { cookies }           from 'next/headers'

export const runtime = 'nodejs'

// ─── POST /api/report-templates/analyse ──────────────────────────────────────
// Accepts multipart form data: file + instructions (optional)
// Extracts text from the file, calls Anthropic, returns proposed template JSON
// Does NOT save anything to the database.

export async function POST(request: Request) {
  const supabase      = createClient()
  const cookieStore   = cookies()
  const activeGroupId = cookieStore.get('active_group_id')?.value

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  // Admin check
  const { data: membership } = await supabase
    .from('user_groups')
    .select('role')
    .eq('user_id', session.user.id)
    .eq('group_id', activeGroupId ?? '')
    .single()
  if (!membership || !['super_admin', 'group_owner', 'group_admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  // Parse multipart form data
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file         = formData.get('file') as File | null
  const instructions = formData.get('instructions') as string | null

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large (max 5 MB)' }, { status: 413 })
  }

  // Extract text content
  let content: string
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const mime   = file.type.toLowerCase()

    if (mime === 'application/pdf') {
      // For PDFs, we extract as text — basic extraction of readable text
      content = buffer.toString('utf-8')
        .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
        .replace(/\s{3,}/g, '\n')
        .slice(0, 50000)
    } else {
      // HTML, txt, docx (raw XML), etc. — read as utf-8
      content = buffer.toString('utf-8')
      if (content.length > 50000) content = content.slice(0, 50000) + '\n\n[content truncated]'
    }
  } catch (e) {
    return NextResponse.json({ error: `Error reading file: ${e instanceof Error ? e.message : 'Unknown'}` }, { status: 500 })
  }

  if (!content.trim()) {
    return NextResponse.json({ error: 'File appears to be empty or unreadable' }, { status: 400 })
  }

  // Call Anthropic to extract template
  const systemPrompt = `You are a template extraction specialist. Analyse the provided document and extract a structured report template definition.

Return ONLY a valid JSON object with this exact structure:
{
  "name": "string — short template name",
  "template_type": "financial|matrix|narrative|dashboard|workflow",
  "description": "string — what this template is for",
  "design_tokens": { "css-var-name": "#hexvalue" },
  "slots": [
    {
      "name": "snake_case_name",
      "label": "Human Label",
      "type": "text|html|number|table|list|date|color|object",
      "description": "what goes in this slot",
      "required": true,
      "data_source": "manual|navhub_financial|agent_provided|uploaded_file"
    }
  ],
  "agent_instructions": "string — instructions for agents filling this template",
  "confidence": "high|medium|low",
  "notes": "string — anything the user should know about the extraction"
}

Identify repeating sections or variable content as slots. Identify colours and styling as design_tokens.
Return only the JSON object, no other text.`

  const userMessage = [
    instructions ? `User instructions: ${instructions}\n\n` : '',
    `Document filename: ${file.name}\n\nDocument content:\n\n${content}`,
  ].join('')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-20250514',
      max_tokens: 4096,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
    return NextResponse.json(
      { error: `Anthropic API error: ${err.error?.message ?? res.status}` },
      { status: 502 }
    )
  }

  const json = await res.json() as { content?: Array<{ type: string; text?: string }> }
  const textBlock = json.content?.find(b => b.type === 'text')
  const text = textBlock?.text ?? ''

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return NextResponse.json(
      { error: 'Model did not return valid JSON', raw: text.slice(0, 500) },
      { status: 502 }
    )
  }

  try {
    const proposal = JSON.parse(jsonMatch[0])
    return NextResponse.json({ data: { proposal, filename: file.name } })
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in model response', raw: text.slice(0, 500) },
      { status: 502 }
    )
  }
}
