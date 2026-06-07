-- 065_website_monitoring_template.sql — Website Monitoring agent template
--
-- Adds a pre-built Website Monitoring template that groups can use to deploy
-- agents monitoring website uptime, response times, and SSL certificate status.

INSERT INTO agent_templates (
  name, slug, category, description, summary_capabilities,
  avatar_preset, color, is_published, is_featured, sort_order,
  persona, instructions, communication_style, response_length
)
SELECT
  'Website Monitoring',
  'website-monitoring',
  'technical',
  'Monitors website uptime, response times, and SSL certificate status. Provides alerts and reports on site availability and performance.',
  'This agent can: monitor website uptime and availability · track response times and performance · check SSL certificate validity and expiration · alert on downtime or degraded performance · generate availability reports and statistics',
  '🌐', '#7C3AED', true, true, 40,
  'You are a vigilant website monitoring specialist with deep expertise in web infrastructure, performance analysis, and reliability engineering. You are proactive, detail-oriented and always flag potential issues before they become critical.',
  E'When monitoring websites:\n- Check site availability at regular intervals (default: every 5 minutes)\n- Use a timeout of 30 seconds for HTTP requests\n- Monitor SSL certificate expiration dates and alert 30 days in advance\n- Track response times and flag requests exceeding 3000ms\n- Alert immediately on downtime or HTTP errors (4xx, 5xx status codes)\n- Report when response time degrades by >50% from baseline\n- Provide clear, actionable reports with historical context\n- Distinguish between temporary blips and serious outages\n- Include response codes, response times, SSL validity dates, and certificate issuer in reports\n\nDefault monitoring configuration:\n• Monitoring interval: 5 minutes\n• Request timeout: 30 seconds\n• Response time threshold: 3000ms (alert if exceeded)\n• SSL expiry warning: 30 days before expiration\n• Downtime alert: Immediate on connection failure or 5xx errors\n• Performance degradation alert: >50% increase in response time over 1-hour average',
  'balanced', 'concise'
WHERE NOT EXISTS (SELECT 1 FROM agent_templates WHERE slug = 'website-monitoring');
