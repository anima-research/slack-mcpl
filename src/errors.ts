/**
 * Typed JSON-RPC errors for MCPL handlers.
 *
 * SPEC 0.5 §6.6: rejection is diagnostics, not authorization. A handler that
 * cannot answer MUST return a JSON-RPC *error object* with a documented code —
 * never silence, and never a result carrying a failure flag. The error tells
 * the peer what happened; it grants nothing and negotiates nothing.
 *
 * Codes come from @animalabs/mcpl-core (App. A, §14.6):
 *   -32002 Capability denied — `data: { capability }`
 *   -32602 Invalid params
 */

import { ERR_CAPABILITY_DENIED } from '@animalabs/mcpl-core';

export class McplRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McplRpcError';
  }
}

/** §14.6 / §5.4 — the method requires a capability not in the effective grant. */
export function capabilityDenied(capability: string): McplRpcError {
  return new McplRpcError(ERR_CAPABILITY_DENIED, `Capability denied: ${capability}`, { capability });
}
