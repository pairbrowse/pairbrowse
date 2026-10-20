// Discord: a channel webhook (Execute Webhook: POST the webhook's address, JSON) with content,
// embeds suppressed (flags SUPPRESS_EMBEDS, 1 << 2: no link preview) and no mentions parsed
// (allowed_mentions.parse empty). Discord and the channel's members see the message. A message over
// Discord's 2000 characters is refused, never cut (a cut link would still count as sent); message.mjs
// LINK_MAX keeps every message it accepts under that.
import { secretFor } from "./channel.mjs";

const URL_RULE = { secret: true, required: true, address: true };
const SUPPRESS_EMBEDS = 1 << 2;
const CONTENT_MAX = 2000;

export default {
  type: "discord",
  fields: { urlSecret: URL_RULE },
  create(channel, { secret, post, messageText }) {
    return {
      type: "discord",
      describe: () => `discord (${channel.urlSecret})`,
      async send(message) {
        const url = secretFor(secret, channel.urlSecret, URL_RULE);
        if (url.error) return { ok: false, error: url.error };
        const { title, text } = messageText(message);
        const content = `**${title}**\n${text}`;
        if (content.length > CONTENT_MAX) return { ok: false, error: "the message is over Discord's 2000 characters" };
        const body = { content, flags: SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } };
        const r = await post(url.value, JSON.stringify(body), { headers: { "content-type": "application/json" } });
        return { ...r, link: !!message.link };
      },
    };
  },
};
