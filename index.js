// @ts-check

import {
  debug,
  error,
  getBooleanInput,
  getInput,
  info,
  setFailed,
} from "@actions/core"
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

/** @param {string} value */
function getBooleanOrUndefined(value) {
  const variable = process.env[`INPUT_${value.toUpperCase()}`]
  if (variable === undefined || variable === "") return undefined
  return getBooleanInput(value)
}

/**
 * @param {string | undefined} value
 * @returns {"name" | "description"}
 */
function getLabelMatch(value) {
  if (value === "name") return value
  return "description"
}

const config = {
  invalidLink: {
    comment:
      getInput("reproduction_comment") || ".github/invalid-reproduction.md",
    bugLabels: getInput("reproduction_issue_labels")
      .split(",")
      .map((l) => l.trim()),
    hosts: (getInput("reproduction_hosts") || "github.com")
      .split(",")
      .map((h) => h.trim()),
    blocklist: (getInput("reproduction_blocklist") || "")
      .split(",")
      .map((h) => new RegExp(h.trim())),
    label: getInput("reproduction_invalid_label") || "invalid-reproduction",
    linkSection:
      getInput("reproduction_link_section") ||
      "### Link to reproduction(.*)### To reproduce",
  },
  labels: {
    comments: tryParse(
      getInput("label_comments") ||
        '{"invalid reproduction": ".github/invalid-reproduction.md"}'
    ),
    areaSection: getInput("label_area_section"),
    areaMatch: getLabelMatch(getInput("label_area_match")),
    areaPrefix: getInput("label_area_prefix") ?? "area:",
  },
  comments: {
    unhelpfulWeight: Number(getInput("comment_unhelpful_weight")) || 0.3,
    addExplainer: getBooleanOrUndefined("comment_add_explainer") ?? true,
  },
  webhook: {
    url: getInput("webhook_url"),
    secret: getInput("webhook_secret"),
  },
  vuln: {
    shouldDelete: getBooleanOrUndefined("delete_vulnerability_report"),
  },
  token: process.env.GITHUB_TOKEN,
  workspace: process.env.GITHUB_WORKSPACE,
}

debug(`Config: ${JSON.stringify(config, null, 2)}`)

async function checkValidReproduction() {
  const { issue, action } = context.payload

  if (action !== "opened" || !issue?.body) return

  /** @type {string[]} */
  const labels = issue.labels.map((l) => l.name)

  const issueWithoutLabel =
    config.invalidLink.bugLabels.includes("") && !labels.length

  const issueMatchingLabel =
    config.invalidLink.bugLabels.length &&
    !labels.some((l) => config.invalidLink.bugLabels.includes(l))

  if (!issueWithoutLabel && issueMatchingLabel)
    return info("Not manually or already labeled")

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
 * Determine if an issue contains a valid/accessible link to a reproduction.
 *
 * Returns `true` if the link is valid.
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

  debug(`Checking validity of link: ${link}`)

  if (!URL.canParse(link)) return info(`Invalid URL: ${link}`)

  const url = new URL(link)
  if (!config.invalidLink.hosts.includes(url.hostname))
    return info("Link did not match allowed reproduction hosts")

  if (config.invalidLink.blocklist.some((r) => r.test(link)))
    return info("Link matched blocklist for reproduction URLs")

  try {
    // Verify that the link can be opened
    const { status } = await fetch(getFetchLink(link))
    // We allow 500, in case it's a downtime
    const ok = status < 400 || status >= 500
    debug(`Link status: ${status}`)
    if (!ok) info(`Link returned status ${status}`)
    return ok
  } catch (e) {
    info(`Link fetching errored: ${e.message}`)
    return false
  }
}

/**
 * HACK: Codesandbox devboxes currently always return a 200 status code, even if the sandbox is not found.
 * We need to use the API to verify if the sandbox exists.
 * @param {string} link
 */
