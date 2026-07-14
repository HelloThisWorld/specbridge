/**
 * MCP server identity and protocol baseline.
 *
 * The implementation version tracks the SpecBridge release. The protocol
 * baseline is the stable MCP specification revision this server is written
 * and tested against; actual version negotiation is delegated entirely to
 * the official SDK (never hand-rolled here).
 */

export const MCP_SERVER_NAME = 'specbridge';
export const MCP_SERVER_VERSION = '0.6.1';
export const MCP_SERVER_TITLE = 'SpecBridge';

/** Pinned exact SDK dependency (see package.json; keep the two in sync). */
export const MCP_SDK_VERSION = '1.29.0';

/** Stable MCP specification revision this server targets. */
export const MCP_PROTOCOL_BASELINE = '2025-11-25';

/** Minimum Node.js major version required at runtime. */
export const REQUIRED_NODE_MAJOR = 20;
