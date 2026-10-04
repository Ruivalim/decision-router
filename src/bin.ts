#!/usr/bin/env node
import { exitQuietlyOnEpipe, main } from "./cli.ts";

exitQuietlyOnEpipe(process.stdout);
main(process.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
