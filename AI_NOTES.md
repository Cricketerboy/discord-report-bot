# AI_NOTES

## 1. Tools I used and how we split the work

- **Tool:** Claude Code (model: Claude Opus 5.5), inside VS Code.
- **What the AI did:** I pasted the full assignment brief and asked it to build the project. It wrote almost all of the code, the unit tests and end-to-end tests, the README and the setup guide. It ran the type checker and the tests itself and fixed problems until everything passed.
- **What I did:**
  - Created every account and service: the Discord application and test server, the Neon database, the Groq API key, the Render web service and the GitHub repo.
  - Filled in the `.env` file and the Render environment variables.
  - Set the Discord *Interactions Endpoint URL* and the OAuth redirect.
  - Connected the server from the dashboard and tested every command and button in real Discord.
  - Whenever something went wrong, I reported the exact error or a screenshot back to the AI and checked the fix on the live app.
- **Context files:** `CLAUDE.md` holds the project rules for future AI sessions. It was written at the *end* of the first session, so the main build was driven by the pasted brief, not by that file.

## 2. Decisions I made

1. **Deploy straight to Render instead of testing through a local tunnel.** Discord can't reach `localhost`, so the AI offered two options: install a tunnel tool (cloudflared) on my laptop, or deploy. I chose to deploy. The project needs a live URL anyway, and a free tunnel URL changes every time, so I would have kept re-entering it in the Discord portal.
2. **Create the GitHub repo and push the code myself.** I didn't let the AI install extra tools and push for me. I wanted to control exactly what goes public. Before pushing, I had it confirm that `.env` (which holds the bot token and other secrets) was ignored by git and not in the history. After pushing, we checked that `.env` returns 404 on GitHub.
3. **Keep the admin password out of the public README.** The repo is public, so anyone could read a password written there and change the bot's settings. I share the throwaway login in the submission email instead.
4. **Accepted the AI's main architecture, because it matches the quality bar:**
   - Every Discord request is saved to Postgres *before* the bot answers, so nothing is lost and duplicates are ignored (checked by interaction ID).
   - Slow work (the AI, posting to the channel, the mirror) runs in a background job queue with retries, so the bot always answers within Discord's 3-second limit.
   - A Discord channel webhook is the mirror (second channel), because it's the simplest free option.

## 3. The hardest bug: login was blocked on the live site

**What happened:** The first time I opened the dashboard in a real browser and signed in, I got **"Cross-origin request blocked."** All the automated tests were passing at that moment.

**What the AI got wrong:** It had added two security protections that were each fine on their own but broke login when used together:
- a check that rejects form posts coming from another website (it compares the `Origin` header), and
- a default security header (`Referrer-Policy: no-referrer`).

With that header, Chrome sends `Origin: null` even when the form is on the *same* site, so the first check rejected every real login. The tests didn't catch it because the test code (Node's `fetch`) doesn't send an `Origin` header at all, unlike a browser.

**How it was fixed:**
- The header was changed to `same-origin`.
- A new test was added that behaves like a browser: a same-site login must work, and a login from another site must be blocked.

That new test found a second bug. The health check said "ready" before the admin account had been created, so a login right after startup could fail. Now it only reports "ready" when startup has fully finished.

**Second real bug (the AI model):** Everything worked on Render, but every report card said *"AI unavailable – keyword triage used"*. The AI had chosen a Groq model (`llama-3.1-8b-instant`) that Groq has since retired. Its knowledge of model names was out of date. The bot's fallback kept working, so nothing looked broken. I only noticed because of the message on the card. We called Groq directly, got `404 model_not_found`, listed the models that exist today, tested `openai/gpt-oss-20b` with the real prompt, and made it the default.

**What I learned:** Passing tests aren't enough. Test in a real browser and with the real services, and don't trust an AI's memory of third-party details such as model names.

## 4. What I would add with more time

- Run more than one server instance safely, by moving the few things kept in memory (cooldowns, live-update events) into the database.
- Show a clear warning in the dashboard when the AI keeps failing, instead of relying on the footer text.
- An audit log of who changed which setting in the dashboard.
- Smarter AI: spot duplicate reports and let rules use the AI's tags.
- Alerts (for example to Slack) when an action fails permanently.

## 5. Prompt excerpt

My first message to Claude Code was the full assignment brief, followed by:

> "i have this assignment so build this, i have open abstrabity folder, make this assignment, and bata dena run kaise karna hai, make sure har step cover ho kuch break na ho"

(Translation: build this assignment in the open folder, tell me how to run it, cover every step and make sure nothing breaks.)
