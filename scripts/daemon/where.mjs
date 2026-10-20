// Where the browser runs, for the live view's links and the session's place: "Server" once the
// supervisor marked this helper as one (browser/supervise.mjs, in server mode: spec server-mode
// A11), or when it was started in an SSH session (say, the desktop app's SSH sessions): the browser
// runs on that machine, not the user's, and its live view needs a private route (SSH or a tailnet).
let server = false;
export const markServer = () => { server = true; };
export const where = () => (server || process.env.SSH_CONNECTION ? "Server" : "Local");
