# External Uptime Monitoring (OBS-12)

External uptime monitoring ensures you are alerted when the entire application or server is down — something Sentry cannot detect since it relies on the app sending events.

## Recommended: UptimeRobot (Free Tier)

### Setup

1. Create a free account at [UptimeRobot](https://uptimerobot.com)
2. Add a new monitor:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** TAC Bookings Health
   - **URL:** `https://yourdomain.co.nz/api/health`
   - **Monitoring Interval:** 60 seconds (free tier minimum)
3. Configure alert contacts:
   - **Email:** admin@tac.org.nz
4. Advanced settings:
   - **Alert when down for:** 2 consecutive checks (2 minutes)
   - **HTTP method:** GET
   - **Expected status codes:** 200 (healthy/degraded both return 200)
   - **Keyword monitoring (optional):** Check for `"status":"healthy"` or `"status":"degraded"` in response body

### What the Health Endpoint Returns

```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "version": "0.1.0",
  "uptime": 86400,
  "checks": {
    "db": { "status": "ok", "latencyMs": 5 },
    "stripe": { "status": "ok", "latencyMs": 1 },
    "xero": { "status": "ok", "latencyMs": 12 },
    "smtp": { "status": "ok", "latencyMs": 0 }
  }
}
```

- **HTTP 200:** `healthy` or `degraded` (app running, some services may be down)
- **HTTP 503:** `unhealthy` (database unreachable — critical failure)

### Alert Behavior

| Scenario | HTTP Status | UptimeRobot Alert? |
|----------|-------------|-------------------|
| All services healthy | 200 | No |
| Xero/SMTP down but DB ok | 200 | No (degraded is still operational) |
| Database unreachable | 503 | Yes |
| Server/container down | Connection error | Yes |
| Caddy/SSL issue | Connection error | Yes |

## Alternative: Sentry Uptime

If your Sentry plan includes Uptime Monitoring:

1. Go to **Sentry > Monitors > Uptime**
2. Add URL: `https://yourdomain.co.nz/api/health`
3. Check interval: 60 seconds
4. Alert on: 2 consecutive failures

## Alternative: AWS Route 53 Health Checks

If you want to stay within the AWS ecosystem:

1. Create a Route 53 health check
2. Endpoint: `https://yourdomain.co.nz/api/health`
3. Request interval: 30 seconds
4. Failure threshold: 2
5. Add a CloudWatch alarm for the health check
6. SNS notification to admin email
