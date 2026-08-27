# @afora/diffs-language-pack

Official extended syntax highlighting pack for the Afora Diffs plugin.

The base `@afora/diffs` plugin ships a curated language set. Install this package when you want the full Shiki language catalog available in rendered diff viewers and diff image/PDF output.

The pack adds highlighting for languages outside the default diffs viewer set, including Astro, Vue, Svelte, MDX, GraphQL, Terraform/HCL, Nix, Clojure, Elixir, Haskell, OCaml, Scala, Zig, Solidity, Verilog/VHDL, Fortran, MATLAB, LaTeX, Mermaid, Sass/Less/SCSS, Nginx, Apache, CSV, dotenv, INI, and diff files. See the plugin reference and Shiki language catalog for details.

## Install

```bash
afora plugins install @afora/diffs-language-pack
```

Restart the Gateway after installing or updating the plugin.

## Use with Diffs

Install `@afora/diffs` first, then install this language pack. The language pack contributes static viewer assets; it does not register a separate agent tool.

## Docs

- https://docs.afora.ai/tools/diffs
- https://docs.afora.ai/plugins/reference/diffs-language-pack

## Package

- Plugin id: `diffs-language-pack`
- Package: `@afora/diffs-language-pack`
- Minimum Afora host: `2026.5.27`
