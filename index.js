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
      getInput("reproduction_comment") || ".github/invalid-reproduction.md",
    hosts: (getInput("reproduction_hosts") || "github.com")
      .split(",")
      .map((h) => h.trim()),
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
    areaPrefix: getInput("label_area_prefix") || "area:",
  },
  token: process.env.GITHUB_TOKEN,
  workspace: process.env.GITHUB_WORKSPACE,
}

debug(`Config: ${JSON.stringify(config, null, 2)}`)

async function checkValidReproduction() {
  const { issue, action } = context.payload

  if (action !== "opened" || !issue?.body) return

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

// Borrowed from Refined GitHub:
// https://github.com/refined-github/refined-github/blob/c864a20b57bb433aaf3952f88d83c9fc481ae6ff/source/helpers/is-low-quality-comment.ts#L2-L3
const unhelpfulRe =
  /[\s,.!?👍👎👌🙏]+|[\u{1F3FB}-\u{1F3FF}]|[+-]\d+|⬆️|ditt?o|me|too|t?here|on|same|this|issues?|please|pl[sz]|any|updates?|bump|question|solution|following/giu
function isUnhelpfulComment(text) {
  return text.replace(unhelpfulRe, "") === ""
}

async function hideUnhelpfulComments() {
  const { comment, action, issue } = context.payload
  if (action !== "created" || !comment || !issue) return

  const { node_id: subjectId, body } = comment

  if (!isUnhelpfulComment(body) && !isStillHappeningWithoutLink(body)) return

  debug(
    `Comment (${body}) on issue #${issue.number} is unhelpful, minimizing...`
  )
  const { graphql } = getOctokit(config.token)
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

/* This action will automatically add labels to issues based on the area(s) of Next.js that are affected. */
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
  // Only load labels that start with a prefix and have a description
  for (const label of labelData)
    if (label.name.startsWith(config.labels.areaPrefix) && label.description)
      labels.set(label.name, label.description)

  if (!labels.size)
    return info(`No labels with prefix (${config.labels.areaPrefix}) found`)

  debug(`Loaded labels: ${Array.from(labels.keys()).join(", ")}`)

  for (const [label, description] of labels.entries())
    if (matchSection.includes(description)) labelsToAdd.push(label)

  debug(`Labels to add: ${labelsToAdd.join(", ")}`)

  if (!labelsToAdd.length) return info("No labels to add")

  const formatted = labelsToAdd.map((l) => `"${l}"`).join(", ")
  debug(`Adding label(s) (${formatted}) to issue #${issue_number}`)

  const common = { ...context.repo, issue_number: issue.number }
  await client.issues.addLabels({ ...common, labels: labelsToAdd })

  info(`Added labels to issue #${issue_number}: ${labelsToAdd.join(", ")}`)
}

async function run() {
  await autolabelArea()
  await checkValidReproduction()
  await commentOnLabel()
  await hideUnhelpfulComments()
}

run().catch(setFailed)
