# Third-party notices

The development dependency graph is installed from the exact versions pinned
in `package-lock.json`. Direct runtime dependencies currently include:

- `ajv`
- `commander`
- `fflate`
- `json-canonicalize`
- `jsonc-parser`
- `semver`
- `yaml`

The generated release archive must include the applicable license texts for
these packages and the Node.js runtime. The release workflow must regenerate
and verify this file from the lockfile before publishing an artifact; this
development notice does not claim that a signed release archive exists.
