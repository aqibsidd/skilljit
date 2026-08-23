export { UpstreamManager } from "./upstream.js";
export type { UpstreamSpec, ConnectFn } from "./upstream.js";
export { readMcpConfig, proposeConfig, diffConfigs } from "./config.js";
export type { McpClientConfig, McpServerEntry, ProposeOptions, ProposedConfig } from "./config.js";
export { runInit, runAdopt, runRestore, resolveManagedUpstreams, latestAdoption } from "./adopt.js";
export type { InitResult, AdoptionRecord, StateFile } from "./adopt.js";
export { runDoctor } from "./doctor.js";
export type { DoctorReport, DoctorEntry } from "./doctor.js";
