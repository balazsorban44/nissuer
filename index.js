// @ts-check

import { info, debug, getInput, setFailed } from "@actions/core"
import { context, getOctokit } from "@actions/github"
import { readFile, access } from "node:fs/promises"
import { join } from "node:path"

if (!process.env.GITHUB_TOKEN) throw new TypeError("No GITHUB_TOKEN provided")
if (!process.env.GITHUB_WORKSPACE) throw new TypeError("Not a GitHub workspace")

function tryParse(json) {
  try {
    return JSON.parse(json)
  } catch (e) {
    setFailed(`Could not parse JSON: ${e.message}`)
  }
}

const config = {
  invalidLink: {
    comment:
      getInput("reproduction-comment") || ".github/invalid-reproduction.md",
    hosts: (getInput("reproduction-hosts") || "github.com")
      .split(",")
      .map((h) => h.trim()),
    label: getInput("reproduction-invalid-label") || "invalid-reproduction",
    linkSection:
      getInput("reproduction-link-section") ||
      "### Link to reproduction(.*)### To reproduce",
  },
  labelComments: tryParse(getInput("label-comments") || "{}"),
  token: process.env.GITHUB_TOKEN,
  workspace: process.env.GITHUB_WORKSPACE,
}

debug(`Config: ${JSON.stringify(config, null, 2)}`)

run().catch(setFailed)

async function checkValidReproduction() {
  const { issue, action } = context.payload

  if (action !== "opened") return

  if (!issue?.body) return info("Could not get issue body, exiting")

  if (await isValidReproduction(issue.body))
    return info(`Issue #${issue.number} contains a valid reproduction 💚`)

  info(`Invalid reproduction, issue will be closed/labeled/commented/locked...`)

  const { rest: client } = getOctokit(config.token)
  const common = { ...context.repo, issue_number: issue.number }

  // Close
  await client.issues.update({ ...common, state: "closed" })
  debug(`Issue #${issue.number} closed`)

  // Label to categorize
  await client.issues.addLabels({
    ...common,
    labels: [config.invalidLink.label],
  })
  debug(`Issue #${issue.number} labeled`)

  // Comment with an explanation
  const comment = join(config.workspace, config.invalidLink.comment)
  await client.issues.createComment({
    ...common,
    body: await getCommentBody(comment),
  })
  debug(`Issue #${issue.number} commented`)

  // Lock to avoid piling up comments/reactions
  await client.issues.lock(common)
  debug(`Issue #${issue.number} locked`)

  info(
    `Issue #${issue.number} closed/labaled/commented/locked. It does not contain a valid reproduction 😢`
  )
}

/**
 * Determine if an issue contains a valid/accessible link to a reproduction
 * @param {string} body
 */
async function isValidReproduction(body) {
  const linkSectionRe = new RegExp(config.invalidLink.linkSection, "is")
  const link = body.match(linkSectionRe)?.[1]?.trim()
  if (!link) {
    info("Missing link")
    debug(`Link section regex: ${linkSectionRe}`)
    debug(`Link section: ${body}`)
    return
  }

  if (!URL.canParse(link)) return info(`Invalid URL: ${link}`)

  const url = new URL(link)
  if (!config.invalidLink.hosts.includes(url.hostname))
    return info("Link did not match allowed reproduction hosts")

  try {
    // Verify that the link can be opened
    // We allow 500, in case it's a downtime
    const { status } = await fetch(link)
    const ok = status < 400 || status >= 500
    if (!ok) info(`Link returned status ${status}`)
    return ok
  } catch (e) {
    info(`Link fetching errored: ${e.message}`)
    return false
  }
}

/**
 * Return either a file's content or a string
 * @param {string} pathOrComment
 */
async function getCommentBody(pathOrComment) {
  try {
    await access(pathOrComment)
    return await readFile(pathOrComment, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return pathOrComment
    throw error
  }
}

async function commentOnLabel() {
  const { issue, action } = context.payload

  if (action !== "labeled" || !issue) return

  const commentableLabels = Object.keys(config.labelComments)
  if (!commentableLabels.length) return

  /** @type {string[]} */
  const labels = issue.labels.map((l) => l.name)
  const newLabel = context.payload.label.name

  if (
    !commentableLabels.includes(newLabel) &&
    !labels.some((l) => commentableLabels.includes(l))
  )
    return info("Not manually or already labeled.")

  const { rest: client } = getOctokit(config.token)

  const file = config.labelComments[newLabel]
  const body = await readFile(join(config.workspace, file), "utf8")
  await client.issues.createComment({
    ...context.repo,
    issue_number: issue.number,
    body,
  })

  info(`Commented on issue #${issue.number} with ${file}`)
}

async function run() {
  await checkValidReproduction()
  await commentOnLabel()
}
