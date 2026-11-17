- Disabled-tool guidance distinguishes a message's own ID from its thread parent,
  avoids unavailable read, lookup and rollback retry tools, and names the setting
  and valid tool names when configuration is refused.
- Keep inbound messaging available without the tools capability when all messaging
  tools are disabled, even if tools in other feature sets remain enabled.
