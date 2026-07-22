/**
 * The Execution Backend interface.
 *
 * Every method is Promise-based (except the synchronous identity/metadata
 * accessors and the streaming generator). Implementations must express only
 * common concepts here; anything backend-specific goes in `backendMetadata`.
 */
import { BackendCapabilities } from "./capabilities.js";
import {
  BackendMetadata,
  CostEstimate,
  ExecutionProvenance,
  ExecutionRequest,
  ExecutionResult,
  HealthResult,
  ModelDescriptor,
  ResolveResult,
  StreamChunk,
} from "./types.js";

export interface ExecutionBackend {
  /** Stable backend id, e.g. "openrouter" | "vllm". */
  name(): string;
  version(): string;
  metadata(): BackendMetadata;

  /** Capabilities for the backend (optionally specialized to one model). */
  capabilities(model?: string): Promise<BackendCapabilities>;

  discoverModels(): Promise<ModelDescriptor[]>;
  resolveModel(requestedModel: string): Promise<ResolveResult>;

  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  /** Streaming execution. A minimal implementation may yield a single chunk. */
  stream(request: ExecutionRequest): AsyncIterable<StreamChunk>;

  estimateCost(request: ExecutionRequest, usage?: { promptTokens: number; completionTokens: number }): Promise<CostEstimate>;

  /** Fetch execution provenance for a prior generation, when supported. */
  provenance(generationId?: string): Promise<ExecutionProvenance | null>;

  health(): Promise<HealthResult>;
}
