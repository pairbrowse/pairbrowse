// Slack: an incoming webhook (POST the webhook's address, JSON) with text, unfurling off
// (unfurl_links and unfurl_media false: Slack doesn't fetch the link for a preview). &, < and >
// are escaped as Slack asks, so nothing in the text is read as a mention or a link of its own.
// Slack, the workspace's retention and the channel's members see the message.
import { secretFor } from "./channel.mjs";

const URL_RULE = { secret: true, required: true, address: true };
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default {
  type: "slack",
  fields: { urlSecret: URL_RULE },
  create(channel, { secret, post, messageText }) {
    return {
      type: "slack",
      describe: () => `slack (${channel.urlSecret})`,
      async send(message) {
        const url = secretFor(secret, channel.urlSecret, URL_RULE);
        if (url.error) return { ok: false, error: url.error };
        const { title, text } = messageText(message);
        const body = { text: escape(`${title}\n${text}`), unfurl_links: false, unfurl_media: false };
        const r = await post(url.value, JSON.stringify(body), { headers: { "content-type": "application/json" } });
        return { ...r, link: !!message.link };
      },
    };
  },
};
