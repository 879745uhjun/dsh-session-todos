#!/usr/bin/env node
/**
 * Publish one plugin directory to a GitHub repository through the REST API.
 *
 * git over HTTPS cannot negotiate TLS in this environment (schannel:
 * SEC_E_NO_CREDENTIALS), so this script uses the same REST API the web UI
 * uses. A brand new repository has no git database yet, so the first file is
 * committed through the Contents API; every other file then lands in a second
 * commit through the Git Data API. Running it again appends a commit.
 *
 * Environment:
 *   GITHUB_TOKEN     token with repo scope (gh auth token)
 *   REPO             owner/name
 *   DIR              local directory to publish
 *   COMMIT_MESSAGE   commit subject and body (newline separated)
 *   DESCRIPTION      repository description for a newly created repo
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const token = process.env.GITHUB_TOKEN
const [owner, repo] = String(process.env.REPO ?? '').split('/')
const dir = String(process.env.DIR ?? '')
const message = String(process.env.COMMIT_MESSAGE ?? 'chore: publish')
const description = String(process.env.DESCRIPTION ?? '')

if (!token || !owner || !repo || !dir) {
  console.error('GITHUB_TOKEN, REPO, and DIR are required')
  process.exit(2)
}

const API = 'https://api.github.com'

async function api(method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-plugin-publisher',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  if (text !== '') {
    try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
  }
  if (!response.ok) {
    const error = new Error(method + ' ' + path + ' -> ' + response.status + ' ' + (json?.message ?? ''))
    error.status = response.status
    error.json = json
    throw error
  }
  return json
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh', 'coverage'])
const SKIP_FILE = /(^|\/)(\.DS_Store|Thumbs\.db)$|\.log$|\.tmp$/

async function walk(root) {
  const out = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await visit(full)
      } else if (entry.isFile()) {
        if (SKIP_FILE.test(entry.name) || entry.name.startsWith('._')) continue
        out.push({ full, rel: relative(root, full).split('\\').join('/') })
      }
    }
  }
  await visit(root)
  return out.sort((left, right) => left.rel.localeCompare(right.rel))
}

async function createBlobs(repoPath, files) {
  const tree = []
  for (const file of files) {
    const buffer = await readFile(file.full)
    const blob = await api('POST', repoPath + '/git/blobs', {
      content: buffer.toString('base64'),
      encoding: 'base64',
    })
    tree.push({ path: file.rel, mode: '100644', type: 'blob', sha: blob.sha })
  }
  return tree
}

const repoPath = '/repos/' + owner + '/' + repo
const summary = { repo: owner + '/' + repo, created: false, seeded: null, files: 0, commits: [], branch: 'main' }

let repository = null
try {
  repository = await api('GET', repoPath)
} catch (error) {
  if (error.status !== 404) throw error
}
if (repository === null) {
  repository = await api('POST', '/user/repos', { name: repo, description, private: false, auto_init: false })
  summary.created = true
} else if (description !== '' && repository.description !== description) {
  await api('PATCH', repoPath, { description })
}

const files = await walk(dir)
if (files.length === 0) {
  console.error('no files to publish in ' + dir)
  process.exit(3)
}

let parent = null
try {
  const ref = await api('GET', repoPath + '/git/ref/heads/main')
  parent = ref.object.sha
} catch (error) {
  if (error.status !== 404 && error.status !== 409) throw error
}

const hadParent = parent !== null
let baseTree = null
let remaining = files
if (parent === null) {
  // An empty repository has no git database, so the Git Data API answers 409.
  // Seed it with one real file through the Contents API and build on that.
  const seed = files.find((file) => file.rel === 'README.md') ?? files[0]
  const buffer = await readFile(seed.full)
  const seeded = await api('PUT', repoPath + '/contents/' + encodeURI(seed.rel), {
    message: 'docs: add ' + seed.rel,
    content: buffer.toString('base64'),
    branch: 'main',
  })
  parent = seeded.commit.sha
  baseTree = (await api('GET', repoPath + '/git/commits/' + parent)).tree.sha
  remaining = files.filter((file) => file.rel !== seed.rel)
  summary.seeded = seed.rel
  summary.commits.push({ sha: parent, message: 'docs: add ' + seed.rel })
}

const tree = await createBlobs(repoPath, remaining)
const created = await api('POST', repoPath + '/git/trees', baseTree === null ? { tree } : { base_tree: baseTree, tree })
const commit = await api('POST', repoPath + '/git/commits', { message, tree: created.sha, parents: [parent] })

if (hadParent) {
  await api('PATCH', repoPath + '/git/refs/heads/main', { sha: commit.sha, force: false })
} else {
  await api('POST', repoPath + '/git/refs', { ref: 'refs/heads/main', sha: commit.sha })
  try { await api('PATCH', repoPath, { default_branch: 'main' }) } catch { /* already main */ }
}

summary.files = files.length
summary.commits.push({ sha: commit.sha, message })
console.log(JSON.stringify(summary))
