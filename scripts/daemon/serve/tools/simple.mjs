// The helper's own tools that hand over to one of its parts: sessions, remembered details, the
// live view, recording, invites, joining, and uploads.
import { appName } from "../../../join.mjs";
import { paths } from "../../../paths.mjs";
import { uploadFiles } from "../../../upload.mjs";

export function createSimpleTools(conn, api) {
  const { context, facts, follow, hud, myLabel, recorder, serverPage, sharing } = api;
  const { participant } = conn;
  return {
    pairbrowse_session: (args) => context.sessionCommand(args),
    pairbrowse_facts: (args) => facts.command(args),
    pairbrowse_liveview: () => sharing.liveViewCommand(),
    async pairbrowse_record(args) {
      await context.getContext();
      return recorder ? recorder.command(args) : { text: "Recording isn't available here.", error: true };
    },
    pairbrowse_invite: (args) => sharing.inviteCommand(args, { who: appName(conn.clientName) }),
    async pairbrowse_join(args) {
      const r = await follow.command(args, { owner: participant, app: conn.clientName });
      if (args?.action === "join" && !r.error) context.agentChose("An agent joined a shared session (pairbrowse_join).");
      return r;
    },
    async pairbrowse_upload(args) {
      const page = await serverPage();
      if (!page) return { text: "No page open to upload into.", error: true };
      const result = await uploadFiles(page, args, { uploadsDir: paths.uploads, activity: (text) => hud.addActivity(text, myLabel(), page) });
      return { text: result.text, error: !result.ok, url: page.url() };
    },
  };
}
