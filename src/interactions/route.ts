import express, { Router } from 'express';
import { config } from '../config.js';
import { publicKeyFromHex, verifyDiscordRequest } from '../discord/verify.js';
import { InteractionType, type Interaction } from '../discord/types.js';
import { ephemeral } from '../discord/messages.js';
import { Deadline } from '../lib/http.js';
import { errorMessage } from '../lib/redact.js';
import { logger } from '../logger.js';
import { recordRejectedRequest } from '../services/security.js';
import { handleInteraction, type InteractionResponse } from './handler.js';
import { recordResponseMeta } from './ingest.js';

// Everything we do before answering must fit in this, leaving headroom for network time.
const RESPONSE_BUDGET_MS = 2300;

function looksLikeInteraction(v: unknown): v is Interaction {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    /^\d{15,25}$/.test(o.id) &&
    typeof o.type === 'number' &&
    typeof o.token === 'string' &&
    typeof o.application_id === 'string'
  );
}

export function interactionsRouter(): Router {
  const router = Router();
  const publicKey = publicKeyFromHex(config.DISCORD_PUBLIC_KEY);

  // Raw body is required: the signature covers the exact bytes Discord sent.
  router.post('/interactions', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
    const started = Date.now();
    const deadline = new Deadline(RESPONSE_BUDGET_MS);
    const ip = req.ip ?? 'unknown';

    const check = verifyDiscordRequest({
      signature: req.get('x-signature-ed25519'),
      timestamp: req.get('x-signature-timestamp'),
      rawBody: Buffer.isBuffer(req.body) ? req.body : undefined,
      publicKey,
    });
    if (!check.ok) {
      recordRejectedRequest(check.reason, ip);
      res.status(401).json({ error: 'invalid request signature' });
      return;
    }

    let interaction: unknown;
    try {
      interaction = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      recordRejectedRequest('malformed_json', ip);
      res.status(400).json({ error: 'malformed body' });
      return;
    }
    if (!looksLikeInteraction(interaction) || interaction.application_id !== config.DISCORD_APPLICATION_ID) {
      recordRejectedRequest('unexpected_payload', ip);
      res.status(400).json({ error: 'unexpected payload' });
      return;
    }

    let response: InteractionResponse;
    try {
      response = await handleInteraction(interaction, deadline);
    } catch (err) {
      logger.error({ interactionId: interaction.id, err: errorMessage(err) }, 'interaction handler crashed');
      response = ephemeral('Something went wrong on our side. Please try again in a moment.');
    }
    res.json(response);

    const ms = Date.now() - started;
    logger.info(
      { interactionId: interaction.id, type: interaction.type, command: interaction.data?.name ?? interaction.data?.custom_id, responseType: response.type, ms },
      'interaction answered',
    );
    if (interaction.type !== InteractionType.PING) void recordResponseMeta(interaction.id, response.type, ms);
  });

  return router;
}
