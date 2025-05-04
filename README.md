# cf-fuse

## Running the Main Program

Build the project:

```sh
cargo build --release
```

Run the FUSE filesystem (default mountpoint is `./mnt`):

```sh
cargo run --release -- [--provider=memory|sqlite_simple|sqlite_chunked] [--mountpoint=PATH] [--chunk_size=SIZE] [--mode=osx]
```

- `--provider` (optional): Choose backend. Default is `memory`.
- `--mountpoint` (optional): Directory to mount. Default is `./mnt`.
- `--chunk_size` (optional): Only for `sqlite_chunked`. Default is 4096.
- `--mode=osx` (optional): Enable macOS-specific mode.

Example:

```sh
cargo run --release -- --provider=sqlite_simple --mountpoint=./mnt
```

Unmount with:

```sh
umount ./mnt
```

## Running the Stress Tests

The stress test runs for all providers and prints a summary table.

```sh
cargo test --test integration_stress -- --nocapture
```

- Requires `umount` command and `prettytable-rs` crate (should be in dependencies).
- The test will mount and unmount `./mnt` and create/remove test files.

---

For more options, see `src/main.rs` and `tests/integration_stress.rs`.
