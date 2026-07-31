import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  DEFAULT_BPA_EXTENSION_ID,
  assertNativeHostOrigin
} from "@bpa/gateway-core";
import {
  resolveDefaultBpaHome,
  resolveLocalIpcEndpoint
} from "@bpa/platform-runtime";
import {
  attachJsonFrameDecoder,
  encodeCoreFrame,
  encodeNativeFrame
} from "./framing.js";

const origin = process.argv.find((argument) =>
  argument.startsWith("chrome-extension://")
);
const extensionId =
  process.env.BPA_EXTENSION_ID ?? DEFAULT_BPA_EXTENSION_ID;

function fail(error: unknown): never {
  process.stderr.write(
    `[bpa-native-host] ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
  process.exit(1);
}

if (!origin) fail(new Error("Chrome did not provide an extension origin"));
try {
  assertNativeHostOrigin(origin, extensionId);
} catch (error) {
  fail(error);
}

const root = resolveDefaultBpaHome(
  process.env.BPA_HOME ? { bpaHome: process.env.BPA_HOME } : {}
);
const socketPath = resolveLocalIpcEndpoint(root, "core");
const socket = createConnection(socketPath);
const attachId = randomUUID();
let attached = false;
let chromeInputEnded = false;
const pending: unknown[] = [];

const forwardToCore = (message: unknown): void => {
  if (!attached) {
    pending.push(message);
    return;
  }
  socket.write(encodeCoreFrame(message));
};

attachJsonFrameDecoder(
  process.stdin,
  "LE",
  forwardToCore,
  (error) => fail(error)
);
attachJsonFrameDecoder(
  socket,
  "BE",
  (message) => {
    if (!attached) {
      const response = message as {
        id?: string;
        ok?: boolean;
        error?: { message?: string };
      };
      if (response.id !== attachId || response.ok !== true) {
        fail(
          new Error(
            response.error?.message ?? "Local Core rejected native attach"
          )
        );
      }
      attached = true;
      for (const queued of pending.splice(0)) {
        socket.write(encodeCoreFrame(queued));
      }
      return;
    }
    process.stdout.write(encodeNativeFrame(message));
  },
  (error) => fail(error)
);

socket.once("connect", () => {
  socket.write(
    encodeCoreFrame({
      id: attachId,
      method: "native.attach",
      params: { origin }
    })
  );
});
socket.once("error", (error) => fail(error));
socket.once("close", () => {
  if (chromeInputEnded) process.exit(0);
  fail(new Error("Local Core connection closed"));
});
process.stdin.once("end", () => {
  chromeInputEnded = true;
  socket.end();
});
