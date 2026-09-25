import type { ProviderId } from '../../types.js';
import { ProviderUnavailableError } from '../types.js';

/** The provider rejected the credential (401/403): the connection needs reconnecting. */
export class ConnectorAuthError extends ProviderUnavailableError {
  constructor(provider: ProviderId, detail: string) {
    super(provider, 'error', detail);
    this.name = 'ConnectorAuthError';
  }
}

/** The provider asked us to slow down (429). Retry after `retryAfterSeconds` when known. */
export class ConnectorRateLimited extends ProviderUnavailableError {
  constructor(provider: ProviderId, detail: string, readonly retryAfterSeconds?: number) {
    super(provider, 'unavailable', detail);
    this.name = 'ConnectorRateLimited';
  }
}

/** The connection's configuration or credential is not usable by this connector. Never retried. */
export class ConnectorConfigError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ConnectorConfigError';
  }
}
