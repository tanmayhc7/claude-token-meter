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
in 182.4k · out 6.1k +~240 · Σ 188.5k/500.0k · ctx 18% · $0.42/$5.00
```

Subagents' requests are counted too.

## Commands

| Command | What it does |
| --- | --- |
| `/tokens` | Opens the token usage pane |
| `/token-budget 500k` | Sets a token budget for the session |
| `/token-budget $5` | Sets a dollar budget (both at once: `/token-budget 500k $5`) |
| `/token-budget` | Shows the current budget |
| `/token-budget off` | Clears the budget |
| `/token-cost 200k 20k` | Prices 200k input + 20k output tokens on every model |
| `/token-cost 200k 20k opus` | The same, for one model (`opus`, `sonnet`, `haiku`, `fable`, or an id like `opus-4-8`) |

Budgets warn you with a pop-up and a system notification at **80%** and again at **100%**. A budget carries over to later sessions until you clear it.

The token budget counts every token the session's requests processed, cache reads included. Cache reads grow quickly in long sessions, so a dollar budget usually tracks real spend more closely.

The calculator shows two prices: input sent fresh, and the same input read from the prompt cache.

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
