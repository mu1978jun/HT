# EternalZero Auto-Renew Bot

Automation toolkit to keep the **Kim's Test Server** instance online on the EternalZero panel. The bot uses [Playwright](https://playwright.dev/) to drive a headless Chromium session that signs in (or injects a saved session), inspects the server dashboard, and clicks **“添加 6 小时”** whenever renewals are available and the cooldown has expired.

## Features

- Supports both cookie-based and credential-based authentication, with automatic fallback between the two.
- Guards against the daily renewal limit (`续订次数上限`) and cooldown timer (`冷却时间`) for safe idempotent runs.
- Detects and validates the target server page, including server name and expiry timestamp.
- Exponential backoff retry (up to two times) if the renewal action does not immediately succeed.
- Optional Telegram notifications on success, cooldown, limit reached, or failure.
- Saves a full-page screenshot under `artifacts/` when a failure occurs (suitable for uploading as a workflow artifact).

## Requirements

- Node.js **18** or newer (Playwright relies on modern Node features).
- Headless Chromium binaries installed via Playwright (`npx playwright install --with-deps`).

## Installation

From the repository root:

```bash
cd tools/eternalzero-auto-renew
npm install
npm run playwright:install
```

> `playwright:install` installs both the Playwright drivers and the necessary Chromium dependencies. Run this command once per machine/CI runner.

## Configuration

| Environment variable | Default | Description |
| -------------------- | ------- | ----------- |
| `E0_BASE_URL` | `https://gpanel.eternalzero.cloud` | EternalZero panel base URL. |
| `E0_SERVER_PATH` | `/server/f081348d` | Path to the target server dashboard. Must begin with `/`. |
| `E0_SERVER_NAME` | `Kim's Test Server` | Used to validate that we are on the correct server page. |
| `E0_LOGIN_EMAIL` | _(none)_ | Panel login email. Required if cookie mode is not configured or fails. |
| `E0_LOGIN_PASSWORD` | _(none)_ | Panel login password. |
| `E0_COOKIE_JSON` | _(none)_ | JSON array of cookies (as exported by the browser). If present, the script injects these cookies before navigation. |
| `E0_MAX_RENEWS_PER_DAY` | `4` | Safety cap matching the panel limit (`续订次数上限`). |
| `E0_COOLDOWN_MINUTES` | `60` | Expected cooldown duration (used for logging/guard rails). |
| `E0_RENEW_THRESHOLD_HOURS` | `3` | Informational threshold; renew is attempted even if expiry is further out, but the value shows up in logs. |
| `E0_HEADLESS` | `true` | Set to `false` to run Chromium with UI (useful for debugging). |
| `TG_BOT_TOKEN` | _(none)_ | Telegram bot token for optional notifications. |
| `TG_CHAT_ID` | _(none)_ | Telegram chat/channel ID that receives notifications. |

### Cookie mode

1. Sign in to the panel manually in a browser.
2. Export relevant session cookies (e.g. via Chrome DevTools → **Application** → **Cookies** → Copy as JSON).
3. Store the cookie array JSON string in the `E0_COOKIE_JSON` secret/variable. The script normalises domains/paths automatically.
4. Optionally provide credentials as fallback; the bot clears cookies and logs in with the credentials if the injected session is invalid.

## Usage

### Local run

```bash
E0_LOGIN_EMAIL="example@example.com" \
E0_LOGIN_PASSWORD="strong-password" \
TG_BOT_TOKEN="123456:ABC" \
TG_CHAT_ID="123456789" \
npm start
```

The script exits with code **0** when:
- Renewal succeeds.
- Renewal is skipped because the daily quota is already reached.
- Renewal is skipped due to cooldown still being active.

An exit code **1** indicates an unrecoverable error.

### GitHub Actions

A ready-to-use workflow is provided at `.github/workflows/eternalzero-auto-renew.yml`. The workflow:
- Runs every 30 minutes on the Asia/Shanghai timetable.
- Installs Node.js 18.x + Playwright browser dependencies.
- Executes the bot (`npm start`).
- Uploads screenshots from `tools/eternalzero-auto-renew/artifacts/` when a failure occurs.

Populate the following repository secrets before enabling the workflow:

- `E0_LOGIN_EMAIL`
- `E0_LOGIN_PASSWORD`
- (Optional) `E0_COOKIE_JSON`
- (Optional) `TG_BOT_TOKEN`
- (Optional) `TG_CHAT_ID`

## Troubleshooting

- **Cloudflare / anti-bot hold**: The script patiently waits through common "Checking your browser" interstitials. If the challenge changes, provide fresh cookies or enable headful mode (`E0_HEADLESS=false`) to inspect manually.
- **Selectors changed**: Update the locators in `renew.mjs` (`clickRenewButton`, `readStatus`) to match the latest UI labels.
- **Missing browsers**: Run `npm run playwright:install` to download Chromium and system dependencies before executing the script.

## Artifacts & Logging

- Failure screenshots land in `tools/eternalzero-auto-renew/artifacts/`. They are ignored by Git and can be uploaded as workflow artifacts.
- Console logs omit sensitive data (emails are partially masked, secrets never echoed). Notifications also avoid exposing credentials.
