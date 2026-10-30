# CLI read contract

`read-contract.json` contains 151 read, polling, diagnostic, error and simple-write
results captured from the TypeScript CLI immediately before its removal. Capture
also ran the Rust executable and compared its JSON, request paths, saved bytes,
exit status and error metadata against each result.

Only the disposable HTTPS origin is replaced with `$PROVIDER`; error message prose
is omitted because the contract specifies error codes/metadata, not exact wording.
Success JSON, request ordering, saved bytes and file modes remain fixed. The native
regression suite consumes every record, including interruption and TLS rejection.
Update expectations only for intentional reviewed contract changes; do not generate
them from the implementation under test merely to make a failing test pass.
