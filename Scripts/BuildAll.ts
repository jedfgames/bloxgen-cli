// Build bloxgen-cli binaries for all platforms supported by Rokit.

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";

const BUILD_DIR = path.join(import.meta.dir, "..", "Build");

const TARGETS: { target: string; output: string }[] = [
    {
        target: "bun-darwin-arm64",
        output: "bloxgen-macos-aarch64",
    },
    {
        target: "bun-darwin-x64",
        output: "bloxgen-macos-x86_64",
    },
    {
        target: "bun-linux-arm64",
        output: "bloxgen-linux-aarch64",
    },
    {
        target: "bun-linux-x64",
        output: "bloxgen-linux-x86_64",
    },
    {
        target: "bun-windows-x64",
        output: "bloxgen-windows-x86_64.exe",
    },
];

async function buildAll() {
    fs.mkdirSync(BUILD_DIR, { recursive: true });

    for (const { target, output } of TARGETS) {
        const outPath = path.join(BUILD_DIR, output);
        console.log(`Building ${output}...`);
        try {
            await $`bun build Source/Cli.ts --compile --target=${target} --outfile ${outPath}`;
            console.log(`  Built ${output}`);
        } catch (err) {
            console.error(`  Failed to build ${output}: ${err}`);
        }
    }

    console.log("Done.");
}

buildAll();
