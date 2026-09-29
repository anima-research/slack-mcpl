/**
 * Capability grant state (SPEC 0.5 §5.3, §5.4, §6.4, §6.7).
 *
 * The grant is the security boundary. This class holds what the *host* told
 * this connection it may do, and nothing else. The message-to-grant step, the
 * wildcard matching, and the §6.4 derivation all come from @animalabs/mcpl-core
 * (`grantFromUpdate`, `capabilityGranted`, `deriveFeatureSets`); this wrapper
 * adds the connection-lifetime state around them and the degradation receipt.
 *
 * - `effectiveCapabilities` is the sole normative allowlist. Every path not
 *   present is denied; absence is the denial, there is no unspecified state
 *   (§5.4).
 * - `deniedCapabilities` is derived diagnostic data. It is read only to detect
 *   a malformed policy message and never participates in an authorization
 *   decision (§5.4).
 * - Until the initial policy exchange completes, every capability-dependent
 *   behavior is unavailable (§5.3). `has()` therefore returns false before the
 *   first grant-bearing `featureSets/update` Request.
 *
 * Nothing here widens anything. The degradation receipt this produces is
 * testimony about consequences, never an assertion of entitlement (§6.7).
 *
 * Ported from zulip-mcp's src/grant.ts (protocol-generic; no Zulip-specific
 * logic) as part of the slack-mcpl MCPL 0.5 policy-handshake migration.
 */

import {
  capabilityGranted,
  deriveFeatureSets,
  emptyGrantState,
  featureSetSelected,
  grantFromUpdate,
  isCapabilityPath,
  type CapabilityGrantState,
  type FeatureSetDeclaration,
  type FeatureSetsUpdateParams,
  type UnavailableFeature,
} from '@animalabs/mcpl-core';
import { McplRpcError } from './errors.js';

/** SPEC §6.7 — the response to `featureSets/update` is a degradation receipt. */
export interface DegradationReceipt {
  accepted: true;
  mode: 'full' | 'degraded';
  unavailableFeatures: UnavailableFeature[];
  notes: string[];
}

export class CapabilityGrant {
  private state: CapabilityGrantState = emptyGrantState();
  private readyWaiters: (() => void)[] = [];

  constructor(private declarations: Record<string, FeatureSetDeclaration> = {}) {}

  /**
   * Point the grant at the feature-set declarations of a newly installed
   * manifest (§17.5). Declarations are what degradation is derived from
   * (§6.4); they are not authority, so this widens nothing — the effective
   * grant is untouched and stays whatever the host last sent.
   */
  setDeclarations(declarations: Record<string, FeatureSetDeclaration>): void {
    this.declarations = declarations;
  }

  /**
   * Forget the grant: a new connection starts from nothing (§5.3) — the
   * previous peer's policy is not this peer's. Waiters from the old
   * connection are dropped; their callers guard on the connection anyway.
   */
  reset(): void {
    this.state = emptyGrantState();
    this.readyWaiters = [];
  }

  /** True once a grant-bearing `featureSets/update` Request has been accepted. */
  isReady(): boolean {
    return this.state.ready;
  }

  /** Resolves the first time a policy is accepted. */
  whenReady(): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    return new Promise<void>((resolve) => this.readyWaiters.push(resolve));
  }

  /**
   * Is `path` in the effective grant? False before the initial policy
   * exchange, and false for any path the host did not name.
   */
  has(path: string): boolean {
    if (!this.state.ready) return false;
    return capabilityGranted(this.state.effectiveCapabilities, path);
  }

  /** Is a declared feature set currently active? */
  isFeatureSetActive(name: string): boolean {
    if (!this.state.ready) return false;
    if (!featureSetSelected(this.state, name)) return false;
    return this.missingFor(name).length === 0;
  }

  /** Capability paths a declared feature set needs but has not been granted. */
  missingFor(name: string): string[] {
    const decl = this.declarations[name];
    if (!decl) return [];
    return decl.uses.filter((use) => !this.has(use));
  }

  /**
   * Apply a `featureSets/update` and return the degradation receipt (§6.7).
   *
   * Throws {@link McplRpcError} when the message is malformed — §5.4 requires
   * the receiving side to fail closed and reject a policy naming a path in
   * both `effectiveCapabilities` and `deniedCapabilities`. Fail-closed means
   * exactly that: the grant that results holds nothing and is not ready, so a
   * malformed message cannot leave a previous, wider grant standing.
   *
   * `form` is how the message arrived. §6.7 requires the **Request** form for
   * any change to the effective grant and says a Notification "cannot
   * establish a ready state". A Notification therefore never alters the grant
   * except to apply `disabled` reductions — reductions are respected whatever
   * the carrier — and any other grant-bearing field it carries is discarded
   * with a note, because honouring a widening from an unacknowledgeable
   * message would have this server acting on a path the host cannot know it
   * accepted.
   */
  apply(
    params: FeatureSetsUpdateParams,
    form: 'request' | 'notification' = 'request',
  ): DegradationReceipt {
    const result = grantFromUpdate(this.state, params, form);
    const notes: string[] = [];

    if (result.malformed) {
      this.state = result.state;
      throw new McplRpcError(
        -32602,
        'Malformed policy: capability appears in both effectiveCapabilities and deniedCapabilities',
        { capabilities: result.conflicts },
      );
    }

    if (form === 'request' && params.effectiveCapabilities === undefined) {
      // §5.4: effectiveCapabilities is the sole allowlist. Absent means the
      // empty allowlist, not "unchanged" and not "everything".
      notes.push(
        'No effectiveCapabilities in featureSets/update; treating the grant as empty (SPEC 0.5 §5.4).',
      );
    }

    if (form === 'notification') {
      if (result.discarded.length > 0) {
        notes.push(
          `featureSets/update arrived as a Notification; ignored ${result.discarded.join(', ')} — ` +
            'a Notification cannot establish or alter the grant (SPEC 0.5 §6.7). Only `disabled` was applied.',
        );
      }
      if (!result.state.ready) {
        notes.push(
          'featureSets/update arrived as a Notification before the initial policy exchange; a Notification cannot establish a ready state (SPEC 0.5 §6.7), so no capability is in force.',
        );
      }
    }

    const unrecognized = (params.effectiveCapabilities ?? []).filter(
      (p) => typeof p === 'string' && !p.includes('*') && !isCapabilityPath(p),
    );
    if (form === 'request' && unrecognized.length > 0) {
      notes.push(`Ignoring capability paths outside the §6.2 vocabulary: ${unrecognized.join(', ')}`);
    }

    this.state = result.state;

    const derivation = deriveFeatureSets(this.declarations, this.state.effectiveCapabilities);
    const unavailableFeatures: UnavailableFeature[] = Object.entries(derivation.disabled).map(
      ([featureSet, why]) => ({
        featureSet,
        missingCapabilities: why.missingCapabilities as UnavailableFeature['missingCapabilities'],
        effect: 'disabled',
      }),
    );

    // §6.7: only the Request form can establish a ready state.
    if (this.state.ready) {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const resolve of waiters) resolve();
    }

    return {
      accepted: true,
      mode: unavailableFeatures.length > 0 ? 'degraded' : 'full',
      unavailableFeatures,
      notes,
    };
  }
}
