# Provider state and recovery

A visible transcript is not all of the state needed to continue a conversation.
Reasoning and compaction items can carry provider/account-bound `encrypted_content`.
Deleting that field while retaining the item ID can leave a stored response that
the server cannot replay, including the Rustponses persisted-response error.

Before converting or merging histories, synchronization preserves these opaque
items in the **private history repository**, under
`data/provider-state/<provider-hash>/<thread-id>.json`. These files use Git LFS,
like the original transcripts. They contain encrypted history, never login
credentials. Keep the directory when syncing to another device.

State is restored only to the matching Provider, by exact item type and ID.
Existing ciphertext is never overwritten; conflicting versions are retained and
not guessed between. The same Provider name does not make ciphertext portable
between unrelated accounts. Imported transcripts on another Provider may remain
viewable without supporting continuation of that Provider's opaque compactions.

Running Homes export snapshots but receive no history replacements. Writer-locked
threads protect all their physical rollouts, even if SQLite points at a stale
rollout. Windows byte-range locks are checked again before replacing a file.
Failed atomic replacement never deletes the destination as a fallback.

## Recover a previously damaged conversation

Stop the target client. Use its configured Home name and actual thread ID:

```powershell
node bin/repair-provider-state.mjs --home codex --thread <uuid> --from-git
node bin/repair-provider-state.mjs --home codex --thread <uuid> --from-git --apply
```

Repeat `--thread` for multiple conversations. The first command audits only.
The second extracts exact original state from locally available Git LFS history,
verifies object checksums, saves the provider-state files, backs up changed
rollouts and the history projection database, then invalidates only the affected
thread projections. It preserves chat text, tool records, IDs, timestamps and
ordinals. No model request is sent. Missing LFS objects and remaining incomplete
compactions are reported; this command does not guess or recreate encrypted state.

If the client is still running, `--apply` can save recovered Provider state to the
private repository, but defers all Home changes and returns exit code 2. It never
closes a client or removes its writer locks. Run it again after exiting the client,
then restart and verify by actually sending a message. A successful offline repair
does not itself prove that the upstream Responses service accepted continuation.

Commit the new `data/provider-state` files with the private history repository's
identity. Never commit them to the public or internal framework repository.
