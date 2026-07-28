#!/usr/bin/env node
import { userInfo } from "node:os";
import {
  ControlClient,
  resolveControlSocketPath,
  UnixSocketControlTransport
} from "@bpa/control-client";
import { createCliProgram } from "./program.js";

await createCliProgram({
  client: new ControlClient(
    new UnixSocketControlTransport(resolveControlSocketPath())
  ),
  actor: userInfo().username
})
  .version("0.3.0", "--cli-version", "show CLI version")
  .parseAsync();
