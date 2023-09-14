// @ts-check

import { info, debug, getInput } from "@actions/core"
import { context, getOctokit } from "@actions/github"
import { readFile, access } from "node:fs/promises"
import { join } from "node:path"

if (!process.env.GITHUB_TOKEN) throw new TypeError("No GITHUB_TOKEN provided")
if (!process.env.GITHUB_WORKSPACE) throw new TypeError("Not a GitHub workspace")

const config = {
  invalidLink: {
    comment: getInput("reproduction-comment"),
    hosts: getInput("reproduction-hosts")
      .split(",")
      .map((h) => h.trim()),
    label: getInput("reproduction-invalid-label"),
    linkSection: getInput("reproduction-link-section"),
  },
}

const { issue } = context.payload

if (!issue?.body) {
  info("Could not get issue body, exiting")
  process.exit(0)
}

if (await isValidReproduction(issue.body)) {
  info(`Issue #${issue.number} contains a valid reproduction 💚`)
  process.exit(0)
}

info(`Invalid reproduction, issue will be closed/labeled/commented/locked...`)

const { rest: client } = getOctokit(process.env.GITHUB_TOKEN)
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
const comment = join(process.env.GITHUB_WORKSPACE, config.invalidLink.comment)
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

/**
 * Determine if an issue contains a valid/accessible link to a reproduction
 * @param {string} body
 */
async function isValidReproduction(body) {
  const linkSectionRe = new RegExp(config.invalidLink.linkSection, "is")
  const link = body.match(linkSectionRe)?.[1].trim()
  if (!link) return info("Missing link")

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
