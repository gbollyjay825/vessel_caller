# Static security scan policy

The security workflow installs Semgrep **1.180.0** in a separate virtual environment
under `RUNNER_TEMP`. It scans the repository root with the OWASP Top Ten ruleset:

```sh
semgrep scan --config p/owasp-top-ten --error --metrics=off .
```

Findings fail the job. Fatal scan errors and invalid rule configuration also fail
the job. Metrics are disabled. No path, language, or global rule exclusions are
added by this migration.

Dependabot version updates use a seven-day cooldown, matching the ruleset's
minimum age policy for newly published packages. This changes the normal GitHub
three-day default for routine version updates; security updates remain outside
the cooldown. See the [GitHub cooldown reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown).

## Why the deprecated action was replaced

The old `semgrep/semgrep-action@v1` wrapper invoked `semgrep ci`, mapped its
`config` input to `SEMGREP_RULES`, and bundled Semgrep 1.36.0. Its CI defaults
blocked findings but suppressed fatal scanner errors. A current registry rule
with severity `MEDIUM` crashed that old scanner while the action reported
success. The replacement uses the supported CLI and preserves finding failures
while making fatal scan failures visible.

The wrapper did not enable `--strict`. The replacement likewise leaves target
parser warnings nonblocking. On 2026-10-12, Semgrep reported limitations parsing
three valid Bash scripts, typed Vitest module-import calls, and JSX text containing
ampersands. Bash syntax/ShellCheck and TypeScript compiler checks passed. Parser
warnings remain in the scan output and should be reviewed when they change;
they must not be mistaken for complete analysis of the affected spans.

## Reviewed exceptions

Three exact-rule inline exceptions document false positives at their call sites:

- Audit CSV export escapes every dynamic string with `csv_safe`; its timestamp
  comes from a generated datetime.
- Both icon components select markup from fixed local SVG literals. They do not
  accept user-provided HTML.

Revisit those annotations if the input sources or sanitization change. The
historical Gitleaks exception in `.gitleaksignore` applies only to one
commit/file/rule/line fingerprint for a Python type alias containing no secret;
it does not exempt that path from future scans.

## Gate verification

An isolated CLI experiment with the same flags returned exit 0 for clean source,
exit 1 for a synthetic finding, and exit 2 for an invalid rule. This verifies that
omitting `--strict` does not suppress findings or fatal configuration failures.

The full repository scan on 2026-10-12 completed with exit 0 and zero findings
across 492 targets and 267 applicable rules. The 12 parser warnings described
above remained visible; they are an analysis limitation, not a security finding.

Primary references: [archived wrapper source](https://github.com/semgrep/semgrep-action/blob/713efdd345f3035192eaa63f56867b88e63e4e5d/src/semgrep_agent.py),
[bundled version](https://github.com/semgrep/semgrep-action/blob/713efdd345f3035192eaa63f56867b88e63e4e5d/Dockerfile),
[old CI defaults](https://github.com/semgrep/semgrep/blob/v1.36.0/cli/src/semgrep/commands/ci.py),
[old error handling](https://github.com/semgrep/semgrep/blob/v1.36.0/cli/src/semgrep/error_handler.py),
and [supported CLI flags and exit codes](https://docs.semgrep.dev/cli-reference).
