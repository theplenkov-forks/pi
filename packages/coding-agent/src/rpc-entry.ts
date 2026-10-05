#!/usr/bin/env node
import { setupRuntime } from "./cli/setup.ts";
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
setupRuntime();

main(["--mode", "rpc", ...process.argv.slice(2)]);
