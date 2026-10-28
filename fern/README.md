# Foreman docs

Fern-based documentation site for Foreman.

## Preview locally

```bash
# From the repo root
cd fern
fern docs dev
```

If `fern` isn't on your PATH, `npm install -g fern-api` installs the
CLI. The package name is `fern-api`; the binary is `fern`.

The dev server runs the site on `localhost:3000` and reloads on
MDX edits.

## Publish

```bash
cd fern
fern generate --docs
```

The generated site is pushed to the URL declared in `docs.yml`
under `instances[].url`.

## Structure

```
fern/
  fern.config.json          Fern org and version pin
  docs.yml                  Site title, nav, instance URLs
  pages/
    overview/               Landing section
    start/                  Getting started
    how/                    How Foreman works, architecture, graph
    use/                    Day-to-day task-shaped guides
    tools/                  Tool reference, grouped by role
    playbooks/              Worked examples
    ops/                    Deployment, triggers, logs, state
    ref/                    Env vars, schema, models, FAQ, changelog
```

## Updating a tool page

Each tool's input/output schema lives in `agent/tools/*.ts` as a
Zod schema and in `agent/instructions.ts` as a row in the tools
table. The reference pages under `pages/tools/` are hand-authored
against those sources. On a tool change, update the matching
section in the right reference page.

A future script could walk the tool registry at build time and
emit the ParamField / ResponseField tables from the Zod schemas
directly. That generator does not exist yet.
