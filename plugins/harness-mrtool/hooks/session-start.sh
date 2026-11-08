#!/bin/sh
# A trusted SessionStart hook: no prompts, downloads, persistence, or MR actions.
set -u
emit_context() {
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$1"
}
missing='Harness MR GitLab initialization has not completed. Before reporting this plugin ready or preparing an MR, install the matching CLI and safely configure a host-bound api-scope token in the environment, then run harness-mrtool auth check --output json. Do not put tokens in arguments, files, or chat. This hook does not create an MR.'
failed='Harness MR could not verify GitLab API authorization or connectivity. Do not report the plugin ready. Run harness-mrtool auth check --output json and follow its safe setup instructions. No credential or MR write was attempted by this hook.'
passed='Harness MR read-only GitLab API initialization check passed for the configured host. This does not authorize creating an MR. Continue to follow the user request and recheck target-project access when using the CLI.'
executable=${HARNESS_MRTOOL_EXECUTABLE:-}
if [ -z "$executable" ]; then
  executable=$(command -v harness-mrtool 2>/dev/null || true)
fi
if [ -z "$executable" ]; then
  executable="${XDG_DATA_HOME:-$HOME/Library/Application Support}/harness-mrtool/harness-mrtool"
fi
if [ ! -f "$executable" ] || [ ! -x "$executable" ] ||
   [ -z "${HARNESS_MRTOOL_GITLAB_HOST:-}" ] || [ -z "${HARNESS_MRTOOL_GITLAB_TOKEN:-}" ]; then
  emit_context "$missing"
  exit 0
fi
# Perl and JSON::PP are part of the existing native macOS runtime prerequisites.
if ! command -v perl >/dev/null 2>&1; then
  emit_context "$failed"
  exit 0
fi
result=$(cd / && "$executable" auth check --output json 2>/dev/null)
check_status=$?
if [ "$check_status" -eq 0 ] && printf '%s' "$result" | perl -MJSON::PP -e '
  local $/; my $r = eval { decode_json(<STDIN>) };
  exit 1 unless ref($r) eq "HASH" && $r->{ok} && $r->{code} eq "OK";
  my $d=$r->{data};
  exit 1 unless ref($d) eq "HASH" && $d->{command} eq "auth.check" && $d->{authenticated};
  my $s=$d->{apiScope};
  exit 1 unless ref($s) eq "HASH" && $s->{status} eq "verified" && ref($s->{scopes}) eq "ARRAY" && grep { $_ eq "api" } @{$s->{scopes}};
  exit 1 unless ref($r->{remoteWrite}) eq "HASH" && $r->{remoteWrite}{state} eq "not-attempted";
  exit 0;
' >/dev/null 2>&1; then
  emit_context "$passed"
else
  emit_context "$failed"
fi
exit 0
