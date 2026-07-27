import { z } from "zod";

export const EXPERIMENTAL_PROTOCOL = "bpa-bridge-experiment/0" as const;

const id = z.string().min(1).max(200);

export const capabilitySchema = z.object({
  nodeId: id,
  versions: z.array(id).min(1),
  risk: z.enum(["read", "reversible_write", "irreversible_write"])
});

export const commandSchema = z.object({
  commandSeq: z.number().int().positive(),
  nodeExecutionId: id,
  idempotencyKey: id,
  node: z.object({
    id: id,
    version: id
  }),
  input: z.unknown(),
  leaseMs: z.number().int().min(1_000).max(300_000)
});

export const resultStatusSchema = z.enum([
  "succeeded",
  "rejected",
  "failed",
  "timed_out",
  "cancelled",
  "uncertain"
]);

const baseEnvelope = z.object({
  protocol: z.literal(EXPERIMENTAL_PROTOCOL),
  messageId: id,
  sentAt: z.number().int().nonnegative(),
  type: id
});

export const bridgeHelloSchema = baseEnvelope.extend({
  type: z.literal("bridge.hello"),
  payload: z.object({
    browserInstanceId: id,
    pairingToken: id,
    extensionVersion: id,
    lastAckedCommandSeq: z.number().int().nonnegative(),
    capabilities: z.array(capabilitySchema),
    pendingResults: z.array(
      z.object({
        commandSeq: z.number().int().positive(),
        nodeExecutionId: id,
        idempotencyKey: id,
        status: resultStatusSchema,
        output: z.unknown().optional(),
        error: z.string().optional()
      })
    )
  })
});

export const gatewayWelcomeSchema = baseEnvelope.extend({
  type: z.literal("gateway.welcome"),
  payload: z.object({
    sessionId: id,
    heartbeatMs: z.number().int().min(1_000),
    resumed: z.boolean()
  })
});

export const gatewayCommandSchema = baseEnvelope.extend({
  type: z.literal("gateway.command"),
  payload: commandSchema
});

export const bridgeCommandAckSchema = baseEnvelope.extend({
  type: z.literal("bridge.command_ack"),
  payload: z.object({
    commandSeq: z.number().int().positive(),
    nodeExecutionId: id,
    accepted: z.boolean(),
    reason: z.string().optional()
  })
});

export const bridgeCommandResultSchema = baseEnvelope.extend({
  type: z.literal("bridge.command_result"),
  payload: z.object({
    commandSeq: z.number().int().positive(),
    nodeExecutionId: id,
    idempotencyKey: id,
    status: resultStatusSchema,
    output: z.unknown().optional(),
    error: z.string().optional()
  })
});

export const gatewayResultAckSchema = baseEnvelope.extend({
  type: z.literal("gateway.result_ack"),
  payload: z.object({
    commandSeq: z.number().int().positive(),
    nodeExecutionId: id
  })
});

export const heartbeatSchema = baseEnvelope.extend({
  type: z.enum(["bridge.heartbeat", "gateway.heartbeat_ack"]),
  payload: z.object({
    nonce: id
  })
});

export const sessionErrorSchema = baseEnvelope.extend({
  type: z.literal("session.error"),
  payload: z.object({
    code: z.enum([
      "INVALID_MESSAGE",
      "PAIRING_REJECTED",
      "DUPLICATE_BROWSER",
      "CAPABILITY_MISSING",
      "SESSION_NOT_READY"
    ]),
    message: z.string()
  })
});

export const experimentalMessageSchema = z.discriminatedUnion("type", [
  bridgeHelloSchema,
  gatewayWelcomeSchema,
  gatewayCommandSchema,
  bridgeCommandAckSchema,
  bridgeCommandResultSchema,
  gatewayResultAckSchema,
  heartbeatSchema,
  sessionErrorSchema
]);

export type Capability = z.infer<typeof capabilitySchema>;
export type Command = z.infer<typeof commandSchema>;
export type ResultStatus = z.infer<typeof resultStatusSchema>;
export type ExperimentalMessage = z.infer<typeof experimentalMessageSchema>;
export type BridgeHello = z.infer<typeof bridgeHelloSchema>;
export type GatewayCommand = z.infer<typeof gatewayCommandSchema>;
export type BridgeCommandResult = z.infer<typeof bridgeCommandResultSchema>;

let nextMessageNumber = 0;

export function envelope<TType extends ExperimentalMessage["type"], TPayload>(
  type: TType,
  payload: TPayload
): {
  protocol: typeof EXPERIMENTAL_PROTOCOL;
  messageId: string;
  sentAt: number;
  type: TType;
  payload: TPayload;
} {
  nextMessageNumber += 1;
  return {
    protocol: EXPERIMENTAL_PROTOCOL,
    messageId: `msg_${Date.now()}_${nextMessageNumber}`,
    sentAt: Date.now(),
    type,
    payload
  };
}
