// ntfy: the text POSTed to <server>/<topic> (the topic's name is a secret: on a public server
// anyone who knows it reads the topic), with X-Title, X-Priority (4 for a step, 3 for an end),
// X-Tags, X-Click (the link, when sent) and a bearer token when tokenSecret names one. link:
// "auto" (default) leaves the link out on https://ntfy.sh without a token (a public topic, and the
// first tap wins: B7), "always" sends it, "never" never does; without it the message says to take
// over in the live view, and the status result tells the agent so.
import { fieldOf, secretFor } from "./channel.mjs";
import { urlOrigin } from "../../util.mjs";

const PUBLIC = "https://ntfy.sh";
// ntfy's topic names: letters, digits, "-" and "_", up to 64.
const TOPIC_RULE = { secret: true, required: true, pattern: /^[A-Za-z0-9_-]{1,64}$/, what: "a topic name (letters, digits, - and _, up to 64)" };
const TOKEN_RULE = { secret: true, pattern: /^[\x21-\x7e]{1,256}$/, what: "an access token (one word)" };
const FIELDS = {
  server: { address: true, default: PUBLIC },
  topicSecret: TOPIC_RULE,
  tokenSecret: TOKEN_RULE,
  link: { values: ["auto", "always", "never"], default: "auto" },
};

// Whether this channel leaves the link out.
export const ntfyWithholds = (channel) => {
  const link = fieldOf(channel, FIELDS, "link");
  return link === "never" || (link === "auto" && !channel.tokenSecret && urlOrigin(fieldOf(channel, FIELDS, "server")) === PUBLIC);
};

export default {
  type: "ntfy",
  fields: FIELDS,
  create(channel, { secret, post, messageText }) {
    const server = String(fieldOf(channel, FIELDS, "server")).replace(/\/+$/, "");
    const withheld = ntfyWithholds(channel);
    return {
      type: "ntfy",
      describe: () => `ntfy on ${urlOrigin(server, "its server")} (${channel.topicSecret})${withheld ? ", without the link" : ""}`,
      async send(message) {
        const topic = secretFor(secret, channel.topicSecret, TOPIC_RULE);
        if (topic.error) return { ok: false, error: topic.error };
        const headers = { "content-type": "text/plain; charset=utf-8", "x-priority": message.kind === "ended" ? "3" : "4", "x-tags": "pairbrowse" };
        if (channel.tokenSecret) {
          const token = secretFor(secret, channel.tokenSecret, TOKEN_RULE);
          if (token.error) return { ok: false, error: token.error };
          headers.authorization = `Bearer ${token.value}`;
        }
        const linked = !!message.link && !withheld;
        if (linked) headers["x-click"] = message.link;
        const { title, text } = messageText(message, { withheld: withheld && !!message.link });
        headers["x-title"] = title;
        const r = await post(`${server}/${topic.value}`, text, { headers });
        return { ...r, link: linked };
      },
    };
  },
};
