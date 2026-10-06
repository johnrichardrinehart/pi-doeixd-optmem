# pi-doeixd-optmem

A [pi](https://pi.dev) / [omp](https://omp.sh) extension for
[doeixd's OptMem](https://github.com/doeixd/OptMem), the fork of
[VictorTaelin/OptMem](https://github.com/VictorTaelin/OptMem) with one memory
store per project, a global store, per-session provenance tags, amend/retract,
and fuzzy/semantic recall.

The extension wakes memory at session start, injects it before the first
turn, and gives the agent an `optmem` tool. It does not bundle OptMem; it runs
the `memo` you install.

## Install

1. Install doeixd's OptMem (Python 3.7+):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/doeixd/OptMem/main/install.sh | sh
   ```

   This places `memo` at `~/.optmem/memo`. Optionally create the global store
   with `python3 ~/.optmem/memo init`; project stores are created on first use.

2. Install the extension:

   ```sh
   omp install git+https://github.com/johnrichardrinehart/pi-doeixd-optmem.git   # omp
   pi install git:github.com/johnrichardrinehart/pi-doeixd-optmem                 # pi
   ```

   Remove `pi-optmem` if installed; both register an `optmem` tool.

## Behavior

- **Scope.** Every call runs in the session's working directory, so OptMem
  selects the project store from the Git remote (or the path outside Git).
  `global: true` targets the shared store. Setting `MEMORY_DIR` forces a single
  store and disables project scoping.
- **Session tags.** Each session's entries are stamped with an 8-character tag
  derived from the pi/omp session id (SHA-256 prefix). An exported
  `OPTMEM_SESSION` takes precedence.
- **Startup.** `memo wake` output (global, then project) is injected as a
  hidden `optmem-wake` message. A `memo` older than 2.x, such as the original
  OptMem, is rejected with an install hint.
- **Interpreter.** `memo` runs as `python3 <memo>` (`python` on Windows), so
  the executable bit and shebang line endings do not matter.

## Tool actions

| Action        | Fields                                                           | `memo` command       |
| ------------- | ---------------------------------------------------------------- | -------------------- |
| `wake`        | `part`, `snapshot`                                               | `wake [part [T]]`    |
| `note`        | `text`, `fit`, `date`                                            | `note`               |
| `nap`         | none, or `block` + `text`                                        | `nap [lo-hi "line"]` |
| `recall`      | `query`, `mode` (`regex`/`fuzzy`/`semantic`), `limit`, `context` | `recall`             |
| `zoom`        | `block`, `depth`                                                 | `zoom`               |
| `show`        | `target`                                                         | `show`               |
| `amend`       | `target`, `text`, `fit`, `date`                                  | `amend`              |
| `retract`     | `target`, `text` (reason), `fit`, `date`                         | `retract`            |
| `resummarize` | `block`                                                          | `resummarize`        |
| `scope`       | none                                                             | `scope`              |

All actions except `scope` accept `global`. Destructive and administrative
commands (`redact`, `config`, `import`, `export`, `qmd`, `setup`, `upgrade`,
`uninstall`) are deliberately not exposed to the agent; run them yourself.

## Configuration

| Variable         | Effect                                                          |
| ---------------- | --------------------------------------------------------------- |
| `OPTMEM_MEMO`    | Path to `memo`; default `~/.optmem/memo`, then `memo` on `PATH` |
| `OPTMEM_PYTHON`  | Interpreter; default `python3` (`python` on Windows)            |
| `OPTMEM_SESSION` | Fixed session tag instead of the derived one                    |
| `MEMORY_DIR`     | Single store, bypassing project scoping                         |

## Nix

The flake follows
[nix-project-template](https://github.com/johnrichardrinehart/nix-project-template):
development inputs live in the `dev/` partition, so consumers fetch only
`nixpkgs` and `flake-parts`.

```console
nix build                      # extension directory at ./result
omp install "$(nix build --print-out-paths)"
nix flake check                # package transpile check + pre-commit hooks
nix fmt                        # treefmt policy
nix develop                    # bun, python3, nixd; installs Git hooks
```

## License

[0BSD](LICENSE). OptMem itself is a separate project with its own terms and is
not distributed here.
