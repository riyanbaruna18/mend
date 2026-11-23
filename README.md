# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/bounty/hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun](https://make.fun/badge/submissions/hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun](https://make.fun/badge/leaderboard/hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`mend` is one command-line tool that applies the edits AI models write, in four formats, to a tree of files. `SPEC.md` is the whole specification. Node 22 and its standard library alone:

    node main.ts [options] [PATCH]

`PATCH` absent or `-` reads the patch from stdin. Options: `--format=NAME` (`auto`, `unified`, `search-replace`, `v4a`, `json`), `--check` (dry run), `--strict` (exact matching only).

## The four formats

- **Unified diff** — `diff --git` / `---` + `+++` sections with `@@` hunks; wrong line numbers are tolerated (a hunk lands on the occurrence nearest its stated position), files can be created, deleted or moved.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines, `=======`, new lines, `>>>>>>> REPLACE`; a block with no old lines creates its file.
- **V4A patch** — `*** Begin Patch` … `*** End Patch` with `*** Add File:` / `*** Delete File:` / `*** Update File:` sections, optional `*** Move to:` and `*** End of File` anchors.
- **JSON** — one JSON array of edit objects, or JSON Lines, with `create`, `str_replace` and `insert` commands.

Line matching works at three tiers: exact, then trailing whitespace ignored, then leading and trailing whitespace ignored (with re-indentation of new lines). A failed edit changes nothing, later edits still run, and when any edit fails no file is written at all.

## The files

- `main.ts` — the CLI. Implements all of SPEC.md: the command line, output and exit codes, safe paths, format detection, three-tier line matching, all four formats, JSON edits and the all-or-nothing write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts` — unchanged from the kit. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts` — the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../mend-kit/program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md` — the specification.
- `LICENSE` — MIT.

## Results

- Practice set: **100 of 100 passed, practice score 1000**.
- Hand-written edge tests (27 cases: `--strict`, `--check`, usage / no-patch / format / parse errors, ambiguous / missing / exists / unsafe, CRLF, no final line break, `\ No newline at end of file`, moves, all four formats, JSON array and JSON Lines): **27 passed, 0 failed**.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.
