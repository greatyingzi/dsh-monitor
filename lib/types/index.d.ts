/**
 * Type declarations for dsh-monitor.
 *
 * The plugin exports the standard Cordis plugin contract:
 * `{ name, inject, Config, apply }`. `Config` is a schemastery schema;
 * `apply(ctx, config)` registers the `monitor`, `monitor_list`, and
 * `monitor_stop` tools.
 */
import type { Context } from '@deepseek-ai/cordis';

export interface MonitorConfig {
  /** Cap on the model-facing wake-up message (UTF-8 bytes). */
  maxNoticeBytes?: number;
  /** Default poll interval for command sources (ms). */
  defaultPollIntervalMs?: number;
  /** Minimum ms between two deliveries of the same watcher. Default 5000. */
  minDeliveryIntervalMs?: number;
  /** Consecutive wakes without a user message before falling back to inject. Default 2. */
  maxConsecutiveWakes?: number;
  /** How long an injected notice may stay parked before re-offer. Default 30000. */
  parkedNoticeTimeoutMs?: number;
}

export declare const name: 'dsh-monitor';
export declare const inject: readonly ['tools', 'systemPrompt', 'agents', 'sessions'];
export declare const Config: import('@deepseek-ai/schemastery').Schema<MonitorConfig>;
export declare function apply(ctx: Context, config: MonitorConfig): void;
