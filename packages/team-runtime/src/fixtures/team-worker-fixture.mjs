const maximum = 1024 * 1024;
let buffered = Buffer.alloc(0);
const pending = new Map();

function send(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  process.stdout.write(frame);
}

function outcome(status, code) {
  return {
    status,
    error: {
      code,
      message: code,
      retryable: status !== "cancelled"
    },
    evidence: [],
    riskSignals: []
  };
}

function handle(message) {
  if (message.type === "hello") {
    if (process.env.TEAM_FIXTURE_MALFORMED === "1") {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(maximum + 1, 0);
      process.stdout.write(header);
      return;
    }
    send({
      type: "hello.ack",
      protocolVersion: "bpa.team/1",
      codeDigest:
        process.env.TEAM_FIXTURE_DIGEST_OVERRIDE ??
        message.expectedCodeDigest,
      handlers: JSON.parse(process.env.TEAM_FIXTURE_HANDLERS ?? "[]")
    });
    return;
  }
  if (message.type === "invoke") {
    if (message.requestId.includes("crash")) {
      process.exit(17);
    }
    if (message.requestId.includes("hang")) {
      pending.set(message.requestId, message);
      return;
    }
    send({
      type: "result",
      requestId: message.requestId,
      fencingToken: message.fencingToken,
      outcome: {
        status: "succeeded",
        output: { requestId: message.requestId },
        evidence: [],
        riskSignals: []
      }
    });
    return;
  }
  if (message.type === "cancel") {
    const invocation = pending.get(message.requestId);
    if (!invocation) return;
    pending.delete(message.requestId);
    send({
      type: "result",
      requestId: message.requestId,
      fencingToken: message.fencingToken,
      outcome: outcome("cancelled", "TEAM_HANDLER_CANCELLED")
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (length === 0 || length > maximum) process.exit(18);
    if (buffered.length < 4 + length) break;
    const message = JSON.parse(
      buffered.subarray(4, 4 + length).toString("utf8")
    );
    buffered = buffered.subarray(4 + length);
    handle(message);
  }
});
