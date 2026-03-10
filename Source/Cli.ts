// bloxgen-cli — CLI tool for Bloxgen game development framework.
// Built with Bun and distributed as a single binary via Rokit.

import { startDashboard } from "./Dashboard";

const HELP_TEXT = `
bloxgen-cli

CLI tool for Bloxgen game development framework.

[Usage] bloxgen <command> [options]

Commands
  dashboard    Start the Bloxgen web dashboard
  help         Show this help message
  version      Show the version

Dashboard Options
  --port <n>   Port to listen on (default 7377)

Examples
  bloxgen dashboard
  bloxgen dashboard --port 8080
`.trim();

function getVersion(): string {
    return "0.0.0";
}

function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === "help" || command === "--help" || command === "-h") {
        console.log(HELP_TEXT);
        process.exit(0);
    }

    if (command === "version" || command === "--version" || command === "-v") {
        console.log(getVersion());
        process.exit(0);
    }

    if (command === "dashboard") {
        let port = 7377;
        const portIndex = args.indexOf("--port");
        if (portIndex !== -1 && args[portIndex + 1]) {
            port = parseInt(args[portIndex + 1], 10);
            if (isNaN(port) || port < 1 || port > 65535) {
                console.error("Invalid port number.");
                process.exit(1);
            }
        }
        startDashboard(port);
        return;
    }

    console.error(`Unknown command "${command}". Run "bloxgen help" for usage.`);
    process.exit(1);
}

main();
