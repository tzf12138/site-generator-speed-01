# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/tzf12138/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/tzf12138/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: a dependency-free ES module that builds the same static sites byte for byte. `solve.js` re-implements makefun-site's front matter, template dialect, Markdown subset, slug rule and build report from scratch, then speeds the work up: templates are compiled to plain JavaScript functions once per build (with a tree-walking interpreter as fallback), Markdown is lexed and rendered in one pass with plain text runs copied verbatim, and slugs and word counts use cached scans instead of regexes. On the kit's practice set it answers all 3 cases identically to the reference, about 3x faster than the house baseline's `run()`.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`main.ts` is the harness driver: it reads every case from `cases.json` in the input directory, answers each one alone with `run()` from `solve.js`, and writes `answers.json` to the output directory. Node 22 or later, no dependencies, no install step.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9ewgsfmm&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
