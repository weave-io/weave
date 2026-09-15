#!/usr/bin/env bun
import { run } from "./run.ts";

console.log(run(Bun.argv.slice(2)));
