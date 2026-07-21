import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright-core'

const REQUIRED_ENV = [
  'QA_BASE_URL',
  'QA_SUPABASE_URL',
  'QA_SUPABASE_PUBLISHABLE_KEY',
  'QA_SUPABASE_SERVICE_ROLE_KEY',
]
const AUTH_STORAGE_KEY = 'missions-nikolay:supabase-auth'
const UI_TIMEOUT_MS = 20_000
const REALTIME_TIMEOUT_MS = 15_000
const BACKEND_TIMEOUT_MS = 20_000
const REQUIRED_TASKS = [
  'Почистить зубы утром',
  'Заправить кровать',
  'Сделать школьную домашнюю работу',
]

function requiredEnvironment() {
  if (process.argv.length > 2) {
    throw new Error(`Аргументы командной строки не поддерживаются; задайте только ${REQUIRED_ENV.join(', ')}`)
  }
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim())
  if (missing.length) throw new Error(`Не заданы обязательные переменные окружения: ${missing.join(', ')}`)
  return Object.fromEntries(REQUIRED_ENV.map((name) => [name, process.env[name].trim()]))
}

function checkedUrl(raw, label, { base = false } = {}) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} должен быть корректным URL`)
  }
  if (url.username || url.password) throw new Error(`${label} не должен содержать учётные данные`)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`${label} должен использовать HTTPS (HTTP разрешён только для localhost)`)
  }
  url.hash = ''
  url.search = ''
  if (base && !url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function browserExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/microsoft-edge',
        ]
  const executable = candidates.filter(Boolean).find((candidate) => existsSync(candidate))
  if (!executable) throw new Error('Не найден установленный Chrome, Edge или Chromium для production QA')
  return executable
}

function route(baseUrl, hash) {
  const url = new URL(baseUrl)
  url.hash = hash
  return url.toString()
}

function redact(value) {
  return String(value)
    .replace(/\b[0-9a-f]{64}\b/giu, '[redacted-token]')
    .replace(/\beyJ[A-Za-z0-9._-]{24,}\b/gu, '[redacted-jwt]')
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/gu, '[redacted-key]')
}

function message(error) {
  if (error instanceof Error) return redact(error.message)
  if (typeof error === 'object' && error !== null) {
    const details = Object.fromEntries(
      ['code', 'message', 'details', 'hint']
        .filter((key) => key in error)
        .map((key) => [key, error[key]]),
    )
    return redact(JSON.stringify(Object.keys(details).length ? details : { error: 'unknown object' }))
  }
  return redact(error)
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(description, operation, predicate, timeoutMs = BACKEND_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await operation()
      if (predicate(value)) return value
    } catch (error) {
      lastError = error
    }
    await sleep(400)
  }
  throw new Error(`${description} не выполнено вовремя${lastError ? `: ${message(lastError)}` : ''}`)
}

async function visible(locator, description, timeout = UI_TIMEOUT_MS) {
  try {
    await locator.waitFor({ state: 'visible', timeout })
  } catch {
    throw new Error(`${description} не появилось в интерфейсе за ${Math.ceil(timeout / 1000)} с`)
  }
  return locator
}

function observePage(page, label, errors, { expected = {}, allowedOrigins = new Set() } = {}) {
  page.on('pageerror', (error) => errors.push(`${label}: необработанная ошибка страницы: ${message(error)}`))
  page.on('console', (entry) => {
    if (entry.type() !== 'error') return
    const source = entry.location().url ?? ''
    const expectedMissingMembership = expected.missingMembership?.()
      && source.includes('/rest/v1/rpc/get_family_snapshot')
      && entry.text().includes('Failed to load resource')
    let externalInjectedResource = false
    if (source && entry.text().includes('Failed to load resource')) {
      try {
        externalInjectedResource = !allowedOrigins.has(new URL(source).origin)
      } catch {
        externalInjectedResource = true
      }
    }
    if (!expectedMissingMembership && !externalInjectedResource) errors.push(`${label}: console.error: ${redact(entry.text())}`)
  })
  page.on('requestfailed', (request) => {
    if (!['document', 'script', 'stylesheet', 'fetch', 'xhr'].includes(request.resourceType())) return
    const failure = request.failure()?.errorText ?? 'network error'
    if (failure.includes('ERR_ABORTED')) return
    let target = 'network resource'
    try {
      const url = new URL(request.url())
      if (!allowedOrigins.has(url.origin)) return
      target = `${url.origin}${url.pathname}`
    } catch {
      // Do not include an unparsed URL because it could contain an invite token.
    }
    errors.push(`${label}: запрос ${target} завершился ошибкой: ${redact(failure)}`)
  })
}

function waitForSnapshotResponse(page, label) {
  return page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && response.url().includes('/rest/v1/rpc/get_family_snapshot')
      && response.ok(),
    { timeout: REALTIME_TIMEOUT_MS },
  ).catch(() => {
    throw new Error(`${label}: realtime-обновление не пришло за ${REALTIME_TIMEOUT_MS / 1000} с`)
  })
}

async function storedSession(page) {
  const stored = await page.evaluate((key) => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
      return null
    }
  }, AUTH_STORAGE_KEY)
  return stored?.currentSession ?? stored?.session ?? stored
}

function taskCard(page, title) {
  return page.locator('article.taskCard').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

function reviewCard(page, title) {
  return page.locator('article.reviewCard').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

async function ensureParentDashboard(page, pin) {
  const dashboard = page.getByRole('heading', { name: 'Родителю', exact: true })
  if (await dashboard.isVisible()) return
  await visible(page.getByRole('heading', { name: 'Родительский режим', exact: true }), 'Экран PIN родителя')
  await page.getByLabel('PIN-код', { exact: true }).fill(pin)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await visible(dashboard, 'Панель родителя')
}

async function submitChildTask(page, title) {
  const card = taskCard(page, title)
  await visible(card, `Карточка миссии «${title}»`)
  await card.getByRole('button', { name: 'Я выполнил', exact: true }).click()
  await visible(card.getByText('Ждёт родителя', { exact: true }), `Статус ожидания миссии «${title}»`)
}

async function approveParentTask(parentPage, childPage, title, pin) {
  await parentPage.bringToFront()
  await ensureParentDashboard(parentPage, pin)
  const card = reviewCard(parentPage, title)
  await visible(card, `Заявка «${title}» в панели родителя`)
  const childRealtime = waitForSnapshotResponse(childPage, 'Детский интерфейс')
  await card.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await childPage.bringToFront()
  await childRealtime
  await visible(taskCard(childPage, title).getByText('Подтверждено', { exact: true }), `Подтверждение миссии «${title}» у ребёнка`)
}

async function checkPublicShell(baseUrl) {
  for (const [label, url] of [
    ['HTML приложения', baseUrl],
    ['PWA manifest', new URL('manifest.webmanifest', baseUrl)],
    ['service worker', new URL('sw.js', baseUrl)],
  ]) {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`${label} недоступен: HTTP ${response.status}`)
    await response.arrayBuffer()
  }
}

async function run() {
  const env = requiredEnvironment()
  const baseUrl = checkedUrl(env.QA_BASE_URL, 'QA_BASE_URL', { base: true })
  const supabaseUrl = checkedUrl(env.QA_SUPABASE_URL, 'QA_SUPABASE_URL')
  assert.notEqual(
    env.QA_SUPABASE_SERVICE_ROLE_KEY,
    env.QA_SUPABASE_PUBLISHABLE_KEY,
    'Service role key не должен совпадать с publishable key',
  )

  const commonAuth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  const admin = createClient(supabaseUrl.toString(), env.QA_SUPABASE_SERVICE_ROLE_KEY, { auth: commonAuth })
  const parentApi = createClient(supabaseUrl.toString(), env.QA_SUPABASE_PUBLISHABLE_KEY, { auth: commonAuth })
  const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`
  const email = `qa-missions-${suffix}@example.com`
  const password = `Qa1!${randomBytes(24).toString('base64url')}`
  const childName = `Николай QA ${suffix.slice(-8)}`
  const pin = String(randomInt(1000, 10_000))
  let parentUserId = null
  let childUserId = null
  let familyId = null
  let familyName = null
  let parentSession = null
  let browser = null
  let parentPage = null
  let childPage = null
  let replayInviteUserId = null
  let expiredInviteUserId = null
  let secondaryParentUserId = null
  let secondaryFamilyId = null
  let secondaryEmail = null
  let primaryError = null
  const browserErrors = []
  const cleanupErrors = []
  const expectedBrowserErrors = { parentMissingMembership: true }
  const allowedOrigins = new Set([baseUrl.origin, supabaseUrl.origin])

  try {
    console.log('1/10 Проверяем опубликованную PWA-оболочку')
    await checkPublicShell(baseUrl)

    console.log('2/10 Создаём временную подтверждённую родительскую сессию')
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { purpose: 'missions-nikolay-production-qa' },
    })
    if (createError || !created.user) throw new Error(`Не удалось создать временного родителя: ${message(createError)}`)
    parentUserId = created.user.id
    const { data: signedIn, error: signInError } = await parentApi.auth.signInWithPassword({ email, password })
    if (signInError || !signedIn.session) throw new Error(`Не удалось открыть родительскую сессию: ${message(signInError)}`)
    parentSession = signedIn.session

    console.log('3/10 Открываем независимые родительский и детский профили браузера')
    browser = await chromium.launch({
      executablePath: browserExecutable(),
      headless: true,
      args: ['--disable-dev-shm-usage'],
    })
    const parentContext = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 900 } })
    const childContext = await browser.newContext({ locale: 'ru-RU', viewport: { width: 430, height: 932 } })
    parentPage = await parentContext.newPage()
    childPage = await childContext.newPage()
    parentPage.setDefaultTimeout(UI_TIMEOUT_MS)
    childPage.setDefaultTimeout(UI_TIMEOUT_MS)
    observePage(parentPage, 'parent', browserErrors, {
      expected: { missingMembership: () => expectedBrowserErrors.parentMissingMembership },
      allowedOrigins,
    })
    observePage(childPage, 'child', browserErrors, { allowedOrigins })
    childPage.on('response', async (response) => {
      try {
        const url = new URL(response.url())
        if (response.request().method() !== 'POST' || !url.pathname.endsWith('/auth/v1/signup') || !response.ok()) return
        const payload = await response.json()
        if (payload?.user?.id) childUserId = payload.user.id
      } catch {
        // Cleanup also has localStorage and membership fallbacks.
      }
    })
    await parentContext.addInitScript(({ key, value }) => {
      try {
        if (location.protocol === 'https:' || location.protocol === 'http:') localStorage.setItem(key, value)
      } catch {
        // Some transient documents do not expose localStorage.
      }
    }, { key: AUTH_STORAGE_KEY, value: JSON.stringify(parentSession) })

    console.log('4/10 Создаём семью и проверяем локальный PIN')
    await parentPage.goto(route(baseUrl, '/parent'), { waitUntil: 'domcontentloaded' })
    await visible(parentPage.getByRole('heading', { name: 'Создать семейное пространство', exact: true }), 'Форма создания семьи')
    expectedBrowserErrors.parentMissingMembership = false
    await parentPage.getByLabel('Имя ребёнка', { exact: true }).fill(childName)
    await parentPage.getByLabel('PIN из 4 цифр', { exact: true }).fill(pin)
    await parentPage.getByLabel('Повторите PIN', { exact: true }).fill(pin)
    await parentPage.getByRole('button', { name: 'Создать пространство', exact: true }).click()
    await ensureParentDashboard(parentPage, pin)
    const browserParentSession = await storedSession(parentPage)
    assert.equal(browserParentSession?.user?.id, parentUserId, 'В браузере открыта неверная родительская сессия')

    const parentSnapshot = await waitFor(
      'Снимок созданной семьи',
      async () => {
        const result = await parentApi.rpc('get_family_snapshot', {})
        if (result.error) throw result.error
        return result.data
      },
      (snapshot) => Boolean(snapshot?.meta?.familyId && snapshot?.meta?.familyName),
    )
    familyId = parentSnapshot.meta.familyId
    familyName = parentSnapshot.meta.familyName

    console.log('5/10 Создаём и принимаем одноразовое приглашение')
    await parentPage.getByRole('button', { name: 'Создать приглашение', exact: true }).click()
    const inviteInput = await visible(parentPage.getByLabel('Ссылка приглашения', { exact: true }), 'Одноразовая ссылка')
    const inviteUrl = await inviteInput.inputValue()
    assert.match(inviteUrl, /#\/join\/[0-9a-f]{64}$/u, 'Одноразовая ссылка имеет неожиданный формат')
    await childPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' })
    await visible(childPage.getByRole('heading', { name: 'Подключить детское устройство', exact: true }), 'Форма подключения ребёнка')
    await childPage.getByLabel('Имя', { exact: true }).fill(childName)
    await childPage.getByRole('button', { name: 'Подключить', exact: true }).click()
    await visible(childPage.getByRole('heading', { name: 'Привет, Николай!', exact: true }), 'Детский интерфейс')
    assert.equal(new URL(childPage.url()).hash, '#/child', 'Invite token не удалён из адресной строки после подключения')
    const childSession = await storedSession(childPage)
    assert.ok(childSession?.access_token && childSession?.refresh_token && childSession?.user?.id, 'Детская сессия не сохранена')
    childUserId = childSession.user.id
    assert.notEqual(childUserId, parentUserId, 'Родитель и ребёнок не должны использовать одну Auth-сессию')
    assert.equal(childSession.user.is_anonymous, true, 'Детская сессия должна быть анонимной')
    const childApi = createClient(supabaseUrl.toString(), env.QA_SUPABASE_PUBLISHABLE_KEY, { auth: commonAuth })
    const { error: setChildSessionError } = await childApi.auth.setSession({
      access_token: childSession.access_token,
      refresh_token: childSession.refresh_token,
    })
    if (setChildSessionError) throw new Error(`Не удалось проверить детскую сессию: ${message(setChildSessionError)}`)
    await childPage.waitForTimeout(1_000)

    console.log('6/10 Проверяем отправку, realtime и запрет родительского RPC ребёнку')
    await parentPage.bringToFront()
    await ensureParentDashboard(parentPage, pin)
    await parentPage.waitForTimeout(500)
    const parentRealtime = waitForSnapshotResponse(parentPage, 'Родительский интерфейс')
    await submitChildTask(childPage, 'Заправить кровать')
    await parentRealtime
    const childSnapshotResult = await childApi.rpc('get_family_snapshot', {})
    if (childSnapshotResult.error) throw new Error(`Детский снимок недоступен: ${message(childSnapshotResult.error)}`)
    const dailyStateId = childSnapshotResult.data?.today?.taskStates?.['make-bed']?.id
    assert.ok(dailyStateId, 'Не найден серверный daily state отправленной миссии')
    const denial = await childApi.rpc('review_task', {
      p_daily_state_id: dailyStateId,
      p_decision: 'approved',
      p_idempotency_key: randomUUID(),
    })
    assert.ok(denial.error, 'Детская сессия неожиданно получила право подтверждать миссии')
    assert.equal(denial.error.code, '42501', `Ожидался RLS/RPC denial 42501, получен ${denial.error.code ?? 'unknown'}`)
    await approveParentTask(parentPage, childPage, 'Заправить кровать', pin)

    console.log('7/10 Подтверждаем обязательный минимум и запускаем таймер')
    for (const title of REQUIRED_TASKS.filter((task) => task !== 'Заправить кровать')) {
      await submitChildTask(childPage, title)
    }
    for (const title of REQUIRED_TASKS.filter((task) => task !== 'Заправить кровать')) {
      await approveParentTask(parentPage, childPage, title, pin)
    }
    const [parentAfterAwards, childAfterAwards] = await Promise.all([
      parentApi.rpc('get_family_snapshot', {}),
      childApi.rpc('get_family_snapshot', {}),
    ])
    if (parentAfterAwards.error) throw new Error(`Родительский снимок наград недоступен: ${message(parentAfterAwards.error)}`)
    if (childAfterAwards.error) throw new Error(`Детский снимок наград недоступен: ${message(childAfterAwards.error)}`)
    assert.deepEqual(childAfterAwards.data.today, parentAfterAwards.data.today, 'Родитель и ребёнок видят разные данные текущего дня')
    assert.deepEqual(childAfterAwards.data.transactions, parentAfterAwards.data.transactions, 'Родитель и ребёнок видят разные начисления')
    const awards = parentAfterAwards.data.transactions.filter((transaction) => transaction.type === 'award')
    assert.equal(awards.length, REQUIRED_TASKS.length, 'Каждая обязательная миссия должна создать ровно одно начисление')
    const totalXp = awards.reduce((sum, award) => sum + award.xpDelta, 0)
    const totalMinutes = awards.reduce((sum, award) => sum + award.minutesDelta, 0)
    const displayedXp = Number(await childPage.locator('.metricRow > div').filter({ hasText: 'XP сегодня' }).locator('strong').innerText())
    const displayedMinutes = Number.parseFloat(await childPage.locator('.metricRow > div').filter({ hasText: 'По XP' }).locator('strong').innerText())
    assert.equal(displayedXp, totalXp, 'XP в детском интерфейсе не совпадают с серверными начислениями')
    assert.equal(displayedMinutes, totalMinutes, 'Минуты в детском интерфейсе не совпадают с серверными начислениями')
    await childPage.getByRole('button', { name: 'Таймер', exact: true }).click()
    await visible(childPage.getByRole('heading', { name: 'Выбери время', exact: true }), 'Доступный таймер')
    await childPage.locator('.timeOptions__all').click()
    await childPage.locator('button.button--start').click()
    await visible(childPage.getByRole('heading', { name: 'Таймер запущен', exact: true }), 'Запущенный таймер')
    await waitFor(
      'Активный таймер в облаке',
      async () => {
        const result = await parentApi.rpc('get_family_snapshot', {})
        if (result.error) throw result.error
        return result.data
      },
      (snapshot) => Boolean(snapshot?.activeTimer?.id),
    )
    await parentPage.bringToFront()
    await ensureParentDashboard(parentPage, pin)
    await visible(parentPage.getByRole('heading', { name: 'Активный таймер', exact: true }), 'Активный таймер в панели родителя')
    await visible(parentPage.getByRole('timer', { name: /У ребёнка осталось/u }), 'Обратный отсчёт в панели родителя')
    await childPage.bringToFront()
    await childPage.waitForTimeout(1_200)
    await childPage.getByRole('button', { name: 'Остановить раньше', exact: true }).click()
    await visible(childPage.getByRole('heading', { name: 'Остановить таймер?', exact: true }), 'Подтверждение остановки таймера')
    await childPage.getByRole('button', { name: 'Остановить', exact: true }).click()
    await childPage.locator('.timerScreen--active').waitFor({ state: 'detached', timeout: UI_TIMEOUT_MS })
    await waitFor(
      'Остановка таймера в облаке',
      async () => {
        const result = await parentApi.rpc('get_family_snapshot', {})
        if (result.error) throw result.error
        return result.data
      },
      (snapshot) => snapshot?.activeTimer === null && snapshot?.today?.usedSeconds >= 1,
    )

    console.log('8/10 Проверяем сохранность после перезагрузки обоих профилей')
    await childPage.reload({ waitUntil: 'domcontentloaded' })
    await visible(taskCard(childPage, 'Заправить кровать').getByText('Подтверждено', { exact: true }), 'Сохранённый детский прогресс')
    assert.equal(new URL(childPage.url()).hash, '#/child', 'Детский маршрут изменился после перезагрузки')
    assert.equal(await childPage.locator('.bottomNav--child button').count(), 3, 'В детской навигации должно быть ровно три раздела')
    assert.equal(await childPage.getByText('Родителю', { exact: true }).count(), 0, 'В детской навигации появился родительский раздел')

    await parentPage.reload({ waitUntil: 'domcontentloaded' })
    await ensureParentDashboard(parentPage, pin)
    await visible(parentPage.getByRole('heading', { name: 'Подтверждено сегодня', exact: true }), 'Сохранённый родительский прогресс')
    for (const title of REQUIRED_TASKS) {
      await visible(parentPage.locator('.approvedList article').filter({ hasText: title }), `Подтверждённая миссия «${title}» после reload`)
    }

    console.log('9/10 Проверяем отсутствие ошибок браузера')
    await parentPage.waitForTimeout(500)
    if (browserErrors.length) throw new Error(`Браузер зафиксировал ошибки:\n${browserErrors.map((item) => `- ${item}`).join('\n')}`)

    console.log('10/10 Проверяем одноразовость, истечение приглашений и межсемейную RLS-изоляцию')
    const usedInviteToken = new URL(inviteUrl).hash.split('/').at(-1)
    assert.match(usedInviteToken, /^[0-9a-f]{64}$/u, 'Не удалось извлечь использованный invite token')
    const replayApi = createClient(supabaseUrl.toString(), env.QA_SUPABASE_PUBLISHABLE_KEY, { auth: commonAuth })
    const replayAuth = await replayApi.auth.signInAnonymously()
    if (replayAuth.error || !replayAuth.data.user) throw new Error(`Не удалось создать сессию проверки повторного invite: ${message(replayAuth.error)}`)
    replayInviteUserId = replayAuth.data.user.id
    const replayClaim = await replayApi.rpc('claim_child_invite', {
      p_token: usedInviteToken,
      p_display_name: 'QA replay device',
      p_idempotency_key: randomUUID(),
    })
    assert.ok(replayClaim.error, 'Использованное приглашение неожиданно принято второй сессией')
    assert.equal(replayClaim.error.code, '22023', `Повторный invite должен отклоняться с 22023, получен ${replayClaim.error.code ?? 'unknown'}`)

    const expiringInvite = await parentApi.rpc('create_child_invite', {
      p_expires_minutes: 5,
      p_idempotency_key: randomUUID(),
    })
    if (expiringInvite.error) throw new Error(`Не удалось создать invite для проверки срока: ${message(expiringInvite.error)}`)
    const expiringToken = expiringInvite.data?.token
    assert.match(expiringToken, /^[0-9a-f]{64}$/u, 'Invite для проверки срока имеет неожиданный формат')
    const expectedDigest = createHash('sha256').update(expiringToken, 'utf8').digest('hex')
    const activeInvite = await admin
      .from('family_invites')
      .select('id, token_digest, created_at')
      .eq('family_id', familyId)
      .is('used_at', null)
      .is('revoked_at', null)
      .single()
    if (activeInvite.error || !activeInvite.data) throw new Error(`Не найден активный invite по digest: ${message(activeInvite.error)}`)
    const storedDigest = String(activeInvite.data.token_digest).replace(/^\\x/iu, '').toLowerCase()
    assert.equal(storedDigest, expectedDigest, 'Digest активного invite не совпадает с выданным одноразовым token')
    const expiredAt = new Date(Date.now() - 60_000).toISOString()
    const expiredCreatedAt = new Date(Date.now() - 120_000).toISOString()
    const expireUpdate = await admin
      .from('family_invites')
      .update({ created_at: expiredCreatedAt, expires_at: expiredAt })
      .eq('id', activeInvite.data.id)
      .is('used_at', null)
      .is('revoked_at', null)
      .select('id')
      .single()
    if (expireUpdate.error || !expireUpdate.data) throw new Error(`Не удалось истечь invite по digest: ${message(expireUpdate.error)}`)

    const expiredApi = createClient(supabaseUrl.toString(), env.QA_SUPABASE_PUBLISHABLE_KEY, { auth: commonAuth })
    const expiredAuth = await expiredApi.auth.signInAnonymously()
    if (expiredAuth.error || !expiredAuth.data.user) throw new Error(`Не удалось создать сессию проверки истёкшего invite: ${message(expiredAuth.error)}`)
    expiredInviteUserId = expiredAuth.data.user.id
    const expiredClaim = await expiredApi.rpc('claim_child_invite', {
      p_token: expiringToken,
      p_display_name: 'QA expired device',
      p_idempotency_key: randomUUID(),
    })
    assert.ok(expiredClaim.error, 'Истёкшее приглашение неожиданно принято')
    assert.equal(expiredClaim.error.code, '22023', `Истёкший invite должен отклоняться с 22023, получен ${expiredClaim.error.code ?? 'unknown'}`)

    secondaryEmail = `qa-missions-isolation-${suffix}@example.com`
    const secondaryPassword = `Qb2!${randomBytes(24).toString('base64url')}`
    const secondaryCreated = await admin.auth.admin.createUser({
      email: secondaryEmail,
      password: secondaryPassword,
      email_confirm: true,
      user_metadata: { purpose: 'missions-nikolay-production-qa-isolation' },
    })
    if (secondaryCreated.error || !secondaryCreated.data.user) throw new Error(`Не удалось создать второго временного родителя: ${message(secondaryCreated.error)}`)
    secondaryParentUserId = secondaryCreated.data.user.id
    const secondaryApi = createClient(supabaseUrl.toString(), env.QA_SUPABASE_PUBLISHABLE_KEY, { auth: commonAuth })
    const secondarySignIn = await secondaryApi.auth.signInWithPassword({ email: secondaryEmail, password: secondaryPassword })
    if (secondarySignIn.error || !secondarySignIn.data.session) throw new Error(`Не удалось открыть вторую родительскую сессию: ${message(secondarySignIn.error)}`)
    const secondarySalt = randomBytes(16).toString('hex')
    const secondaryHash = createHash('sha256').update(`qa-isolation:${secondarySalt}`).digest('hex')
    const secondaryFamily = await secondaryApi.rpc('create_family', {
      p_child_name: `Изоляция QA ${suffix.slice(-8)}`,
      p_pin_hash: secondaryHash,
      p_pin_salt: secondarySalt,
    })
    if (secondaryFamily.error) throw new Error(`Не удалось создать вторую временную семью: ${message(secondaryFamily.error)}`)
    secondaryFamilyId = secondaryFamily.data?.meta?.familyId
    assert.ok(secondaryFamilyId, 'Вторая семья не вернула familyId')
    assert.notEqual(secondaryFamilyId, familyId, 'Два родителя неожиданно получили одну семью')

    const [primarySecuritySnapshot, secondarySecuritySnapshot] = await Promise.all([
      parentApi.rpc('get_family_snapshot', {}),
      secondaryApi.rpc('get_family_snapshot', {}),
    ])
    if (primarySecuritySnapshot.error) throw new Error(`Первый security snapshot недоступен: ${message(primarySecuritySnapshot.error)}`)
    if (secondarySecuritySnapshot.error) throw new Error(`Второй security snapshot недоступен: ${message(secondarySecuritySnapshot.error)}`)
    assert.equal(primarySecuritySnapshot.data?.meta?.familyId, familyId, 'Первый родитель получил snapshot чужой семьи')
    assert.equal(secondarySecuritySnapshot.data?.meta?.familyId, secondaryFamilyId, 'Второй родитель получил snapshot чужой семьи')

    const [primaryOwnFamily, primaryForeignFamily, primaryForeignTasks, secondaryOwnFamily, secondaryOwnTasks, secondaryForeignFamily] = await Promise.all([
      parentApi.from('families').select('id').eq('id', familyId),
      parentApi.from('families').select('id').eq('id', secondaryFamilyId),
      parentApi.from('tasks').select('id').eq('family_id', secondaryFamilyId),
      secondaryApi.from('families').select('id').eq('id', secondaryFamilyId),
      secondaryApi.from('tasks').select('id').eq('family_id', secondaryFamilyId),
      secondaryApi.from('families').select('id').eq('id', familyId),
    ])
    for (const result of [primaryOwnFamily, primaryForeignFamily, primaryForeignTasks, secondaryOwnFamily, secondaryOwnTasks, secondaryForeignFamily]) {
      if (result.error) throw new Error(`Прямой RLS SELECT завершился ошибкой: ${message(result.error)}`)
    }
    assert.deepEqual(primaryOwnFamily.data?.map((row) => row.id), [familyId], 'Первый родитель не видит собственную семью через RLS SELECT')
    assert.equal(primaryForeignFamily.data?.length, 0, 'Первый родитель видит строку второй семьи через RLS SELECT')
    assert.equal(primaryForeignTasks.data?.length, 0, 'Первый родитель видит задачи второй семьи через RLS SELECT')
    assert.deepEqual(secondaryOwnFamily.data?.map((row) => row.id), [secondaryFamilyId], 'Второй родитель не видит собственную семью через RLS SELECT')
    assert.ok(secondaryOwnTasks.data?.length > 0, 'Второй родитель не видит собственные задачи через RLS SELECT')
    assert.equal(secondaryForeignFamily.data?.length, 0, 'Второй родитель видит строку первой семьи через RLS SELECT')
  } catch (error) {
    primaryError = error
  } finally {
    if (!childUserId && childPage) {
      try {
        childUserId = (await storedSession(childPage))?.user?.id ?? null
      } catch {
        // The page may have failed before localStorage became available.
      }
    }

    if (browser) {
      try {
        await browser.close()
      } catch (error) {
        cleanupErrors.push(`закрытие браузера: ${message(error)}`)
      }
    }

    if (!familyId && parentUserId) {
      try {
        const membership = await admin
          .from('family_members')
          .select('family_id')
          .eq('user_id', parentUserId)
          .is('revoked_at', null)
          .maybeSingle()
        if (!membership.error && membership.data?.family_id) familyId = membership.data.family_id
      } catch {
        // No active membership means family creation did not complete.
      }
    }
    if (!secondaryFamilyId && secondaryParentUserId) {
      try {
        const membership = await admin
          .from('family_members')
          .select('family_id')
          .eq('user_id', secondaryParentUserId)
          .is('revoked_at', null)
          .maybeSingle()
        if (!membership.error && membership.data?.family_id) secondaryFamilyId = membership.data.family_id
      } catch {
        // The second family may not have completed creation.
      }
    }
    if (!childUserId && familyId) {
      try {
        const membership = await admin
          .from('family_members')
          .select('user_id')
          .eq('family_id', familyId)
          .eq('role', 'child')
          .is('revoked_at', null)
          .maybeSingle()
        if (!membership.error && membership.data?.user_id) childUserId = membership.data.user_id
      } catch {
        // The child may not have completed invite claim.
      }
    }

    if (familyId) {
      let deleted = false
      if (familyName && parentSession) {
        try {
          const result = await parentApi.rpc('delete_family', { p_confirmation: familyName })
          deleted = !result.error
        } catch {
          // Fall back to a service-role delete below.
        }
      }
      if (!deleted) {
        try {
          const result = await admin.from('families').delete().eq('id', familyId)
          if (result.error) throw result.error
          deleted = true
        } catch (error) {
          cleanupErrors.push(`удаление временной семьи: ${message(error)}`)
        }
      }
    }

    if (secondaryFamilyId) {
      try {
        const result = await admin.from('families').delete().eq('id', secondaryFamilyId)
        if (result.error) throw result.error
      } catch (error) {
        cleanupErrors.push(`удаление второй временной семьи: ${message(error)}`)
      }
    }

    const seenUserIds = new Set()
    for (const [label, userId] of [
      ['ребёнка', childUserId],
      ['проверки повторного invite', replayInviteUserId],
      ['проверки истёкшего invite', expiredInviteUserId],
      ['второго родителя', secondaryParentUserId],
      ['родителя', parentUserId],
    ]) {
      if (!userId) continue
      if (seenUserIds.has(userId)) continue
      seenUserIds.add(userId)
      try {
        const result = await admin.auth.admin.deleteUser(userId)
        if (result.error) throw result.error
      } catch (error) {
        cleanupErrors.push(`удаление Auth-пользователя ${label}: ${message(error)}`)
      }
    }
  }

  if (primaryError || cleanupErrors.length) {
    const parts = []
    if (primaryError) parts.push(message(primaryError))
    if (primaryError && browserErrors.length) parts.push(`Ошибки браузера до остановки:\n${browserErrors.map((item) => `- ${item}`).join('\n')}`)
    if (cleanupErrors.length) parts.push(`Ошибки очистки:\n${cleanupErrors.map((item) => `- ${item}`).join('\n')}`)
    throw new Error(parts.join('\n'))
  }
  console.log('PASS: production cloud E2E и security checks завершены; временные данные удалены')
}

run().catch((error) => {
  console.error(`FAIL: ${message(error)}`)
  process.exitCode = 1
})
