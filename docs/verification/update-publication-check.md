# Update publication completion

A CLI/plugin Release is not the stable update channel. Before reporting an update as available:

1. Publish verified immutable CLI, Template and Skill releases; record their exact tags, asset sizes and SHA-256 values.
2. Build a canonical stable manifest with a new monotonic sequence. releaseSet.cli/templates are versions; component tags retain their prefixes. Preserve approved template receipt anchors and the existing trusted signing root.
3. Run Node 24.16.0 with --import tsx/esm scripts/create-channel-envelope.mjs --manifest <payload.json> --key <external-key.pem> --output <stable.envelope.json>. The key stays outside the repository and CI; never rotate it to work around a failed check.
4. Supply the verified envelope as CHANNEL_ENVELOPE_B64 and run Publish Stable Channel with the exact release tags. Its gates bind every archive hash before immutable publication and Pages deployment.
5. GET the default https://chengcheng93.github.io/harness-mrtool/stable.envelope.json: require HTTP 200 and successfully verify its signature, sequence and intended versions. Confirm the marketplace ref points to the released source.
6. Test an isolated installation of the previously supported CLI against that default URL. Verify discovery, update, actual executable path/version and its read-only auth check. Updating Skill files alone does not replace the CLI.

Completion evidence must include the Release links, default channel verification, marketplace ref and old-to-new CLI result—not just uploaded ZIPs.
