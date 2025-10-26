import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notifyTelegram } from './notifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULTS = {
  baseUrl: 'https://gpanel.eternalzero.cloud',
  serverPath: '/server/f081348d',
  serverName: "Kim's Test Server",
  maxRenewsPerDay: 4,
  cooldownMinutes: 60,
  renewThresholdHours: 3,
};

const EXIT_CODES = {
  OK: 0,
  ERROR: 1,
};

const notifierConfig = {
  token: process.env.TG_BOT_TOKEN,
  chatId: process.env.TG_CHAT_ID,
};

function loadEnv() {
  const rawBase = process.env.E0_BASE_URL?.trim() || DEFAULTS.baseUrl;
  const rawServerPath = process.env.E0_SERVER_PATH?.trim() || DEFAULTS.serverPath;

  return {
    baseUrl: rawBase.replace(/\/$/, ''),
    serverPath: rawServerPath.startsWith('/') ? rawServerPath : `/${rawServerPath}`,
    serverName: process.env.E0_SERVER_NAME?.trim() || DEFAULTS.serverName,
    loginEmail: process.env.E0_LOGIN_EMAIL?.trim(),
    loginPassword: process.env.E0_LOGIN_PASSWORD ?? '',
    cookieJson: process.env.E0_COOKIE_JSON?.trim(),
    maxRenewsPerDay: parseInteger(process.env.E0_MAX_RENEWS_PER_DAY, DEFAULTS.maxRenewsPerDay),
    cooldownMinutes: parseInteger(process.env.E0_COOLDOWN_MINUTES, DEFAULTS.cooldownMinutes),
    renewThresholdHours: parseInteger(process.env.E0_RENEW_THRESHOLD_HOURS, DEFAULTS.renewThresholdHours),
    headless: (process.env.E0_HEADLESS || 'true').toLowerCase() !== 'false',
  };
}

