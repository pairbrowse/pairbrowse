// Your own endpoint: a JSON POST to the address saved in the urlSecret (an https address, or
// loopback http). Body: { event: "pairbrowse.turn" | "pairbrowse.reminder" | "pairbrowse.ended",
// id, kind (the step's kind), host, link (or null), expiresAt (ISO time), reason (or null) }.
import { secretFor } from "./channel.mjs";

const URL_RULE = { secret: true, required: true, address: true };

export default {
  type: "webhook",
  fields: { urlSecret: URL_RULE },
  create(channel, { secret, post }) {
    return {
      type: "webhook",
      describe: () => `webhook (${channel.urlSecret})`,
      async send(message) {
        const url = secretFor(secret, channel.urlSecret, URL_RULE);
        if (url.error) return { ok: false, error: url.error };
        const body = { event: `pairbrowse.${message.kind}`, id: message.id, kind: message.action, host: message.host,
          link: message.link ?? null, expiresAt: new Date(message.expiresAt).toISOString(), reason: message.reason ?? null };
        const r = await post(url.value, JSON.stringify(body), { headers: { "content-type": "application/json" } });
        return { ...r, link: !!message.link };
      },
    };
  },
};
