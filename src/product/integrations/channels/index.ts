import type { ChannelFactory } from '../../app/notifications.js';
import { slackChannelFactory } from './slack.js';

/** Outbound notification channels this build ships (Connection.provider → factory). Outbound only. */
export const CHANNELS: Record<string, ChannelFactory> = { slack: slackChannelFactory };
