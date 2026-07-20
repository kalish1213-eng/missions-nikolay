import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.idea',
  '.vscode',
  'coverage',
  'dist',
  'node_modules',
])

const BINARY_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.webp',
  '.woff',
  '.woff2',
])

const SECRET_PATTERNS = [
  {
    label: 'private key',
    pattern: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/g,
  },
  {
    label: 'GitHub token',
    pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{36,})\b/g,
  },
  {
    label: 'Supabase server secret',
    pattern: /\b(?:sb_secret_[A-Za-z0-9_-]{20,}|sbp_[A-Za-z0-9]{30,})\b/g,
  },
  {
    label: 'browser-exposed server secret variable',
    pattern: /\bVITE_[A-Z0-9_]*(?:SERVICE_ROLE|SECRET_KEY)[A-Z0-9_]*\b/g,
  },
  {
    label: 'cloud access key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    label: 'credential-bearing database URL',
    pattern: /\b(?:postgres|postgresql):\/\/[^\s/:]+:[^\s/@]+@[^\s]+/gi,
  },
  {
    label: 'server credential assignment',
    pattern: /\b(?:SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD|SERVICE_ROLE_KEY)|DATABASE_URL|POSTGRES_PASSWORD)\s*[:=]\s*["']?[^\s"'#]{8,}/g,
  },
]

const RELEASE_ONLY_PATTERNS = [
  {
    label: 'localhost URL',
    pattern: /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?\b/gi,
  },
]

function parseArguments(argv) {
  let mode = 'source'
  const roots = []

  for (const argument of argv) {
    if (argument === '--release') {
      mode = 'release'
    } else if (argument === '--source') {
      mode = 'source'
    } else {
      roots.push(argument)
    }
  }

  if (roots.length === 0) {
    roots.push(mode === 'release' ? 'dist' : '.')
  }

  return { mode, roots }
}

async function collectFiles(root) {
  const absoluteRoot = resolve(root)
  const info = await stat(absoluteRoot)

  if (info.isFile()) {
    return [absoluteRoot]
  }

  const files = []
  const entries = await readdir(absoluteRoot, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue
    }

    const entryPath = resolve(absoluteRoot, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)))
    } else if (entry.isFile() && !BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(entryPath)
    }
  }

  return files
}

function decodeBase64Url(value) {
  try {
    return Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

function containsServiceRoleJwt(content) {
  const candidates = content.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g) ?? []

  return candidates.some((candidate) => {
    const payload = decodeBase64Url(candidate.split('.')[1])
    return /"role"\s*:\s*"service_role"/.test(payload)
  })
}

function lineNumberAt(content, offset) {
  return content.slice(0, offset).split('\n').length
}

function scanContent(content, file, patterns) {
  const findings = []

  if (containsServiceRoleJwt(content)) {
    findings.push({ file, label: 'Supabase service-role JWT', line: 1 })
  }

  for (const { label, pattern } of patterns) {
    pattern.lastIndex = 0
    for (const match of content.matchAll(pattern)) {
      findings.push({ file, label, line: lineNumberAt(content, match.index ?? 0) })
    }
  }

  return findings
}

const { mode, roots } = parseArguments(process.argv.slice(2))
const patterns = mode === 'release' ? [...SECRET_PATTERNS, ...RELEASE_ONLY_PATTERNS] : SECRET_PATTERNS
const findings = []

for (const root of roots) {
  for (const file of await collectFiles(root)) {
    const content = await readFile(file, 'utf8')
    if (content.includes('\0')) {
      continue
    }

    findings.push(...scanContent(content, relative(process.cwd(), file), patterns))
  }
}

if (findings.length > 0) {
  console.error(`Release scan failed with ${findings.length} finding(s):`)
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line}: ${finding.label}`)
  }
  process.exitCode = 1
} else {
  console.log(`Release scan passed (${mode} mode).`)
}
