## Plugins in This Directory

| Name                                                | Description                                                                                             | Contents                         |
|-----------------------------------------------------|---------------------------------------------------------------------------------------------------------|----------------------------------|
| [gitlab-code-review](plugins/gitlab-code-review)    | Automated code review for pull requests using multiple specialized agents with confidence-based scoring | **Command:** `/glab-code-review` |
| [Caveman](https://github.com/JuliusBrussee/caveman) | Token usage compression                                                                                 | **Command:** `/caveman help`     |
| [Superpowers](https://github.com/obra/superpowers)  | Claude code with superpowers                                                                            | **Command:** `/superpower help`  |

## Installation

1. Add claude marketplace:
```bash
claude plugin marketplace add https://github.com/algoritma-dev/claude-plugins
```

2. Enable auto-update for marketplace

```bash
claude
```

type /plugin and to marketplace tab then select the algoritma-marketplace and check "Enable auto-update"

3Use the `/plugin` command to install plugins from marketplaces, or configure them in your project's `.claude/settings.json`.

## Plugin Structure

Each plugin follows the standard Claude Code plugin structure:

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json          # Plugin metadata
├── commands/                # Slash commands (optional)
├── agents/                  # Specialized agents (optional)
├── skills/                  # Agent Skills (optional)
├── hooks/                   # Event handlers (optional)
├── .mcp.json                # External tool configuration (optional)
└── README.md                # Plugin documentation
```

## Contributing

When adding new plugins to this directory:

1. Follow the standard plugin structure
2. Include a comprehensive README.md
3. Add plugin metadata in `.claude-plugin/plugin.json`
4. Document all commands and agents
5. Provide usage examples