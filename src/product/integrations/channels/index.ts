import type { ChannelFactory } from '../../app/notifications';
import { slackChannelFactory } from './slack';

/** Outbound notification channels this build ships (Connection.provider → factory). Outbound only. */
export const CHANNELS: Record<string, ChannelFactory> = { slack: slackChannelFactory };