function parseInteger(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function log(level, message, meta) {
  const time = new Date().toISOString();
  const payload = meta ? `${message} ${JSON.stringify(meta)}` : message;
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${time}] [${level.toUpperCase()}] ${payload}`);
}

function mask(value) {
  if (!value) return '';
  const str = String(value);
  if (str.length <= 4) return '*'.repeat(str.length);
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

async function notify(level, message) {
  if (!notifierConfig.token || !notifierConfig.chatId) return;
  try {
    await notifyTelegram({
      token: notifierConfig.token,
      chatId: notifierConfig.chatId,
      message: `[${level.toUpperCase()}] ${message}`,
    });
  } catch (error) {
    log('warn', 'Failed to send Telegram notification', { error: String(error) });
  }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function gentlePause(page, min = 120, max = 260) {
  await page.waitForTimeout(randomBetween(min, max));
}

function parseCookies(raw, baseUrl) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Cookie JSON must be an array');
    const url = new URL(baseUrl);
    return parsed.map((cookie) => {
      const normalised = { ...cookie };
      if (!normalised.domain) normalised.domain = url.hostname;
      if (!normalised.path) normalised.path = '/';
      return normalised;
    });
  } catch (error) {
    throw new Error(`Unable to parse E0_COOKIE_JSON: ${error.message}`);
  }
}

async function waitForAntiBot(page) {
  const challengeTexts = ['Checking your browser', 'Just a moment', '安全检查'];
  try {
    await page.waitForFunction(
      (texts) => {
        const body = document.body?.innerText || '';
        return !texts.some((text) => body.includes(text));
      },
      challengeTexts,
      { timeout: 15000 }
    );
  } catch (error) {
    log('warn', 'Anti-bot wait timed out (continuing)', { error: String(error) });
  }
}

async function goTo(page, url) {
  log('info', 'Navigating', { url });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitForAntiBot(page);
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
}

async function performLogin(page, env) {
  if (!env.loginEmail || !env.loginPassword) {
    throw new Error('Login required but E0_LOGIN_EMAIL or E0_LOGIN_PASSWORD missing');
  }

  await goTo(page, `${env.baseUrl}/auth/login`);
  await gentlePause(page);

  const emailInput = page.locator('input[name="email"], input[type="email"], input[placeholder*="邮箱"], input[placeholder*="Email"]');
  const passwordInput = page.locator('input[name="password"], input[type="password"], input[placeholder*="密码"], input[placeholder*="Password"]');

  await emailInput.first().fill(env.loginEmail, { timeout: 15000 });
  await gentlePause(page, 120, 220);
  await passwordInput.first().fill(env.loginPassword, { timeout: 15000 });

  const loginButton = page.getByRole('button', { name: /登录|Log ?in|Sign ?in/i });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45000 }).catch(() => {}),
    loginButton.first().click({ delay: randomBetween(60, 140) }),
  ]);

  await waitForAntiBot(page);
}

async function assertLoggedIn(page, env) {
  const currentUrl = page.url();
  if (currentUrl.includes('/auth/login')) {
    throw new Error('Login failed – still on login page');
  }

  const text = (await page.locator('body').innerText({ timeout: 15000 })).trim();
  if (text.includes('登录失败') || text.includes('Invalid credentials')) {
    throw new Error('Login failed due to invalid credentials');
  }

  if (!text.includes(env.serverName)) {
    log('warn', 'Server name not yet visible after login, refreshing');
    await page.reload({ waitUntil: 'networkidle' });
  }
}

async function readStatus(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 15000 });
  const compact = bodyText.replace(/\s+/g, ' ');

  const renewMatch = compact.match(/续订[：: ]*([0-9]+)\s*\/\s*([0-9]+)/);
  const cooldownMatch = compact.match(/冷却(?:时间)?[：: ]*([0-9]{1,2})[:：]([0-9]{2})/);
  const expireMatch = compact.match(/过期[：: ]*([0-9]{4}[-/][0-9]{2}[-/][0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})/);

  const renewCount = renewMatch ? Number(renewMatch[1]) : null;
  const renewLimit = renewMatch ? Number(renewMatch[2]) : null;
  const cooldown = cooldownMatch ? `${cooldownMatch[1].padStart(2, '0')}:${cooldownMatch[2]}` : null;
  const cooldownSeconds = cooldownMatch
    ? Number(cooldownMatch[1]) * 60 + Number(cooldownMatch[2])
    : null;
  const expireText = expireMatch ? expireMatch[1] : null;
  const expireAt = expireText ? parseDateTime(expireText) : null;

  return {
    renewCount,
    renewLimit,
    cooldown,
    cooldownSeconds,
    expireText,
    expireAt,
    rawText: compact,
  };
}

function parseDateTime(text) {
  const [datePart, timePart] = text.split(/\s+/);
  if (!datePart || !timePart) return null;
  const [year, month, day] = datePart.split(/[-/]/).map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);
  if ([year, month, day, hour, minute, second].some((v) => Number.isNaN(v))) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

async function waitForExpirationUpdate(page, previousExpireText) {
  if (!previousExpireText) {
    await page.waitForTimeout(2000);
    return;
  }

  await page.waitForFunction(
    (prev) => {
      const body = document.body?.innerText || '';
      return body.includes('过期') && !body.includes(prev);
    },
    previousExpireText,
    { timeout: 15000 }
  ).catch(() => {});
}

async function clickRenewButton(page, status) {
  const button = page.getByRole('button', { name: /添加\s*6\s*小时/ });
  if (!(await button.first().isVisible({ timeout: 5000 }))) {
    throw new Error('Renew button not visible or accessible');
  }

  await gentlePause(page, 160, 320);
  await button.first().hover({ trial: true }).catch(() => {});
  await gentlePause(page, 120, 260);

  const expireBefore = status.expireText;

  await Promise.all([
    waitForExpirationUpdate(page, expireBefore),
    button.first().click({ delay: randomBetween(60, 140) }),
  ]);

  await page.waitForTimeout(randomBetween(1200, 1800));

  const toast = page.locator('text=/成功|Success/i');
  if (await toast.first().isVisible({ timeout: 3000 })) {
    log('info', 'Success toast detected');
  }
}

function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '未知时间';
  return new Date(date.getTime()).toISOString().replace('T', ' ').split('.')[0];
}

async function captureFailureScreenshot(page, label = 'failure') {
  if (!page) return null;
  try {
    const dir = path.join(__dirname, 'artifacts');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    log('info', 'Failure screenshot saved', { filePath });
    return filePath;
  } catch (error) {
    log('warn', 'Unable to capture screenshot', { error: String(error) });
    return null;
  }
}

async function ensureServerPage(page, env) {
  const url = `${env.baseUrl}${env.serverPath}`;
  await goTo(page, url);
  await gentlePause(page);

  const bodyText = await page.locator('body').innerText({ timeout: 15000 });
  if (!bodyText.includes(env.serverName)) {
    throw new Error(`Server page validation failed – could not find server name "${env.serverName}"`);
  }
}

async function openServerPage(page, context, env) {
  try {
    await ensureServerPage(page, env);
  } catch (initialError) {
    log('warn', 'Initial server page load failed', { error: String(initialError) });

    if (!env.loginEmail || !env.loginPassword) {
      throw initialError;
    }

    if (env.cookieJson) {
      await context.clearCookies();
      log('info', 'Cleared context cookies before credential login');
    }

    await performLogin(page, env);
    await ensureServerPage(page, env);
  }
}

async function performRenewFlow(page, previousStatus) {
  await clickRenewButton(page, previousStatus);
  await gentlePause(page, 400, 620);
  return readStatus(page);
}

function evaluateRenewSuccess(previousStatus, updatedStatus) {
  const beforeCount = previousStatus.renewCount;
  const afterCount = updatedStatus.renewCount;
  const countIncreased = Number.isFinite(beforeCount) && Number.isFinite(afterCount) && afterCount > beforeCount;

  const beforeExpire = previousStatus.expireAt?.getTime();
  const afterExpire = updatedStatus.expireAt?.getTime();
  const deltaMs = typeof beforeExpire === 'number' && typeof afterExpire === 'number'
    ? afterExpire - beforeExpire
    : null;
  const expireExtended = typeof deltaMs === 'number' && deltaMs >= 5.5 * 3600 * 1000;

  return {
    success: Boolean(countIncreased || expireExtended),
    details: {
      countIncreased,
      expireExtended,
      deltaHours: typeof deltaMs === 'number' ? Number((deltaMs / 3600000).toFixed(2)) : null,
      beforeCount,
      afterCount,
      beforeExpire: beforeExpire || null,
      afterExpire: afterExpire || null,
    },
  };
}

function summariseStatus(status) {
  if (!status) return {};
  return {
    renewCount: status.renewCount,
    renewLimit: status.renewLimit,
    cooldown: status.cooldown,
    expireAt: status.expireAt ? formatDate(status.expireAt) : null,
  };
}

async function main() {
  const env = loadEnv();
  log('info', 'EternalZero auto-renew starting', {
    baseUrl: env.baseUrl,
    serverPath: env.serverPath,
    serverName: env.serverName,
    loginEmail: env.loginEmail ? mask(env.loginEmail) : undefined,
    cookieMode: Boolean(env.cookieJson),
    headless: env.headless,
  });

  const browser = await chromium.launch({ headless: env.headless });
  const context = await browser.newContext({
    viewport: { width: 1296, height: 864 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  context.setDefaultTimeout(45000);
  context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (env.cookieJson) {
    const cookies = parseCookies(env.cookieJson, env.baseUrl);
    await context.addCookies(cookies);
    log('info', 'Session cookies loaded', { count: cookies.length });
  }

  const page = await context.newPage();
  globalThis.__PLAYWRIGHT_ACTIVE_PAGE = page;

  try {
    await openServerPage(page, context, env);
    await assertLoggedIn(page, env);

    let status = await readStatus(page);
    log('info', 'Current server status', {
      renewCount: status.renewCount,
      renewLimit: status.renewLimit,
      cooldown: status.cooldown,
      expireAt: status.expireAt ? formatDate(status.expireAt) : undefined,
    });

    const maxAllowed = status.renewLimit ? Math.min(status.renewLimit, env.maxRenewsPerDay) : env.maxRenewsPerDay;
    if (status.renewCount !== null && status.renewCount >= maxAllowed) {
      const message = `续订已达上限（${status.renewCount}/${maxAllowed}），无需操作。`;
      log('info', 'Renew limit reached for the day, exiting');
      await notify('info', message);
      return {
        exitCode: EXIT_CODES.OK,
        outcome: 'limit-reached',
        status: summariseStatus(status),
        message,
      };
    }

    if (status.cooldownSeconds !== null && status.cooldownSeconds > 0) {
      const message = `冷却中（剩余 ${status.cooldown}），暂不续订。`;
      log('info', 'Cooldown active, skipping renew', { cooldown: status.cooldown });
      await notify('info', message);
      return {
        exitCode: EXIT_CODES.OK,
        outcome: 'cooldown-active',
        status: summariseStatus(status),
        message,
      };
    }

    const now = Date.now();
    const thresholdMs = env.renewThresholdHours * 3600 * 1000;
    if (status.expireAt && status.expireAt.getTime() - now > thresholdMs) {
      log('info', 'Expiry is beyond threshold, proceeding cautiously', {
        expireAt: formatDate(status.expireAt),
        thresholdHours: env.renewThresholdHours,
      });
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        log('info', 'Attempting renew', { attempt });
        const updatedStatus = await performRenewFlow(page, status);
        const evaluation = evaluateRenewSuccess(status, updatedStatus);
        status = updatedStatus;

        log('info', 'Updated server status', {
          renewCount: updatedStatus.renewCount,
          renewLimit: updatedStatus.renewLimit,
          cooldown: updatedStatus.cooldown,
          expireAt: updatedStatus.expireAt ? formatDate(updatedStatus.expireAt) : undefined,
          evaluation,
        });

        if (evaluation.success) {
          const message = `续订成功：新的过期时间 ${updatedStatus.expireAt ? formatDate(updatedStatus.expireAt) : '未知'}`;
          await notify('success', message);
          return {
            exitCode: EXIT_CODES.OK,
            outcome: 'renewed',
            attempts: attempt,
            status: summariseStatus(updatedStatus),
            evaluation: evaluation.details,
            message,
          };
        }

        if (updatedStatus.renewCount !== null && updatedStatus.renewLimit !== null && updatedStatus.renewCount >= updatedStatus.renewLimit) {
          const message = `续订次数达到 ${updatedStatus.renewCount}/${updatedStatus.renewLimit}，面板可能已限制继续续订。`;
          log('warn', 'Renew limit reached after attempt', { message });
          await notify('info', message);
          return {
            exitCode: EXIT_CODES.OK,
            outcome: 'limit-after-attempt',
            attempts: attempt,
            status: summariseStatus(updatedStatus),
            message,
          };
        }

        if (updatedStatus.cooldownSeconds !== null && updatedStatus.cooldownSeconds > 0) {
          const message = `续订操作触发冷却（剩余 ${updatedStatus.cooldown}），等待下一次任务。`;
          log('info', 'Cooldown detected after attempt', { cooldown: updatedStatus.cooldown });
          await notify('info', message);
          return {
            exitCode: EXIT_CODES.OK,
            outcome: 'cooldown-after-attempt',
            attempts: attempt,
            status: summariseStatus(updatedStatus),
            message,
          };
        }

        log('warn', 'Renew attempt completed but no observable change, will retry if attempts remain', evaluation.details);
        if (attempt === maxAttempts) {
          throw new Error('Renew action completed without observable effect');
        }
      } catch (attemptError) {
        log('warn', 'Renew attempt failed', { attempt, error: String(attemptError) });
        if (attempt === maxAttempts) {
          throw attemptError;
        }
        const backoff = 2 ** attempt * 1000;
        log('info', 'Backing off before retry', { backoff });
        await page.waitForTimeout(backoff);
        await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
        await gentlePause(page, 300, 520);
        status = await readStatus(page);
      }
    }

    throw new Error('Renew attempts exhausted without success');
  } catch (error) {
    await captureFailureScreenshot(page, 'error');
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .then((result) => {
    log('info', 'EternalZero auto-renew completed', result);
    process.exit(result?.exitCode ?? EXIT_CODES.OK);
  })
  .catch(async (error) => {
    log('error', 'EternalZero auto-renew failed', { error: error?.stack || String(error) });
    await notify('error', `续订失败：${error?.message || error}`);
    process.exit(EXIT_CODES.ERROR);
  });
