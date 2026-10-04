#!/usr/bin/env node
/**
 * The executable.
 *
 * The exit code comes from main() and is assigned explicitly. A process that
 * prints a report and then exits 0 is worse than one that prints nothing, because
 * a pipeline that watches the exit code reports success while the tool found
 * problems.
 */
import { main } from './index.js';

process.exitCode = await main(process.argv.slice(2));