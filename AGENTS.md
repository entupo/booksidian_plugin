# AGENTS.md

## Project
- Fork of [MichaBrugger/booksidian_plugin](https://github.com/MichaBrugger/booksidian_plugin) (Goodreads sync v0.12.0 upstream master) with local additions: Goodreads-id note matching, frontmatter field merging, and duplicate reconciliation.
- `src/` is the source of truth. `src/Book.ts` builds books from the Goodreads RSS feed and creates/updates notes; `src/Shelf.ts` fetches feeds and covers; `src/Frontmatter.ts` owns YAML composition (`getBookValues`), parsing (`parseFrontmatter`), merging (`mergeFrontmatter` / `mergeUnknownKeys` / `formatFrontmatter`), and `stripFrontmatter`; `src/DuplicateResolver.ts` implements the "Find duplicate book notes" command; `src/settings/` owns the settings tab. `const/` holds types and defaults (`const/settings.ts` includes `useIdMatch`).
- `main.js` is generated and gitignored. Vault `data.json` is Obsidian-owned state; never edit it as source except explicitly requested settings key additions.

## Build / Install (obsidian-bible-notes parity)
- `npm run build` = `tsc -noEmit -skipLibCheck` → esbuild production bundle → `copy-to-vault.mjs`.
- `npm run dev` is esbuild watch only, no typecheck.
- `copy-to-vault.mjs` copies `main.js`, `manifest.json`, `styles.css` to the hard-coded `/Users/spencer/Vaults/bnotes/.obsidian/plugins/booksidian-plugin`, then pings the local reload server at `http://127.0.0.1:37420/`. If the server is not running, the plugin must be reloaded manually (disable/enable in Obsidian).
- The repo's user settings live in the vault's `data.json` (not present in the repo). Current values: targetFolderPath `Archives/Books`, overwrite + overwritePreserveBody on, useIdMatch on, full frontmatterDictionary incl. `series: seriesName`.

## Tests
- `npx jest` runs everything (ts-jest, `testRegex: test/.*Test.ts`; suites: `BookTest`, `FrontmatterTest`). 38 tests must stay green. Single file: `npx jest test/FrontmatterTest.ts`.
- Jest needs two mocks (upstream never fixed this): `test/mocks/obsidian.cjs` (the `obsidian` npm package is types-only, `main: ""`) mapped in `jest.config.js` as `^obsidian$`, and `test/mocks/slugify.cjs` for the ESM-only `@sindresorhus/slugify`.
- Note matching itself is not unit-tested (needs the Obsidian app); the pure YAML/merge functions in `src/Frontmatter.ts` are the tested surface. Keep new logic pure-function where possible and test it there.

## Behavior Constraints (do not regress)
- **ID matching**: `createFile` resolves existing notes by filename inside `targetFolderPath` first, then (when `useIdMatch` and `overwrite` are on) whole-vault lookup via `getIdKeys(frontmatterDictionary)` on the metadata cache. `getIdKeys` is template-aware (renamed keys like `goodreads-id: id` count via `resolveFieldTemplate`) and also keeps the legacy bare `id` as a fallback whenever at least one renamed id key exists. Ties prefer the target folder. The matched note is updated in place; a Notice lists the chosen path and any other matches.
- **Update semantics**: only keys present in `frontmatterDictionary` may change; every other frontmatter key (status, tags, citekey, zotero-key, created/modified, …) and the note body must survive byte-identical. `parseFrontmatter` uses `yaml.JSON_SCHEMA` so YAML dates/timestamps stay strings and are re-dumped without churn.
- **`tags` field**: dictionary entry `tags` is a static custom field — its value is a comma-separated list (e.g. `Book, Reading`), stripped of `#`, merged with tags produced by `#shelves`.
- **Renamed keys / `coverImageName`**: dictionary keys can be renamed in the settings (pencil button, `RenameKeyModal`) to any YAML key; templates then resolve the source field by finding a known book field (see `KNOWN_BOOK_FIELDS` in `src/Frontmatter.ts`) inside the value. `coverImageName` is the bare cover filename (`58152486.jpg`) for basename wikilinks like `image: [[coverImageName]]`. Templates that don't contain their key or a known field emit `""` — a missing split piece no longer dumps `undefined`.
- **Junk guard**: empty/undefined/NaN book fields emit `""`, never template residue like `series: Name` or `seriesName: seriesundefined`.
- **Body safety**: id/matched notes outside the target folder always get body-preserving merge, regardless of `overwritePreserveBody`. When `parseFrontmatter` returns null (malformed YAML), fall back to the legacy regenerate-frontmatter path; never destroy content on parse errors.
- **Duplicates**: `DuplicateResolverModal` groups by shared id; the survivor keeps its frontmatter/body and gains keys only the losers had; losers go to vault trash only when the user confirms. ZotLit notes (frontmatter `citekey`) are the preferred survivor.
- **Manual cover pull**: "Download cover for current note" (`src/CoverRefresher.ts`) resolves a cover for the active note keyed by its Goodreads id: sources in order — remote `cover` URL in frontmatter → Open Library by note's ISBN (`?default=false`, follows redirects into archive.org; Google Books anonymous API is often 429-quota'd, treat as weak fallback) → Goodreads `/book/photo/<id>` (gated anonymously: the og:image you get is the site icon, `scrapeOgImageUrl` filters it). Writes `<coverDownloadLocation>/<id>.jpg`, then updates only the dictionary's cover-related keys (via `buildCoverUpdates` in `src/Frontmatter.ts`) with a body-preserving merge.
- Vault frontmatter style: YAML arrays single-line (hence `flowLevel: 1` in merges); Obsidian Linter enforces key order and smart typography — do not fight it in generated YAML beyond that.

## Release And Style
- `.editorconfig`/`.prettierrc`: tabs (width 4), double quotes, semicolons, trailing commas. `typescript 4.4`, `noImplicitAny` on but no `strict`/`strictNullChecks` in `tsconfig.json`; `npm run build` must stay typecheck-clean. ESLint configured (`.eslintrc`) but no lint script.
- Releases are automatic via `.github/workflows/release.yml`: pushing any tag triggers `npm run build` and creates a GitHub release with `main.js` + `manifest.json`. Don't bump the plugin version without a release decision; `manifest.json`/`package.json` are at 0.12.0.
