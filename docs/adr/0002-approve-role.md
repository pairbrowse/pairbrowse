# 2. Joiners can hold an approve role

- Status: Accepted
- Date: 2026-10-16 (commits 3f8c3e1, bf32ea5, 8bddd53); "Approve role for joiners" in the 0.16.0 notes of [CHANGELOG](../../CHANGELOG.md)

## Context

An agent's named final clicks (pay, delete, publish, send, submit) wait for a person. In a shared
browser session the person who can answer may be a joiner on another computer, while the host is
away. Until now joiners could only watch or drive, and the host was the single point that could
unblock the agent.

## Decision

- A third role, "approve", exists for shared browser join codes only (never an invite link or a
  follow code). It is a drive invite with `approve: true`, so every right and check a drive invite
  has stays as it is; `roleOf` names it.
- Making an approve code, or switching a code to it (`pairbrowse_invite` role "approve" or
  `set_role`), asks the host first; the Share card's third choice and Settings' "Can approve" take
  the host's own click.
- An approve joiner sees the host's agents' asks in their own browser (agent, button, the rule's
  reason, site; never the call or the page) and answers with a trusted pointer click only.
- Each joiner gets its own id per ask (an HMAC under a key that never leaves the host's helper).
  The role is read again at every answer, so revoking or switching back to drive ends it at once.
  The first answer wins, the host's or any approve joiner's.

## Consequences

- Shared sessions keep moving when the host is away, without giving joiners a way to approve for
  their own agents (those asks are never shared).
- Drive and watch joiners see only who is deciding.
- More surface on the joiner port; the security table has the row
  "A joiner answers your approval cards" ([security.md](../security.md)) and
  [sharing.md](../sharing.md) documents the role.

## In code

- `scripts/liveview/invites.mjs`: `roleOf`, `mayApprove`, `setRole`
- `scripts/liveview/approval-share.mjs`: `createApprovalShare`
- `scripts/daemon/approvals.mjs`: `createClickApprovals` (shareable asks, first answer wins)
- `scripts/liveview/routes/owner.mjs`: `invite` op "role"; `ui/approve/` (the approval card page)
