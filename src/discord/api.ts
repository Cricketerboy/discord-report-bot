import { config } from '../config.js';
import { request } from '../lib/http.js';
import type { MessageBody } from './types.js';

const base = config.DISCORD_API_BASE;
const botAuth = { authorization: `Bot ${config.DISCORD_BOT_TOKEN}` };

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  position?: number;
}
export interface DiscordRole {
  id: string;
  name: string;
  managed?: boolean;
  position?: number;
}

/** Edits the original interaction response (works for deferred replies and deferred component updates). */
export function editOriginalResponse(interactionToken: string, body: MessageBody): Promise<unknown> {
  return request(`${base}/webhooks/${config.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    json: body,
    label: 'discord.edit_original',
  });
}

/**
 * Posts to a channel as the bot. `nonce` + `enforce_nonce` makes Discord return the already-created
 * message if a retry repeats a request that actually succeeded (e.g. the response was lost to a timeout).
 */
export function createChannelMessage(channelId: string, body: MessageBody, nonce: string): Promise<{ id: string }> {
  return request<{ id: string }>(`${base}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: botAuth,
    json: { ...body, nonce: nonce.slice(0, 25), enforce_nonce: true },
    label: 'discord.create_message',
  });
}

export function editChannelMessage(channelId: string, messageId: string, body: MessageBody): Promise<unknown> {
  return request(`${base}/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: botAuth,
    json: body,
    label: 'discord.edit_message',
  });
}

export function overwriteGuildCommands(guildId: string, commands: unknown[]): Promise<unknown> {
  return request(`${base}/applications/${config.DISCORD_APPLICATION_ID}/guilds/${guildId}/commands`, {
    method: 'PUT',
    headers: botAuth,
    json: commands,
    label: 'discord.register_guild_commands',
  });
}

export function overwriteGlobalCommands(commands: unknown[]): Promise<unknown> {
  return request(`${base}/applications/${config.DISCORD_APPLICATION_ID}/commands`, {
    method: 'PUT',
    headers: botAuth,
    json: commands,
    label: 'discord.register_global_commands',
  });
}

export function getGuild(guildId: string): Promise<{ id: string; name: string; icon: string | null }> {
  return request(`${base}/guilds/${guildId}`, { headers: botAuth, label: 'discord.get_guild' });
}

export function getGuildChannels(guildId: string): Promise<DiscordChannel[]> {
  return request(`${base}/guilds/${guildId}/channels`, { headers: botAuth, label: 'discord.get_channels' });
}

export function getGuildRoles(guildId: string): Promise<DiscordRole[]> {
  return request(`${base}/guilds/${guildId}/roles`, { headers: botAuth, label: 'discord.get_roles' });
}

export function leaveGuild(guildId: string): Promise<unknown> {
  return request(`${base}/users/@me/guilds/${guildId}`, { method: 'DELETE', headers: botAuth, label: 'discord.leave_guild' });
}

export interface OAuthTokenResponse {
  access_token: string;
  guild?: { id: string; name: string; icon: string | null };
}

export function exchangeOAuthCode(code: string, redirectUri: string): Promise<OAuthTokenResponse> {
  const basic = Buffer.from(`${config.DISCORD_APPLICATION_ID}:${config.DISCORD_CLIENT_SECRET}`).toString('base64');
  return request<OAuthTokenResponse>(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}` },
    form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
    label: 'discord.oauth_exchange',
  });
}

// View Channel + Send Messages + Embed Links + Read Message History
export const BOT_PERMISSIONS = String((1 << 10) | (1 << 11) | (1 << 14) | (1 << 16));

export function installUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: config.DISCORD_APPLICATION_ID,
    scope: 'identify bot applications.commands',
    permissions: BOT_PERMISSIONS,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
