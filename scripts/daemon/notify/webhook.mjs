// Your own endpoint: a JSON POST to the address saved in the urlSecret (an https address, or
// loopback http). Body: { event: "pairbrowse.turn" | "pairbrowse.reminder" | "pairbrowse.ended",
// id, kind (the step's kind), host, link (or null), expiresAt (ISO time), reason (or null), and
// privateOnly: true when the link works only on the private route (the public one didn't start) }; for a
// proxy's exit (message.mjs "network"): { event: "pairbrowse.network", network, change, paused, at
// (ISO time) }; for the Handoff page's kinds (message.mjs HANDOFF_KINDS): { event:
// "pairbrowse.<kind>", and that kind's own fields (an approval's expiresAt as an ISO time) }.
import { secretFor } from "./channel.mjs";
import { HANDOFF_KINDS } from "./message.mjs";

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
        const own = HANDOFF_KINDS.includes(message.kind);
        const body = own
          ? { event: `pairbrowse.${message.kind}`, ...Object.fromEntries(Object.entries(message).filter(([k]) => k !== "kind")), ...(message.expiresAt ? { expiresAt: new Date(message.expiresAt).toISOString() } : {}) }
          : message.kind === "network"
          ? { event: "pairbrowse.network", network: message.network, change: message.change, paused: message.paused, at: new Date(message.at).toISOString() }
          : { event: `pairbrowse.${message.kind}`, id: message.id, kind: message.action, host: message.host,
            link: message.link ?? null, expiresAt: new Date(message.expiresAt).toISOString(), reason: message.reason ?? null, ...(message.privateOnly === true ? { privateOnly: true } : {}), ...(message.watch ? { watch: message.watch } : {}) };
        const r = await post(url.value, JSON.stringify(body), { headers: { "content-type": "application/json" } });
        return { ...r, link: !!message.link };
      },
    };
  },
};
