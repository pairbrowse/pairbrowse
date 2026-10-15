// Started in an SSH session (say, the desktop app's SSH sessions) means the browser runs on that
// machine, not the user's: its live view needs an SSH tunnel.
export const where = () => (process.env.SSH_CONNECTION ? "Server" : "Local");
