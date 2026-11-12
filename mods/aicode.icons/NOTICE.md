# What is in this mod, and where it comes from

| Folder | Icon themes | Source | License |
|---|---|---|---|
| `seti/` | Seti | VS Code's `theme-seti`, based on Seti UI | MIT — `seti/LICENSE.md`, `seti/ThirdPartyNotices-seti.txt` |
| `vscode-icons/` | VS Code Icons, and one per framework (Angular, React, Next.js, Vue / Nuxt, NestJS, Bun, Spring Boot, .NET, FastAPI, Django, Laravel) | vscode-icons 13.0.0 (via `@iconify-json/vscode-icons`); file associations and framework glyphs from CodeFlow's icon packs | MIT — `vscode-icons/LICENSE.md` |

`vscode-icons/` was generated from CodeFlow's icon packs (`src/lib/icons/packs.ts` there): one
theme per pack, and one SVG per icon those themes use, nothing else. CodeFlow's rules are
first-match-wins; exact names and dot-extensions became the usual VS Code tables, and the rest
(`tsconfig*`, `*Controller.java`, `[*/`…) the `fileNamePatterns` / `folderNamePatterns` AICode reads.
