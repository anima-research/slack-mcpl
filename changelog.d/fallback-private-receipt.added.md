- Latch private fallback-pin evidence as soon as a Slack event arrives, denying
  the history-fallback path even while earlier host delivery holds preparation
  back. The latch does not disable fresh metadata admission when channels:read
  is available. Ambient preparation waits for earlier addressed deliveries
  before checking subscription, not for every earlier ambient delivery;
  preparations may overlap and spend proof quota before their ordered delivery
  turns. Delivery separately rechecks subscription at its ordered turn.
- A failed in-flight proof rechecks latched private evidence before retry or
  propagation. Successful final history admission rechecks it synchronously at delivery
  commit; fresh metadata admission remains independent of that latch.
  Transient final-delivery fallback also rechecks it. A known private veto
  requires fresh successful metadata admission rather than the original verdict.
  Classified transient failures within the five-second wait may retain original
  admission only without a veto or withdrawn grant. Expiry of that wait drops
  the event and requests ACK cleanup even without a private veto; fresh write
  admission can refuse cleanup and leave the reaction visible.
