# Loopdog

A personal daily-life agent that lives in a Discord DM. You talk to it normally —
"log gym", "remind me to stretch tomorrow at 9am", "what's my reading streak?" — and
Claude works out which tool to call. There are no slash commands and no syntax to
remember.

Single-user by design: it answers to exactly one Discord account and ignores everyone
else in silence.

```
you   log gym
loop  Logged. Four days running now.

you   what's my reading streak?
loop  Twelve days. You've missed one Tuesday all month.

you   remind me to stretch tomorrow at 9am
loop  Set for 09:00 tomorrow.
```

## How it works

Every message goes to Claude (`claude-sonnet-5`) with seven tools attached. Claude
decides what to call and what to say; the bot is a thin harness around that loop.
State lives in a local SQLite file, so everything survives a restart.

| Tool | What it does |
|---|---|
| `create_reminder` | Store a reminder with a due time |
| `list_reminders` | Pending, completed, or due before a cutoff |
| `complete_reminder` | Mark one done |
| `delete_reminder` | Cancel one outright |
| `log_habit` | Record a habit for a day; creates the habit on first mention |
| `get_habit_streak` | Current streak, best ever, and recent day-by-day history |
| `list_habits` | Everything tracked, with streaks |

### Streaks

One grace day. Miss a day and the streak holds but is flagged at risk; miss two in a
row and it resets. Your best-ever streak is never reset. Milestones at 7, 30 and 100
days are computed in SQL, not by the model, so it can't decide 31 days feels
worth celebrating.

### The 4am rule

Loopdog's day runs 04:00 → 04:00, not midnight → midnight. A gym session logged at
01:30 counts for the night it actually happened rather than quietly starting a new
day. "Tomorrow at 9am" said at 2am means *this* morning at 9am.

Set `LOOPDOG_DAY_CUTOFF_HOUR=0` for strict calendar days.

### Overdue reminders

Two independent things happen. Loopdog checks every few minutes for reminders that
just fell due and DMs you about it once, proactively — no need to be talking to it.
Separately, until a reminder is actually completed or deleted, it also leads with it
the next time you talk to the bot about anything, then answers what you actually
asked. The push firing doesn't stop the conversational nudge — that's intentional,
not a bug.

### At-risk nudge

Once a day, around `LOOPDOG_AT_RISK_NUDGE_HOUR` (default 21:00 local), Loopdog checks
for habits with a live streak and nothing logged yet today — the grace-day case —
and sends one DM if there's anything to say. If everything's covered, it stays
quiet. Fires at most once per day; nothing spammy about it.

## Setup

### 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**. Name it whatever you like.
2. Open the **Bot** tab.
3. **Turn on the Message Content Intent.** It's under *Privileged Gateway Intents*.
   Without it the bot connects, appears online, and never sees a single message —
   this is the most common reason Loopdog looks broken.
4. Click **Reset Token**, copy the token. This is your `DISCORD_TOKEN` and it is shown
   only once.

### 2. Invite it to a server

A bot needs to share a server with you before it can accept DMs, even though you'll
mostly talk to it in DMs.

1. **OAuth2 → URL Generator**.
2. Scopes: `bot`.
3. Bot permissions: **Send Messages**, **Read Message History**.
4. Open the generated URL and add it to any server you're in — a private one you made
   for yourself is fine.

### 3. Get your Discord user ID

1. Discord **Settings → Advanced → Developer Mode**, on.
2. Right-click your own name anywhere → **Copy User ID**.

This is `DISCORD_OWNER_ID`. Loopdog only responds to this account.

### 4. Get an Anthropic API key

[platform.claude.com](https://platform.claude.com/) → **API keys** → create one.
This is `ANTHROPIC_API_KEY`.

### 5. Run it

```bash
npm install
cp .env.example .env   # then fill in the three secrets
npm run dev
```

You should see:

```
Loopdog is up as loopdog#1234 — Europe/Stockholm, day rolls over at 4:00, listening to 123456789 only.
```

DM it. In a server, @mention it.

For a long-running deployment, `npm run build && npm start`.

### Testing without Discord

`npm run chat` drops you into a terminal conversation with the exact same
tool-use loop, prompt and SQLite state Discord uses — no bot invite, no
token, no server. It needs only `ANTHROPIC_API_KEY`; `DISCORD_TOKEN` and
`DISCORD_OWNER_ID` are irrelevant to it and can stay unset. Useful for
iterating on `src/prompt.ts` or the tool schemas without a Discord app open.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | Required |
| `DISCORD_OWNER_ID` | — | Required. The only account it answers |
| `ANTHROPIC_API_KEY` | — | Required |
| `LOOPDOG_TZ` | `Europe/Stockholm` | Any IANA zone. DST handled automatically |
| `LOOPDOG_DAY_CUTOFF_HOUR` | `4` | `0` for strict calendar days |
| `LOOPDOG_USER_NAME` | `you` | Used for anything with weight |
| `LOOPDOG_USER_NICKNAME` | — | Used for lighter moments. Optional |
| `LOOPDOG_DB` | `./loopdog.sqlite` | Created on first run |
| `LOOPDOG_EFFORT` | `low` | `low`/`medium`/`high`/`xhigh`/`max`. Raise if tool choices look careless |
| `LOOPDOG_PUSH_INTERVAL_MINUTES` | `5` | How often it checks for newly-overdue reminders to DM you about |
| `LOOPDOG_AT_RISK_NUDGE_HOUR` | `21` | Local hour it checks for live streaks with nothing logged today. Fires at most once a day |

Missing variables are reported all at once at boot, by name.

## Development

```bash
npm run dev        # watch mode, full Discord bot
npm run chat       # terminal REPL, no Discord needed — see above
npm run typecheck  # tsc --noEmit
npm test           # streak rules
npm run build      # -> dist/
```

```
src/
├── index.ts      Discord client, owner gate, message routing
├── repl.ts       terminal chat harness — same agent loop, no Discord
├── agent.ts      the Claude tool-use loop
├── pusher.ts     background poll: reminder pushes + the at-risk nudge
├── prompt.ts     personality + live state injected each turn
├── tools.ts      tool schemas and dispatch
├── streak.ts     streak rules (pure, unit-tested)
├── time.ts       timezone and the 4am boundary
├── config.ts     env parsing with fail-fast validation
└── db/           SQLite: reminders, habits, conversation history
```

Inspect the database directly with `sqlite3 loopdog.sqlite`. Back-dating a few rows in
`habit_logs` is the quickest way to exercise streak behaviour:

```sql
INSERT INTO habit_logs (habit_id, day, created_at)
VALUES (1, '2026-08-09', datetime('now'));
```

## Troubleshooting

**It's online but never replies.** Message Content Intent is off. Step 1.3 above.

**It ignores you in DMs.** `DISCORD_OWNER_ID` doesn't match your account, or the bot
doesn't share a server with you.

**It ignores you in a server.** You have to @mention it there. DMs need no mention.

**Reminders land at the wrong time.** Check `LOOPDOG_TZ`. The boot log prints the zone
in use.

**A late-night log went to the wrong day.** That's the 4am rule working as intended.
Set `LOOPDOG_DAY_CUTOFF_HOUR=0` if you'd rather have strict calendar days.

## Not built yet

- **Sunday evening digest.** A weekly recap: what held, what slipped.
