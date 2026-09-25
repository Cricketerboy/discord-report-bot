import { Router } from 'express';
import { config } from '../config.js';
import { exchangeOAuthCode, getGuild, installUrl } from '../discord/api.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { errorMessage } from '../lib/redact.js';
import { logger } from '../logger.js';
import { recordEvent } from '../services/events.js';
import { connectGuild } from '../services/guilds.js';
import { requireAuth, setOAuthState } from './auth.js';
import { syncCommands } from './dashboard.js';

const STATE_TTL_MS = 10 * 60_000;
const redirectUri = () => `${config.baseUrl}/connect/discord/callback`;

/**
 * "Add to Discord" flow. The OAuth2 code grant (with bot scope) proves the admin really installed the bot
 * into the guild: Discord returns the guild in the token response, so a guild_id in the query string
 * can't be forged to claim someone else's server.
 */
export function connectRouter(): Router {
  const r = Router();
  r.use('/connect', requireAuth);

  r.get('/connect/discord', async (req, res) => {
    const state = randomToken(24);
    await setOAuthState(req.session!, state);
    res.redirect(installUrl(state, redirectUri()));
  });

  r.get('/connect/discord/callback', async (req, res) => {
    const fail = (msg: string) => res.redirect(`/dashboard?err=${encodeURIComponent(msg)}`);
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const s = req.session!;

    if (error) return fail(`Discord authorization was cancelled (${error}).`);
    const stateOk =
      typeof state === 'string' &&
      s.oauthState &&
      safeEqual(state, s.oauthState) &&
      s.oauthStateAt &&
      Date.now() - new Date(s.oauthStateAt).getTime() < STATE_TTL_MS;
    await setOAuthState(s, null); // single use
    if (!stateOk) return fail('The connect link expired or was invalid. Please try again.');
    if (typeof code !== 'string' || !code) return fail('Discord did not return an authorization code.');

    let guild: { id: string; name: string; icon: string | null } | undefined;
    try {
      const token = await exchangeOAuthCode(code, redirectUri());
      guild = token.guild;
      if (!guild) return fail('No server was selected. Choose a server on the Discord screen.');
      // Confirm the bot actually has access to the guild now.
      guild = await getGuild(guild.id);
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, 'discord oauth exchange failed');
      return fail(`Discord connection failed: ${errorMessage(err)}`);
    }

    const { isNew } = await connectGuild(guild, s.adminId);
    await recordEvent({ guildId: guild.id, kind: 'guild.connected', message: `${isNew ? 'Connected' : 'Reconnected'} by ${s.email}` });

    let commandsMsg = 'Slash commands registered.';
    try {
      await syncCommands(guild.id);
    } catch (err) {
      commandsMsg = `Command registration failed (${errorMessage(err)}); retry from Settings.`;
    }
    res.redirect(`/dashboard/g/${guild.id}/settings?ok=${encodeURIComponent(`${guild.name} connected. ${commandsMsg} Now pick a report channel and a mirror webhook.`)}`);
  });

  return r;
}
