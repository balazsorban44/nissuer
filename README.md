# Nissuer

A GitHub Action for tried and tired maintainers.

This action is meant to help maintainers of open source projects by automating some of the more tedious/repetitive tasks that come with the job. Make issues non-issues quicker by letting it handle unhelpful issues/comments.

## Features

- Autoclose/comment/label/lock issues that do not have a valid reproduction URL
- Autocomment on issues based on labels added by a maintainer
- Hide "+1", "same issue", etc. comments on issues (based on [Refined GitHub](https://github.com/refined-github/refined-github/blob/c864a20b57bb433aaf3952f88d83c9fc481ae6ff/source/helpers/is-low-quality-comment.ts#L2-L3))
- Autolabel issues based on user selection (TODO)

## Usage

Add a workflow (eg. `.github/workflows/nissuer.yml`):

```.github/workflows/nissuer.yml
name: Nissuer test

on:
  issues:
    types: [opened]
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
        uses: balazsorban44/nissuer@1.2.0
```

Add a comment file (by default we look for `.github/invalid-reproduction.md`):

> NOTE: Developers are coming to your project with all sorts of backgrounds/skill levels or understanding of the open source world. Show empathy while using this action. 💚 We recommend adding comments that not only dismiss unhelpful issues/comments, but educate the user on how to be more helpful in the future.

```md
Thanks for opening an issue!

Unfortunately, we can't help you without a reproduction URL.

It was closed automatically, but feel free to reopen it once you have a reproduction URL.
```

A good example for a comment is in the [Next.js repository](https://github.com/vercel/next.js/blob/canary/.github/actions/issue-validator/repro-link/invalid-link.md).
