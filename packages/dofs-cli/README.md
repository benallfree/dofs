# DOFS CLI

A command line interface for the Distributed Object File System (DOFS).

## Installation

```bash
go build -o dofs-cli
```

## Usage

### Mount Command

```bash
./dofs-cli mount
```

This command currently outputs "hello world" as a placeholder.

### Help

```bash
./dofs-cli --help
./dofs-cli mount --help
```

## Development

Run without building:
```bash
go run main.go mount
```

Build the binary:
```bash
go build -o dofs-cli
``` 