function getFetchLink(link) {
  if (link.startsWith("https://codesandbox.com"))
    return link.replace("/p/devbox/", "/api/v1/sandboxes/")
  return link
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

  const labelsToComment = Object.keys(config.labels.comments)
  if (!labelsToComment.length) return debug("No labels to comment on")

  /** @type {string[]} */
  const labels = issue.labels.map((l) => l.name)
  const newLabel = context.payload.label.name

  if (
    !labelsToComment.includes(newLabel) &&
    !labels.some((l) => labelsToComment.includes(l))
  )
    return info("Not manually or already labeled")

  info(
    `Label "${newLabel}" added to issue #${issue.number}, which will trigger adding a comment`
  )

  const { rest: client } = getOctokit(config.token)

  const file = config.labels.comments[newLabel]
  const comment = join(config.workspace, file)
  await client.issues.createComment({
    ...context.repo,
    issue_number: issue.number,
    body: await getCommentBody(comment),
  })

  info(`Commented on issue #${issue.number} with ${file}`)
}

const stillRe = /(still\s(same|happen(ing|s))|same\son)/gi
const linkRe = /https?:\/\/[^\s/$.?#].[^\s]*/g
function isStillHappeningWithoutLink(text) {
  return stillRe.test(text) && !linkRe.test(text)
}

/**
MIT License

Copyright (c) Sindre Sorhus sindresorhus@gmail.com (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

// Borrowed and tweaked from Refined GitHub:
// https://github.com/refined-github/refined-github/blob/c864a20b57bb433aaf3952f88d83c9fc481ae6ff/source/helpers/is-low-quality-comment.ts#L2-L3
const unhelpfulRe =
  /[\s,.!?👍👎👌🙏]+|[\u{1F3FB}-\u{1F3FF}]|[+-]\d+|⬆️|ditt?o|me|too|t?here|on|same|this|issues?|please|pl[sz]|any|updates?|bump|question|solution|following|problem|still|happen(ing|s)|the/giu
function isUnhelpfulComment(text) {
  const restText = text.replace(unhelpfulRe, "")
  debug(`Rest text: ${restText}`)
  const textLength = text.replace(/\s/, "").length
  debug(`Text length: ${textLength}`)
  const UNHELPFUL_LIMIT = config.comments.unhelpfulWeight
  // Since we use probabilities, this is considered AI. 🙃
  return restText.length / textLength < UNHELPFUL_LIMIT
}

const updatedComment = `_Edit by maintainer bot: Comment was **automatically** minimized because it was considered unhelpful. (If you think this was by mistake, let us know). Please only comment if it adds context to the issue. If you want to express that you have the same problem, use the upvote 👍 on the issue description or subscribe to the issue for updates. Thanks!_`

async function hideUnhelpfulComments() {
  const { comment, action, issue } = context.payload
  if (action !== "created" || !comment || !issue) return

  const {
    node_id: subjectId,
    body,
    id: comment_id,
    author_association,
  } = comment

  // https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment
  // https://docs.github.com/en/graphql/reference/enums#commentauthorassociation
  if (author_association === "MEMBER")
    return debug("Comment was made by an organization owner, skipping...")

  if (!isUnhelpfulComment(body) && !isStillHappeningWithoutLink(body)) return

  info(
    `Comment (${body}) on issue #${issue.number} is unhelpful, minimizing...`
  )
  const { graphql, rest: client } = getOctokit(config.token)

  if (config.comments.addExplainer) {
    debug(`Adding explainer to comment ${comment_id}...`)
    await client.issues.updateComment({
      ...context.repo,
      comment_id,
      body: `${body}\n\n${updatedComment}`,
    })
    info(`Explainer added to comment ${comment_id}`)
  }

  /** @see https://docs.github.com/en/graphql/reference/mutations#minimizecomment */
  await graphql(
    `
      mutation minimize($subjectId: ID!) {
        minimizeComment(
          input: { subjectId: $subjectId, classifier: OFF_TOPIC }
        ) {
          minimizedComment {
            isMinimized
          }
        }
      }
    `,
    { subjectId }
  )

  const shortComment = body.length > 15 ? body.slice(0, 15) + "…" : body
  info(`Comment (${shortComment}) on issue #${issue.number} was minimized.`)
}

