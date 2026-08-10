# OLKIL Engine

Vendored coding-agent runtime for OLKIL IDE.

Based on Cline SDK (Apache-2.0): https://github.com/cline/cline

| Folder | Package |
|--------|---------|
| shared | @olkil/shared |
| llms | @olkil/llms |
| agents | @olkil/agents |
| core | @olkil/core |
| sdk | @olkil/engine |

`src/` = full source to customize. `dist/` = runtime (fast, not webpack-bundled).

Relink: `yarn link-olkil-engine`
