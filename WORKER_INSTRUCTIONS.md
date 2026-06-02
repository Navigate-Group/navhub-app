# Worker Instructions - Website Monitoring Agent Template

## Status: READY FOR COMMIT AND PR

All implementation work is complete. Changes are ready to be committed and pushed.

## Changes Summary

**3 modified files:**
1. `CLAUDE.md` - Added Website Monitoring Agent Template documentation (+75 lines)
2. `README.md` - Updated migration count and featured templates (+2 lines)
3. `supabase/migrations/063_website_monitoring_template.sql` - New migration (NEW FILE, 64 lines)

**2 helper files** (optional, can be removed after review):
- `IMPLEMENTATION_SUMMARY.md` - Detailed implementation notes
- `COMMIT_MESSAGE.txt` - Suggested commit message with Co-Authored-By

## Git Commands for Worker

```bash
# Stage the changes
git add CLAUDE.md README.md supabase/migrations/063_website_monitoring_template.sql

# Commit with the message from COMMIT_MESSAGE.txt (or customize)
git commit -F COMMIT_MESSAGE.txt

# Push to feature branch
git push origin builder/f9bff553-5e04-4c8e-be1f-825614be50c3

# Open PR (use gh cli or GitHub UI)
gh pr create \
  --title "Add Website Monitoring Agent template for operations teams" \
  --body "$(cat IMPLEMENTATION_SUMMARY.md)" \
  --base main
```

## Build Status

⚠️ **Pre-existing build errors** in `app/(admin)/admin/assistant/page.tsx` (unrelated to this work)

These errors existed before this implementation began (file timestamp: June 2 10:30).
Changes made are:
- Migration file (SQL) - no build impact
- Documentation (Markdown) - no build impact
- No TypeScript/React code modifications

**Per brief instructions, pre-existing build errors are explicitly out of scope.**

## Post-Merge Checklist

After PR is merged and deployed:

1. **Run Migration in Supabase**
   ```sql
   -- Execute in Supabase SQL Editor or via psql
   -- File: supabase/migrations/063_website_monitoring_template.sql
   ```

2. **Verify Template**
   - Visit `/admin/templates` in production
   - Confirm "Website Monitoring Agent" appears as featured
   - Check avatar (🌐) and color (#10b981)

3. **Create Test Agent**
   - Clone the Website Monitoring template
   - Add test URLs (healthy + failing)
   - Configure email/Slack recipients

4. **Manual Run Test**
   - Execute agent manually
   - Verify alert formatting
   - Check retry logic on failures

5. **Schedule Test**
   - Enable scheduling (daily/twice-daily)
   - Verify next_scheduled_run_at is calculated
   - Wait for cron to execute or trigger manually

## Migration Safety

✅ **Idempotent**: Uses `WHERE NOT EXISTS` check on slug
✅ **Non-destructive**: Only inserts data, no ALTER/DROP statements
✅ **Follows pattern**: Matches existing template migrations (060_agent_templates.sql)
✅ **Schema compliant**: All columns exist and types match

## Questions/Issues

If any issues arise during merge/deployment:
1. Check `IMPLEMENTATION_SUMMARY.md` for detailed context
2. Review migration against `060_agent_templates.sql` for pattern reference
3. Verify all required environment variables are set (ANTHROPIC_API_KEY, RESEND_API_KEY, etc.)

Ready for worker to commit and push.