/* This action will automatically add labels to issues based on the area(s) of the code that are affected. */
async function autolabelArea() {
  const { action, issue } = context.payload
  if (action !== "opened" || !issue?.body) return

  if (!config.labels.areaSection) return debug("No area section defined")

  const { body, number: issue_number } = issue

  const { rest: client } = getOctokit(config.token)

  const labelsToAdd = []

  const areaSectionRe = new RegExp(config.labels.areaSection, "is")
  const matchSection = body.match(areaSectionRe)?.[1]?.trim()

  if (!matchSection)
    return info(`Issue #${issue_number} does not contain a match section`)

  debug(`Match section: ${matchSection}`)

  const { data: labelData } = await client.issues.listLabelsForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    per_page: 100,
  })

  /** @type {Map<string, string>}*/
  const labels = new Map()
  for (const label of labelData) {
    if (!label.name.startsWith(config.labels.areaPrefix)) continue
    if (config.labels.areaMatch === "description" && label.description) {
      labels.set(label.name, label.description)
    } else if (config.labels.areaMatch === "name") {
      labels.set(label.name, label.name)
    }
  }

  if (!labels.size) return info("No labels to match was found")

  debug(`Loaded labels: ${Array.from(labels.keys()).join(", ")}`)

  for (const [label, criteria] of labels.entries())
    if (matchSection.includes(criteria)) labelsToAdd.push(label)

  debug(`Labels to add: ${labelsToAdd.join(", ")}`)

  if (!labelsToAdd.length) return info("No labels to add")

  const formatted = labelsToAdd.map((l) => `"${l}"`).join(", ")
  debug(`Adding label(s) (${formatted}) to issue #${issue_number}`)

  const common = { ...context.repo, issue_number: issue.number }
  await client.issues.addLabels({ ...common, labels: labelsToAdd })

  info(`Added labels to issue #${issue_number}: ${labelsToAdd.join(", ")}`)
}

/** Common words used in issues publicly disclosing potential vulnerabilities by accident. */
const vulnRegex =
  /\b(vulnerab(?:ility|ilities)|exploit(?:s|ed)?|attack(?:s|ed|er)?|security\s+issue(?:s)?|CVE-\d{4}-\d{4,7}|disclos(?:ure|ed|ing)?|advisory|denial\s+of\s+service|(?:d)?dos)\b/gi

/**
 * This action reads the title and body of a newly opened issue, matches a regex for certain words, and will invoke a webhook if it matches.
 * Optionally, it can also delete the issue.
 */
async function notifyOnPubliclyDisclosedVulnerability() {
  const { action, issue } = context.payload
  if (action !== "opened" || !issue?.body) return
  const { body, title, number: issue_number, user } = issue

  if (!config.webhook.url || !config.webhook.secret)
    return debug("No webhook URL or secret defined")

  if (!vulnRegex.test(`${title} ${body}`))
    return debug("No public vulnerability disclosure detected")

  info(`Public vulnerability disclosure detected in issue #${issue_number}`)

  let deleted = false
  if (config.vuln.shouldDelete) {
    info(`Deleting issue #${issue_number}...`)
    const { graphql } = getOctokit(config.token)
    try {
      await graphql(`
        mutation {
          deleteIssue(input: {issueId: "${issue_number}"}) {
            clientMutationId
          }
        }`)
      deleted = true
      info(`Deleted issue #${issue_number}`)
      debug(`Deleted issue #${issue_number}`)
    } catch (error) {
      error(`Couldn't delete issue #${issue_number}: ${error}`)
    }
  } else debug(`Not deleting issue #${issue_number}`)

  try {
    debug(`Invoking webhook...`)
    const { repo } = context
    const res = await fetch(config.webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "publicly_disclosed_vulnerability",
        repository: `https://github.com/${repo.owner}/${repo.repo}`,
        issue_number,
        title,
        body,
        deleted,
        user: `https://github.com/${user.login}`,
        secret: config.webhook.secret,
      }),
    })

    if (res.ok) return info(`Webhook invoked successfully`)
    error(`Webhook returned an error, check your logs`)
  } catch (error) {
    error(`Error invoking webhook: ${error.message}`)
  }
}

async function run() {
  await autolabelArea()
  await checkValidReproduction()
  await commentOnLabel()
  await hideUnhelpfulComments()
  await notifyOnPubliclyDisclosedVulnerability()
}

run().catch(setFailed)
