# bloxgen-cli

CLI tool for Bloxgen game development framework.

## Install

Add to your project's `rokit.toml`:

```toml
[tools]
bloxgen = "jedfgames/bloxgen-cli@0.1.0"
```

Then run `rokit install`.

## Usage

```bash
# Start the development dashboard
bloxgen dashboard

# Start on a custom port
bloxgen dashboard --port 8080

# Show version
bloxgen version
```

Run `bloxgen dashboard` from within a Bloxgen game project directory. The dashboard operates on the current working directory as the project root.
