# Upgrading loupe

## Upgrading a loupe config from before 0.8.0

### Rule options are gone: `[severity, {opts}]` → `severity`

0.8.0 removed the array form of a rule setting, and the options it carried
(`allowZero` among them — zero is always allowed now, as it was by default). A
rule may only be set to a severity, or to `{ "severity", "reason" }` to record why:

```diff
   "rules": {
-    "layout/margin-on-child": ["warn", { "except": ["Spacer"] }]
+    "layout/margin-on-child": "warn"
   }
```

A config still written the old way does not load. `loupe check` and
`loupe status` fail with `config error — rule options are no longer supported —
write "<rule>": "<severity>"`, naming the line to write. The hook does not block
the turn over it — it stands aside — so until the config is fixed **the gate
checks nothing**: it tells the user `loupe: skipped — config error: …` and, on a
write, hands the agent the same error as advisory context so it can offer the
rewrite. Run `loupe status` after upgrading to catch it before a session does.

### Baseline entries to re-record

Two rules' baseline keys changed, because the old ones moved under edits that
introduced nothing. An entry recorded under the old key no longer matches, so
the finding it accepted comes back as new. Run `loupe baseline` once after
upgrading (`loupe baseline --dry-run` first shows the `+N new` and `-N fixed`
pairs this produces) and commit the result.

- **`tokens/undelivered`** is a finding about the project, shown at its first
  token use. The key no longer names that file:
  `tokens/undelivered|src/a.css|tokens/undelivered:wp-theme` is now
  `tokens/undelivered|<project>|tokens/undelivered:wp-theme`.
- **`stylesheet/unparsed`** keys on postcss's reason alone (`Unclosed block`),
  without the `line:column` in front of it.
