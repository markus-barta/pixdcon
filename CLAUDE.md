<!--
  Layered doctrine loader for Claude Code.

  Loads the INSPR kernel plus this repo's own ruleset. Other tools
  (Cursor, Aider, OpenCode, Codex CLI) read AGENTS.md instead — that's a
  symlink to +agents/rules/AGENTS.md, the pixdcon-specific overlay.

  Doctrine source: github.com/inspr-at/inspr-modules, vendored as the
  ./doctrine submodule; bump with `git submodule update --remote doctrine`.

  Domain depth loads on demand via slash commands — /ppm /dev /secrets
  /ops /nix /iac /style /incident. `/inspr` prints the TL;DR map.
-->

@./doctrine/docs/AGENTS-KERNEL.md
@./AGENTS.md
