# Update repair

`UPDATE_SECURITY_ERROR` means the local trust boundary or recovery evidence is
not complete. Do not delete individual cache, receipt, journal, or Skill files
while a transaction is pending.

1. Retry with `--offline` only when a verified last-known-good release exists.
2. Preserve the state directory and collect the JSON error document.
3. Run the platform repair workflow supplied with the signed release.
4. If no signed release is installed, reinstall from the fixed official asset
   and verify its SHA-256 before extraction.

Rollback is accepted only from a newer signed manifest sequence and an
identity-checked immutable release set. A lower or unsigned journal is left in
place and fails closed.
