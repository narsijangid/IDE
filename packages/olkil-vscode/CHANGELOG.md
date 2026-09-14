# Changelog

## 1.0.22

- Assistant summaries render headings, lists, and dividers
- New chat (icon) and Sign out sit in the view title, left of the panel maximize control

## 1.0.21

- Custom models no longer send unsupported `reasoning_content` to OpenAI-compatible APIs

## 1.0.19

- Editor title bar uses the OLKIL rainbow logo

## 1.0.18

- Save more than one custom model in the picker (Add custom… stays available)
- OLKIL icon in the editor title bar, same place as other chat extensions

## 1.0.17

- Cloud turns debit OLKIL credit from the real provider cost (including reasoning models), then refresh the balance in the sidebar

## 1.0.16

- Marketplace resources no longer link a GitHub repository

## 1.0.15

- Model picker lists the same OpenRouter catalog as the OLKIL desktop app, with search
- Sign-in screen no longer shows the large center logo

## 1.0.13

- Live status shine sits on the latest step at the bottom of the list
- Free-plan upgrade no longer shows Working behind the plans
- Custom models: Save, show the model id in the picker, Change / Delete
- Composer matches the OLKIL desktop input; Undo restores files in the editor

## 1.0.12

- Live status uses a text shine instead of pulsing dots; finished steps stay still
- File changes match the compact +/− / Undo / Keep layout
- Composer send control is an icon; assistant summaries render markdown

## 1.0.11

- Agent-only: no plan/ask/explore; file reads and edits stay visible in the thread
- Enter sends the prompt (Shift+Enter for a new line)
- Free plan keeps chat open; sending a cloud message shows Lite/Pro/Ultra. Custom model (id, base URL, API key) is in the header

## 1.0.10

- Agent applies file edits instead of writing search reports (same build-agent behavior as the OLKIL desktop app)

## 1.0.9

- Match the OLKIL desktop agent: same engine version, edit tools, workspace folder, and file-update prompt

## 1.0.8

- Marketplace headline: AI-powered code editor for VS Code

## 1.0.7

- Official OLKIL favicon as the Marketplace and sidebar icon
- Marketplace description and keywords for Codex-alternative / AI agent search

## 1.0.6

- Open the chat on the right (secondary sidebar), like Codex
- Use the official OLKIL rainbow mark as the extension icon

## 1.0.5

- Hide leftover Working / Engine ready rows; live status sits under the latest prompt on the left
- Auto-scroll while the agent works
- File cards show +added / −removed with Accept and Revert
- OLKIL icon in the VS Code title / activity bar, next to other agents

## 1.0.4

- Chat opens on the right (secondary sidebar), like Claude Code / Codex
- Live thinking, planning, and tool status appear in the thread under the prompt
- File-change card with +/- counts; Lite/Pro/Ultra usage updates with the same debit as the desktop app

## 1.0.3

- Stop leaking hidden reasoning / AGENTS.md text and duplicated greetings
- Fetch the cloud engine key from Firebase (signed-in only), never ship it in the VSIX
- Same Lite/Pro/Ultra wallet and model picker as the OLKIL desktop app

## 1.0.2

- Hide echoed system/user prompt dumps in chat
- Paid Lite/Pro/Ultra use the same cloud route as the desktop app (not a depleted DeepSeek pool)

## 1.0.1

- Fix agent replies in the sidebar (engine event stream)
- VS Code agent is paid-only: Free users see Lite / Pro / Ultra upgrade

## 1.0.0

- First Marketplace release
- Activity Bar chat, olkil.com sign-in, local coding engine
- Selection context and Ctrl/Cmd+L shortcuts
