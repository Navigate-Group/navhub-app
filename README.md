# NavHub

Multi-tenant financial dashboard for business groups to monitor performance across companies and divisions.

**Live:** [app.navhub.co](https://app.navhub.co)

## Stack

- **Framework:** Next.js 14.2.35 (App Router, Server Components)
- **Database & Auth:** Supabase (RLS, Row Level Security)
- **Styling:** Tailwind CSS + shadcn/ui
- **Hosting:** Vercel
- **DNS:** Cloudflare

## Features

- **Multi-tenant hierarchy** — Groups > Companies > Divisions with role-based access (super_admin, group_admin, company_viewer, division_viewer)
- **Financial reporting** — P&L, Balance Sheet, Cash Flow views with period navigation and company columns
- **Xero integration** — OAuth connection, automated nightly sync, manual sync per entity
- **Excel uploads** — Drag-and-drop .xlsx import with downloadable templates (P&L, Balance Sheet, Trial Balance)
- **13-week cash flow forecast** — Manual items + Xero AR/AP pull, group summary, snapshots
- **Revenue forecasting** — 7-year projection model with interactive sliders, shareable views
- **AI agents** — Claude/GPT-4o powered agents with streaming execution, tool calling, scheduling, interactive responses; featured templates (Legal, Financial, Report Writing, Website Monitoring)
- **Document management** — Markdown editor with locking, versioning, sharing, export (DOCX/PPTX/PDF), file uploads
- **Report templates** — Slot-based template system with design tokens, scaffold editor, agent-powered generation
- **Marketing intelligence** — 9 platform tracking (GA4, Search Console, Meta, LinkedIn, Google/Meta Ads, Mailchimp, HubSpot, Freshsales) with OAuth sync
- **SharePoint sync** — Microsoft 365 document sync via Graph API
- **NavHub Assistant** — Floating AI chat panel with agent brief generation
- **Admin portal** — Platform dashboard, group/user/agent management, audit log, impersonation
- **Brand theming** — Per-group colour palettes with server-side injection (no flash)

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project
- Environment variables (see `.env.local.example`)

### Setup

```bash
npm install
cp .env.local.example .env.local
# Fill in your Supabase URL, keys, and other required values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Build

```bash
npm run build
```

### Environment Variables

See `.env.local.example` for the full list. Key variables:

| Variable | Required | Purpose |
|----------|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server only) |
| `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` | For Xero | Xero OAuth credentials |
| `ANTHROPIC_API_KEY` | For agents | Claude API key |
| `NAVHUB_ENCRYPTION_KEY` | For agents | 32-byte hex key for credential encryption |
| `RESEND_API_KEY` | For emails | Resend API key |
| `CRON_SECRET` | For cron | Bearer token for Vercel cron jobs |

## Project Structure

```
app/
  (auth)/          Auth pages (login, forgot/reset password, accept invite)
  (dashboard)/     Main app (dashboard, reports, agents, documents, settings, etc.)
  (admin)/         Super-admin portal
  (marketing)/     Public marketing site
  api/             API routes (companies, reports, agents, xero, etc.)

components/        Reusable UI components (shadcn/ui, layout, feature-specific)
lib/               Shared utilities (Supabase clients, Xero, themes, types, encryption)
supabase/          Database migrations (001–029)
```

## Database

63 migrations in `supabase/migrations/`. Key tables: `groups`, `companies`, `divisions`, `financial_snapshots`, `agents`, `agent_runs`, `agent_templates`, `documents`, `report_templates`, `custom_reports`, `cashflow_items`, `marketing_snapshots`.

All tables use Row Level Security. Access is governed by `get_user_group_ids()`, `is_group_admin()`, and `can_access_division()` helper functions.

## Deployment

Deployed on Vercel with two cron jobs:

- `/api/cron/xero-sync` — nightly financial data sync (02:00 AEST)
- `/api/cron/scheduled-agents` — agent scheduling (every minute)
- `/api/cron/sync-marketing` — nightly marketing data sync

## License

Private. All rights reserved.
