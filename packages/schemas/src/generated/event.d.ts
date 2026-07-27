/* Generated from canonical JSON Schema. Do not edit manually. */

export interface BPAExecutionEvent {
  event_id: string;
  run_id: string;
  node_execution_id?: string;
  sequence: number;
  type: string;
  occurred_at: string;
  payload: unknown;
}
