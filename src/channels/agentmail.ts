/**
 * AgentMail channel for NanoClaw.
 * Polls patbig_openclaw@agentmail.to and forwards emails from the allowed
 * sender to the main group as instructions.
 */
import { AgentMailClient } from 'agentmail';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';

const POLL_INTERVAL_MS = 60_000;
const INBOX_ID = 'patbig_openclaw@agentmail.to';

class AgentMailChannel implements Channel {
  name = 'agentmail';

  private client: AgentMailClient | null = null;
  private allowedSender = '';
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private consecutiveErrors = 0;
  private connected = false;

  private onMessage: (chatJid: string, msg: NewMessage) => void;
  private onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  private registeredGroups: () => Record<string, RegisteredGroup>;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(_jid: string): boolean {
    return false; // AgentMail dispatches to the main group JID, not its own
  }

  async connect(): Promise<void> {
    const env = readEnvFile(['MAILAGENT_API_KEY', 'GMAIL_ALLOWED_SENDER']);
    const apiKey = env.MAILAGENT_API_KEY;
    if (!apiKey) {
      logger.warn('AgentMail: MAILAGENT_API_KEY not set, channel disabled');
      return;
    }

    this.allowedSender = env.GMAIL_ALLOWED_SENDER || '';
    this.client = new AgentMailClient({ apiKey });
    this.connected = true;

    logger.info(
      { inbox: INBOX_ID, allowedSender: this.allowedSender || 'all' },
      'AgentMail channel connected',
    );

    this.schedulePoll();
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.client = null;
    this.connected = false;
    logger.info('AgentMail channel stopped');
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // AgentMail replies are per-thread — not used for outbound push
  }

  async replyToMessage(messageId: string, text: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.inboxes.messages.reply(INBOX_ID, messageId, {
        text,
      });
      logger.info({ messageId }, 'AgentMail reply sent');
    } catch (err) {
      logger.error({ err, messageId }, 'AgentMail reply failed');
    }
  }

  private schedulePoll(): void {
    const backoffMs =
      this.consecutiveErrors > 0
        ? Math.min(
            POLL_INTERVAL_MS * Math.pow(2, this.consecutiveErrors),
            30 * 60 * 1000,
          )
        : POLL_INTERVAL_MS;

    this.pollTimer = setTimeout(async () => {
      await this.pollForMessages();
      if (this.connected) this.schedulePoll();
    }, backoffMs);
  }

  private async pollForMessages(): Promise<void> {
    if (!this.client) return;

    try {
      const response = await this.client.inboxes.messages.list(INBOX_ID, {
        limit: 20,
      });

      for (const item of response.messages ?? []) {
        const messageId = item.messageId;
        if (!messageId || this.processedIds.has(messageId)) continue;
        this.processedIds.add(messageId);

        // Extract sender email from "Name <email>" or plain email
        const fromRaw = item.from ?? '';
        const senderEmail =
          typeof fromRaw === 'string'
            ? (fromRaw.match(/<(.+?)>$/)?.[1] ?? fromRaw).trim()
            : String(fromRaw);

        // Filter: only allowed sender triggers the agent
        if (this.allowedSender && senderEmail !== this.allowedSender) {
          logger.debug(
            { from: senderEmail, allowed: this.allowedSender },
            'AgentMail: skipping email from non-allowed sender',
          );
          continue;
        }

        // Fetch full message to get body text
        const full = await this.client.inboxes.messages.get(
          INBOX_ID,
          messageId,
        );
        const body = full.text ?? full.extractedText ?? full.preview ?? '';
        const subject = full.subject ?? '(no subject)';

        const ts =
          full.timestamp instanceof Date
            ? full.timestamp.toISOString()
            : String(full.timestamp);
        await this.dispatchToMain(senderEmail, subject, body, messageId, ts);
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      logger.error({ err }, 'AgentMail poll error');
    }
  }

  private async dispatchToMain(
    senderEmail: string,
    subject: string,
    body: string,
    messageId: string,
    timestamp: string,
  ): Promise<void> {
    const groups = this.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);
    if (!mainEntry) {
      logger.warn('AgentMail: no main group registered, skipping email');
      return;
    }
    const mainJid = mainEntry[0];

    const content = `[Email from ${senderEmail}]\nSujet: ${subject}\n\n${body}`;

    logger.info(
      { from: senderEmail, subject, mainJid },
      'AgentMail: dispatching email as instruction',
    );

    this.onChatMetadata(mainJid, timestamp, `Email (${senderEmail})`, 'agentmail', false);

    this.onMessage(mainJid, {
      id: messageId,
      chat_jid: mainJid,
      sender: `agentmail:${senderEmail}`,
      sender_name: senderEmail,
      content,
      timestamp,
      is_from_me: false,
    });
  }
}

registerChannel('agentmail', (opts) => {
  const env = readEnvFile(['MAILAGENT_API_KEY']);
  if (!env.MAILAGENT_API_KEY) return null;

  return new AgentMailChannel(opts);
});
