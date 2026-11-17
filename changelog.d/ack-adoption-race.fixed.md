- Confirmed explicit ACK adoption now cancels cleanup still waiting for the
  automatic add, including during shutdown. In-flight removals remain joinable,
  but cannot schedule automatic retries after adoption.
- Reaction tools distinguish ACK adoption from an unchanged existing reaction;
  deadline diagnostics include time waiting on background coordination.
