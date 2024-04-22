# nissuer

> Turn issues into non-issues quicker

A GitHub Action for tried and tired maintainers. This action is meant to help maintainers of open-source projects by automating some of the more tedious/repetitive tasks that come with the job.

## Features

nissuer comes with a default configuration, but you can override certain behaviors. Below is a list of features and the corresponding inputs.

### Handle unhelpful comments

- nissuer can hide "+1", "same issue", etc. comments on issues (partially based on [Refined GitHub](https://github.com/refined-github/refined-github/blob/c864a20b57bb433aaf3952f88d83c9fc481ae6ff/source/helpers/is-low-quality-comment.ts#L2-L3)). It won't hide comments from the repo organization members.
- nissuer can also update the hidden comment with a note from the maintainers, explaining to the user why the comment was hidden. This is used for education purposes, so hopefully the user will be more considerate in the future.

| Input                      | Description                                                                        | Default Value |
| -------------------------- | ---------------------------------------------------------------------------------- | ------------- |
| `comment-add-explainer`    | Add an explainer to a comment that was marked as off-topic.                        | `true`        |
| `comment-unhelpful-weight` | If an issue comment is below this rate, it will be marked as off-topic and hidden. | `0.3`         |

### Validate reproduction URLs

- nissuer can close/comment/label/lock issues that do not have a valid reproduction URL
- nissuer validates the returned status code of a reproduction URL (for example a private GitHub repository will not be considered valid)

| Input                        | Description                                                                                                                                                                                          | Default Value                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `reproduction-comment`       | Either a string or a path to a .md file inside the repository.                                                                                                                                       | `.github/invalid-reproduction.md`              |
| `reproduction-hosts`         | Comma-separated list of hostnames allowed for reproductions.                                                                                                                                         | `github.com`                                   |
| `reproduction-blocklist`     | Comma-separated list of regular expression string that are not allowed for reproductions. (Eg.: "github.com/.\*/fork-of-non-reproduction"')                                                          |                                                |
| `reproduction-invalid-label` | Label to apply to issues without a valid reproduction.                                                                                                                                               | `invalid-reproduction`                         |
| `reproduction-issue-labels`  | Comma-separated list of issue labels. If configured, only verify reproduction URLs of issues with one of these labels present. A comma at the end will handle issues without any label as non-valid. |                                                |
| `reproduction-link-section`  | A regular expression string with "(.\*)" matching a valid URL in the issue body. The result is trimmed.                                                                                              | `### Link to reproduction(.*)### To reproduce` |

### Label Management

- nissuer can label issues based on the content of an issue. Add a select input, and nissuer will add a label based on the selection.
- nissuer can comment on issues based on labels on behalf of a maintainer. Avoid having to repeat yourself by writing up a comment for common cases

| Input                | Description                                                                                                                                                                         | Default Value                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `label-comments`     | Autocomment on issues based on the added label. It should be a JSON object, where the key is a label, and the value is a file path or a comment text.                               | `{"invalid reproduction": ".github/invalid-reproduction.md"}` |
| `label-area-prefix`  | Only look for these labels when autolabeling based on the user selection. (Can be set to an empty string `""` to match all labels.)                                                 | `area:`                                                       |
| `label-area-match`   | Whether to look for the label names or description, when matching.                                                                                                                  | `description`                                                 |
| `label-area-section` | A regular expression string with "(.\*)" matching a section in the issue body to look for user-selected areas. The result is trimmed. Labeling is skipped if this is not configured |                                                               |

### Notify about public security disclosures

- nissuer can detect if an issue about a potential vulnerability might have been opened publicly by accident and notify the maintainer about it.
- nissuer can also delete the issue automatically and send you all the details via a webhook. This can help avoid staying up late at night to fix a vulnerability that was not disclosed responsibly.

| Input                         | Description                                                                                 | Default Value |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------- |
| `webhook-url`                 | Webhook URL to send notifications to.                                                       |               |
| `webhook-secret`              | Secret to use for the webhook. It will be part of the JSON body of the request as `secret`. |               |
| `delete-vulnerability-report` | Delete the vulnerability report after sending it to the webhook.                            | `false`       |

## Usage

Here is a minimal setup of nissuer. Add a workflow (eg. `.github/workflows/nissuer.yml`):

```.github/workflows/nissuer.yml
name: Triage via nissuer

on:
  issues:
    types: [opened, labeled]
  issue_comment:
    types: [created]

permissions:
  issues: write

env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

jobs:
  issue-validator:
    runs-on: ubuntu-latest
    steps:
      - name: Nissuer
        uses: balazsorban44/nissuer@1.10.0
```

Add a comment file (by default we look for `.github/invalid-reproduction.md`):

> NOTE: Developers are coming to your project with all sorts of backgrounds/skill levels or understanding of the open-source world. Show empathy while using this action. 💚 We recommend adding comments that not only dismiss unhelpful issues/comments, but educate the user on how to be more helpful in the future.

```md
Thanks for opening an issue!

Unfortunately, we can't help you without a reproduction URL.

It was closed automatically, but feel free to reopen it once you have a reproduction URL.
```

A good example of a comment is in the [Next.js repository](https://github.com/vercel/next.js/blob/canary/.github/comments/invalid-link.md).
