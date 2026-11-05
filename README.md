# claude-token-meter

A Claude Code plugin that shows your token usage live, while Claude is still responding, and warns you before a session goes over a token or dollar budget.

## What it shows

**A "Token usage" pane** beside the chat (reopen it any time with `/tokens`):

- **Input tokens**, split into uncached, cache read and cache write
- **Output tokens**, plus an estimate that counts up while a response is still streaming
- Total tokens, number of model requests, and the session's cost
- A context-window bar (green, then yellow at 60%, red at 85%)
- A bar for each budget you've set

**A status line entry** with the same figures on one line, for example:

```
in 182.4k · out 6.1k +~240 · Σ 188.5k/500.0k · ctx 18% · $0.42/$5.00 │ all 3.42M/5.00M · 1.58M left
```

Subagents' requests are counted too.

**An all-sessions total.** Every Claude Code session on your machine with token-meter installed adds its usage to a shared ledger, and every session shows the combined total over a rolling window (5 hours unless you set another). Run three sessions at once and each one shows the same "used / limit · left" figure, updated every 2 seconds, including responses still streaming in the other sessions.

## Commands

| Command | What it does |
| --- | --- |
| `/tokens` | Opens the token usage pane |
| `/token-budget 500k` | Sets a token budget for the session |
| `/token-budget $5` | Sets a dollar budget (both at once: `/token-budget 500k $5`) |
| `/token-budget` | Shows the current budgets |
| `/token-budget off` | Clears this session's budget |
| `/token-budget all 5M` | Sets a budget shared by every session, over the last 5 hours |
| `/token-budget all $20 24h` | A shared dollar budget over a different window (`5h`, `24h`, `7d`, ...) |
| `/token-budget all off` | Clears the shared budget, in every session |
| `/token-cost 200k 20k` | Prices 200k input + 20k output tokens on every model |
| `/token-cost 200k 20k opus` | The same, for one model (`opus`, `sonnet`, `haiku`, `fable`, or an id like `opus-4-8`) |

Budgets warn you with a pop-up and a system notification at **80%** and again at **100%**. A budget carries over to later sessions until you clear it.

The token budget counts every token the session's requests processed, cache reads included. Cache reads grow quickly in long sessions, so a dollar budget usually tracks real spend more closely.

The calculator shows two prices: input sent fresh, and the same input read from the prompt cache.

### How the all-sessions total works

- Each session writes its own requests to `~/.claude/token-meter/sessions/<session id>.json` and reads everyone's files every 2 seconds. No session writes another's file, so sessions running at the same time can't overwrite each other.
- The shared budget lives in `~/.claude/token-meter/budget.json`, so setting it in one session sets it in all of them.
- It's a rolling window: tokens older than the window drop off, and "left" grows back. Records older than 8 days are deleted.
- It counts Claude Code sessions on this machine that have token-meter installed. It doesn't see claude.ai, the Claude apps' chat, or other computers.
- **This is your own limit, not your plan's.** Anthropic doesn't publish plan limits in tokens, so the plugin can't know your plan's real allowance; `/usage` shows how much of the plan you've used as a percentage. Pick a number that suits you, for example by noting how many tokens a full 5-hour window takes before `/usage` reaches 100%.
- The all-sessions cost is an estimate from API list prices, request by request.

## Install

You need Claude Code installed and signed in. Pick either way below.

**Inside Claude Code.** Start a session in your terminal (`claude`) and type at the prompt:

```
/plugin install token-meter --marketplace tanmayhc7/claude-token-meter
```

1. Answer `y` when it asks to add the `claude-token-meter` marketplace.
2. Pick a scope: **user** turns it on in every project, **project** only in the current folder (shared through the repo's `.claude/settings.json`), **local** only for you in the current folder.

**From a shell**, without opening a session:

```bash
claude plugin install token-meter --marketplace tanmayhc7/claude-token-meter
```

Then start a new session. The plugin loads when a session starts, so a session that was already open won't have it until you restart it.

To check it's installed, type `/plugin` and look for `token-meter` in the list. To remove it:

```bash
claude plugin uninstall token-meter
```

## Using it in Claude Code

1. **Start a session.** The **Token usage** pane opens beside the chat, and the status line shows `in … · out … · Σ …`. Both read zero until Claude answers.
2. **Send a message.** While Claude responds, the output figure counts up (`+~240` is the live estimate). When the response finishes, the exact counts from the API replace the estimate.
3. **Set a budget**, if you want a warning:
   ```
   /token-budget $5
   ```
   or by tokens, `/token-budget 500k`. At 80% you get a pop-up and a system notification, and again at 100%. Type `/token-budget` on its own to see the current budget, or `/token-budget off` to clear it.
4. **Price a request before you send it:**
   ```
   /token-cost 200k 20k sonnet
   ```
   This prints what 200k input and 20k output tokens cost on Claude Sonnet 5.5, both sent fresh and with the input read from the prompt cache. Leave out the model to compare every model.
5. **Closed the pane?** Type `/tokens` to open it again.

## Notes

- The streaming figure is an estimate (about 4 characters per token). The exact counts replace it as soon as each response finishes.
- Cost comes from Claude Code's own cost ledger, the same one `/cost` uses.
- The calculator uses Anthropic API list prices kept in [`hooks/pricing.ts`](hooks/pricing.ts). Check them against [anthropic.com/pricing](https://www.anthropic.com/pricing) before budgeting on them. On a Claude plan (Pro, Max, Team) you aren't billed per token; usage counts against your plan's 5-hour and weekly limits instead.

## Development

```bash
claude plugin validate .
claude plugin test .
```

To try local changes, start Claude Code with `claude --plugin-dir /path/to/claude-token-meter`.

## License

MIT
